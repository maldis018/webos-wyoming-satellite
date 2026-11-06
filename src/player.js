'use strict';
/*
 * One continuous player on the tts sink.
 *
 * A single `pacat` process stays open from the start of a warm-up until the end of the last sound,
 * so the sink never goes idle in between (the programme stays ducked, and an ARC path to a sound
 * bar does not drop out). The stream is made of silence, queued audio and sounds, in that order of
 * preference, and every byte comes from here:
 *
 * - The silence is paced in this process. Piping /dev/zero would let pacat read ahead until its
 *   pipe is full (about 0.7 s), which delays everything written after it.
 * - The pump keeps `leadMs` of audio written ahead of the play clock and no more, so queued audio
 *   starts at most `leadMs` after it was queued.
 * - The play clock is the wall time since the stream opened (pacat consumes in real time); if the
 *   process stalls past the end of what was written, the clock is moved forward (an underrun).
 *   A mark (`mark(cb)`) calls back when the clock reaches the end of the audio before it.
 *
 * Input is raw s16le, mono, 44100 Hz (see pcm.js).
 */
const { spawn } = require('child_process');
const { SINK } = require('./pcm');

// Bytes queued for writing. `writableLength` is Node 9.4+; webOS 5 runs Node 8, which only has the internal state.
function backlog(w) {
  return w.writableLength !== undefined ? w.writableLength : (w._writableState ? w._writableState.length : 0);
}

const BYTES_PER_MS = SINK.rate * 2 / 1000;     // 88.2
const STEP_MS = 10;
const STEP_BYTES = SINK.rate / 1000 * STEP_MS * 2;
const PACAT_LATENCY_MS = 30;                    // matches --latency-msec below
const MAX_STDIN_BACKLOG = 1024 * 1024;

class Player {
  constructor(opts = {}) {
    this.pacat = opts.pacat || '/usr/bin/pacat';
    this.sink = opts.sink || 'ptts';
    this.leadMs = opts.leadMs === undefined ? 120 : opts.leadMs;
    this.holdMs = opts.holdMs === undefined ? 350 : opts.holdMs;
    this.log = opts.log || (() => {});
    this.onLost = opts.onLost || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.proc = null;
    this.timer = null;
    this.queue = [];          // { buf } | { mark }
    this.warm = false;
    this.holders = 0;         // streams still being received into the queue
    this.pendingMarks = 0;    // marks whose time has not come
    this.markTimers = new Set();
    this.idleSince = null;
    this.t0 = 0;
    this.written = 0;         // bytes written to pacat
    this.spawned = 0;
  }

  get isOpen() { return !!this.proc; }

  // Bytes of audio (not silence) waiting in the queue, as milliseconds.
  get queuedMs() {
    let n = 0;
    for (const e of this.queue) if (e.buf) n += e.buf.length;
    return n / BYTES_PER_MS;
  }

  open() {
    if (this.proc) return true;
    let proc;
    try {
      proc = spawn(this.pacat, ['--playback', '-d', this.sink, '--raw', '--format=s16le',
        '--rate=' + SINK.rate, '--channels=1', '--latency-msec=' + PACAT_LATENCY_MS],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      this.log('error', 'cannot start ' + this.pacat + ': ' + e.message);
      return false;
    }
    this.proc = proc;
    this.spawned++;
    this.t0 = Date.now();
    this.written = 0;
    this.idleSince = null;
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => this.lost(proc, e.message));
    proc.on('close', (code) => this.lost(proc, err.trim() || 'pacat exited with ' + code));
    this.timer = setInterval(() => this.pump(), STEP_MS);
    this.pump();
    this.onOpen();
    return true;
  }

  lost(proc, why) {
    if (this.proc !== proc) return;
    this.teardown();
    this.log('warn', 'tts sink lost: ' + why);
    this.dropQueue(false);
    this.onLost(why);
  }

