'use strict';
/*
 * Everything that makes sound: the warm-up, the answer to a run, `announce` from Home Assistant,
 * `play(stream)` for the host, and the ducking that goes with them. One Player (one pacat on the
 * tts sink) carries all of it. The satellite decides what incoming audio is (answer or announce);
 * this class plays it.
 */
const { Player } = require('./player');
const { Converter, SINK, wavToSink } = require('./pcm');
const duck = require('./duck');
const { AWAKE } = require('./power');
const fs = require('fs');

function loadSound(what, src, log) {
  if (!src) return null;
  try {
    const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
    return wavToSink(buf);
  } catch (e) {
    log('warn', what + ' not loaded: ' + e.message);
    return null;
  }
}

// Reads an async iterable (a stream on Node 10+, a generator) or, on Node 8, a readable stream: next() resolves the
// next chunk or null at the end; close() ends the iteration early, as leaving a `for await` loop would.
function chunkReader(source) {
  const sym = typeof Symbol.asyncIterator === 'symbol' ? Symbol.asyncIterator : null;
  if (sym && source && typeof source[sym] === 'function') {
    const it = source[sym]();
    let done = false;
    return {
      next: () => it.next().then((r) => { done = r.done; return r.done ? null : r.value; }),
      close: () => (!done && typeof it.return === 'function' ? Promise.resolve(it.return()).then(() => {}) : Promise.resolve()),
    };
  }
  return { next: () => nextChunk(source), close: () => Promise.resolve() };
}

// The next chunk of a readable stream, or null at its end. Stands in for `for await` on Node 8.
function nextChunk(stream) {
  return new Promise((resolve, reject) => {
    const c = stream.read();
    if (c !== null) return resolve(c);
    const state = stream._readableState;
    if (state && state.ended && !state.length) return resolve(null);
    const done = () => { stream.removeListener('readable', onReadable); stream.removeListener('end', onEnd); stream.removeListener('error', onError); };
    const onReadable = () => { done(); resolve(nextChunk(stream)); };
    const onEnd = () => { done(); resolve(null); };
    const onError = (e) => { done(); reject(e); };
    stream.once('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

class Playback {
  // host: { opts, luna, log, emit(name, payload) }
  constructor(host) {
    this.host = host;
    const o = host.opts;
    this.log = host.log;
    this.player = new Player({
      pacat: o.pacat, sink: o.sink, leadMs: o.playLeadMs, holdMs: o.holdMs, log: host.log,
      onLost: (why) => this.sinkLost(why),
    });
    this.wake = null;          // { token, timer, t0 }
    this.token = 0;
    this.rx = null;            // the audio being received from HA
    this.wakeSound = null;
    this.doneSound = null;
    this.duckLevel = null;     // the level that was applied (null: not applied / not wanted)
    this.duckSetting = false;
    this.guard = null;
  }

  start() {
    this.stopped = false;
    const o = this.host.opts;
    this.wakeSound = loadSound('wakeSound', o.wakeSound, this.log);
    this.doneSound = loadSound('doneSound', o.doneSound, this.log);
    this.guard = new duck.DuckGuard({
      luna: this.host.luna, log: this.log, apps: o.duckApps || [],
      level: () => this.duckLevel, busy: () => this.duckSetting || this.speaking(),
      pollMs: o.duckPollMs, afterMs: o.duckAfterMs, waitMs: o.duckWaitMs, minMs: o.duckMinMs,
    });
    this.setDuckLevel(o.duckLevel);
  }

  stop() {
    this.stopped = true;
    this.endWarm('stopped', false);
    this.abortRx('stopped');
    if (this.guard) this.guard.stop();
    this.player.close();
  }

  // ---- ducking ----

  setDuckLevel(level, cb) {
    cb = cb || (() => {});
    if (level === null || level === undefined) return cb(null);
    if (duck.validLevel(level) === null) {
      this.log('warn', 'duckLevel must be 0-100, got ' + level);
      return cb(new Error('invalid duck level'));
    }
    this.duckSetting = true;
    duck.setGlobal(this.host.luna, level, (err, value) => {
      this.duckSetting = false;
      if (value !== undefined && value !== null) { this.duckLevel = value; if (!this.stopped) this.guard.start(); }
      if (err) this.log('warn', 'duck level: ' + err.message);
      cb(err);
    });
  }

  // True while HA audio or a played stream is going out (a luna call then could glitch it).
  speaking() {
    return this.player.holders > 0 || this.player.pendingMarks > 0 || this.player.queuedMs > 0;
  }

  // ---- warm-up ----

  // Resolves { started: true } or { started: false, reason }.
  warmUp(o = {}) {
    const host = this.host.opts;
    if (this.wake) {   // already warming: the limit moves and the wake sound plays again
      this.armWarmTimer(this.wake, o.maxSeconds);
      if (o.wakeSound !== false && this.wakeSound && this.player.isOpen) this.player.enqueue(this.wakeSound);
      return Promise.resolve({ started: true, already: true });
    }
    const w = this.wake = { token: ++this.token, timer: null, t0: Date.now(), over: false };
    this.armWarmTimer(w, o.maxSeconds);
    return new Promise((resolve) => {
      this.host.luna.call('com.webos.service.tvpower/power/getPowerState', {}, (err, r) => {
        if (this.wake !== w) return resolve({ started: false, reason: 'stopped' });
        const state = r && r.state;
        if (err || !AWAKE[state]) {
          this.endWarm(err ? 'luna: ' + err.message : 'tv-off', false);
          return resolve({ started: false, reason: err ? err.message : 'tv-off' });
        }
        const late = Date.now() - w.t0;
        if (o.wakeSound !== false && this.wakeSound) {
          if (late <= host.wakeSoundMaxDelayMs) this.player.enqueue(this.wakeSound);   // opens the sink with the sound first
          else this.log('info', 'no wake sound: the warm-up started ' + late + ' ms after the call');
        }
        this.player.setWarm(true);
        if (!this.player.isOpen) {
          this.endWarm('sink-lost', false);
          return resolve({ started: false, reason: 'sink-lost' });
        }
        if (this.guard) this.guard.check('warm-up');
        this.host.emit('warm-up-start', { maxSeconds: w.maxSeconds });
        resolve({ started: true });
      });
    });
  }

  armWarmTimer(w, maxSeconds) {
    const cap = this.host.opts.warmUpMaxSeconds;
    const s = Number(maxSeconds);
    const seconds = Math.min(Number.isFinite(s) && s > 0 ? s : cap, cap);
    w.maxSeconds = seconds;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.endWarm('timeout', false), seconds * 1000);
  }

  // Ends the warm-up: the done sound (if asked) is written into the same stream, then the stream
  // closes after the hold time. Returns false when there is no warm-up.
  stopWarmUp(o = {}) {
    if (!this.wake) return false;
    this.endWarm('stopped', !!o.done);
    return true;
  }

  endWarm(reason, done) {
    const w = this.wake;
    if (!w) return;
    this.wake = null;
    clearTimeout(w.timer);
    const started = this.player.warm;
    if (done && this.doneSound && started && this.player.isOpen) {
      this.player.enqueue(this.doneSound);
      this.player.mark(() => {});
    }
    this.player.setWarm(false);
    if (started) this.host.emit('warm-up-stop', { reason });
  }

  sinkLost(why) {
    this.endWarm('sink-lost', false);
    this.host.emit('sink-lost', { reason: why });
  }

  // ---- audio from Home Assistant ----

  // kind: 'tts' | 'announce'; info.cancelled: this announce cancelled a running pipeline.
  beginRx(conn, kind, format, info = {}) {
    this.abortRx('replaced');
    let conv;
    try { conv = new Converter(format); } catch (e) {
      this.log('warn', 'cannot play ' + kind + ' audio: ' + e.message);
      conv = null;
    }
    const rx = this.rx = { conn, kind, format, conv, info, bytes: 0, aborted: false };
    this.player.hold();
    this.player.open();
    this.host.emit(kind === 'tts' ? 'tts-start' : 'announce-start', Object.assign({}, info.event));
    return rx;
  }

  chunkRx(data, payload) {
    const rx = this.rx;
    if (!rx || !payload || !payload.length) return;
    if (!rx.conv) return;
    const f = rx.format;
    if ((data.rate && data.rate !== f.rate) || (data.channels && data.channels !== f.channels) || (data.width && data.width !== f.width)) {
      try { rx.conv = new Converter({ rate: data.rate || f.rate, width: data.width || f.width, channels: data.channels || f.channels }); rx.format = data; } catch (e) { rx.conv = null; return; }
    }
    if (this.player.queuedMs > this.host.opts.maxQueueSeconds * 1000) {
      this.log('warn', 'audio from Home Assistant is queued more than ' + this.host.opts.maxQueueSeconds + ' s ahead, dropping the rest');
      rx.conv = null;
      return;
    }
    this.player.enqueue(rx.conv.push(payload));
  }

  // The end of the audio: `played` goes to HA when it has been heard. `after(ok)` runs then.
  endRx(after) {
    const rx = this.rx;
    if (!rx) return;
    this.rx = null;
    if (rx.kind === 'tts') this.host.emit('tts-end', {});
    this.player.release();
    this.player.mark((ok) => {
      if (rx.aborted) return;
      this.host.sendPlayed(rx.conn);
      this.host.emit('played', { kind: rx.kind, ok });
      if (rx.kind === 'announce') this.host.emit('announce-end', { ok });
      after(rx, ok);
    });
  }

  // Drops what is being received (connection gone, replaced by a newer stream, stop).
  abortRx(reason) {
    const rx = this.rx;
    if (!rx) return;
    this.rx = null;
    rx.aborted = true;
    this.player.release();
    this.log('info', 'incoming ' + rx.kind + ' audio abandoned: ' + reason);
  }

  // Silence the queue too (the connection that sent it is gone).
  abortAll(reason) {
    this.abortRx(reason);
    this.player.flush();
  }

  // ---- play(stream) for the host ----

  async play(stream, o = {}) {
    const signal = o.signal;
    if (signal && signal.aborted) return { ok: false, aborted: true };
    const conv = new Converter(o.format || SINK);
    const max = this.host.opts.maxQueueSeconds * 1000;
    const player = this.player;
    const tag = {};
    let aborted = false;
    let finish;
    const result = new Promise((resolve) => { finish = resolve; });
    const onAbort = () => {
      aborted = true;
      player.dropTag(tag);
      finish({ ok: false, aborted: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    player.hold();
    try {
      player.open();
      if (Buffer.isBuffer(stream)) player.enqueue(conv.push(stream), tag);
      else {
        // Node 8 on webOS 5 cannot parse `for await` (Node 10+), so the iteration is written out.
        const reader = chunkReader(stream);
        try {
          for (let chunk = await reader.next(); chunk !== null; chunk = await reader.next()) {
            if (aborted) break;
            while (player.queuedMs > max && !aborted) await new Promise((r) => setTimeout(r, 50));
            if (aborted) break;
            player.enqueue(conv.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)), tag);
          }
        } finally {
          await reader.close();
        }
      }
    } finally {
      player.release();
    }
    if (!aborted) player.mark((ok) => { if (!aborted) finish({ ok }); }, tag);
    try { return await result; } finally { if (signal) signal.removeEventListener('abort', onAbort); }
  }
}

module.exports = { Playback };