  teardown() {
    const proc = this.proc;
    this.proc = null;
    clearInterval(this.timer);
    this.timer = null;
    if (proc) {
      try { proc.stdin.destroy(); } catch (e) { /* gone */ }
      try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
    }
  }

  // Closes the sink at once; queued audio and marks are dropped (marks call back with false).
  close() {
    this.warm = false;
    this.teardown();
    this.dropQueue(false);
  }

  dropQueue(ok) {
    const q = this.queue;
    this.queue = [];
    for (const e of q) if (e.mark) e.mark(ok);
    for (const t of this.markTimers) { clearTimeout(t.timer); t.cb(ok); }
    this.markTimers.clear();
    this.pendingMarks = 0;
  }

  // Audio waiting in the queue is dropped (marks call back with false); the sink stays as it is.
  flush() { this.dropQueue(false); }

  // Removes the queued audio and marks with this tag (marks call back with false). Audio already written stays.
  dropTag(tag) {
    const keep = [];
    for (const e of this.queue) {
      if (e.tag !== tag) keep.push(e);
      else if (e.mark) { this.pendingMarks--; e.mark(false); }
    }
    this.queue = keep;
  }

  setWarm(on) {
    this.warm = !!on;
    if (on) this.open();
    else if (this.proc) this.idleSince = this.idleSince === null ? Date.now() : this.idleSince;
  }

  hold() { this.holders++; this.idleSince = null; }
  release() { this.holders = Math.max(0, this.holders - 1); }

  // `tag` (any object) lets dropTag() remove this audio again.
  enqueue(buf, tag) {
    if (!buf || !buf.length) return;
    this.queue.push({ buf: buf.length & 1 ? buf.slice(0, buf.length - 1) : buf, tag });   // queued first: a sink that opens now starts with it
    if (!this.open()) this.dropQueue(false);
  }

  // cb(true) when the audio queued so far has been played, cb(false) when it was dropped.
  mark(cb, tag) {
    this.queue.push({ mark: cb, tag });
    this.pendingMarks++;
    if (!this.open()) this.dropQueue(false);
  }

  nextFrame() {
    const parts = [];
    let need = STEP_BYTES;
    while (need > 0 && this.queue.length) {
      const head = this.queue[0];
      if (head.mark) {
        if (parts.length) break;       // the mark comes after the audio written so far
        this.queue.shift();
        this.fireMark(head.mark);
        continue;
      }
      if (head.buf.length <= need) { parts.push(head.buf); need -= head.buf.length; this.queue.shift(); }
      else { parts.push(head.buf.slice(0, need)); head.buf = head.buf.slice(need); need = 0; }
    }
    if (parts.length) return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    return Buffer.alloc(STEP_BYTES);   // silence
  }

  fireMark(cb) {
    const at = this.t0 + this.written / BYTES_PER_MS + PACAT_LATENCY_MS;
    const entry = { cb, timer: null };
    entry.timer = setTimeout(() => {
      this.markTimers.delete(entry);
      this.pendingMarks--;
      cb(true);
    }, Math.max(0, at - Date.now()));
    this.markTimers.add(entry);
  }

  pump() {
    const proc = this.proc;
    if (!proc) return;
    let elapsed = Date.now() - this.t0;
    const writtenMs = () => this.written / BYTES_PER_MS;
    if (elapsed > writtenMs()) { this.t0 += elapsed - writtenMs(); elapsed = writtenMs(); }   // underrun
    while (this.proc === proc && writtenMs() - elapsed < this.leadMs) {
      if (backlog(proc.stdin) > MAX_STDIN_BACKLOG) break;
      const frame = this.nextFrame();
      this.written += frame.length;
      proc.stdin.write(frame);
    }
    if (this.proc !== proc) return;
    const busy = this.warm || this.holders > 0 || this.pendingMarks > 0 || this.queue.length > 0;
    if (busy) { this.idleSince = null; return; }
    if (this.idleSince === null) this.idleSince = Date.now();
    if (Date.now() - this.idleSince >= this.holdMs) this.close();
  }
}

module.exports = { Player, BYTES_PER_MS };
