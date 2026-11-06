'use strict';
const net = require('net');
const { EventEmitter } = require('events');
const { encode, Parser } = require('./wyoming');
const { createLuna } = require('./luna');
const { Mic } = require('./mic');
const { Playback } = require('./playback');
const pkg = require('../package.json');

// Bytes queued for writing. `writableLength` is Node 9.4+; webOS 5 runs Node 8, which only has the internal state.
function backlog(w) {
  return w.writableLength !== undefined ? w.writableLength : (w._writableState ? w._writableState.length : 0);
}

const MIC_FORMAT = { rate: 16000, width: 2, channels: 1 };
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
// Mic audio is S16 mono at 16 kHz: 32 bytes are 1 ms.
const BYTES_PER_MS = 32;
// Audio that arrives after a transcript without a `synthesize` yet is either the (streamed) answer or an announce that
// cancelled the pipeline; HA sends `synthesize` right after the first streamed audio at the latest, so wait this long for it.
const CLASSIFY_MS = 300;

function normalizeAddress(a) {
  return String(a || '').replace(/^::ffff:/i, '');
}

class Satellite extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      port: 10700,
      host: '0.0.0.0',
      allowedHosts: [],
      name: 'webOS TV',
      startMic: true,
      alwaysListen: false,
      area: null,
      maxRunSeconds: 15,
      chunkBytes: 2048,
      pacat: '/usr/bin/pacat',
      sink: 'ptts',
      playLeadMs: 120,
      holdMs: 350,
      wakeSound: null,
      doneSound: null,
      wakeSoundMaxDelayMs: 500,
      duckLevel: null,
      duckApps: [],
      warmUpMaxSeconds: 15,
      answerTimeoutSeconds: 10,
      maxQueueSeconds: 120,
      ...opts,
    };
    this.log = (level, msg) => (opts.log || defaultLog)(level, msg);
    this.allowed = new Set((this.opts.allowedHosts || []).map(normalizeAddress));
    this.luna = createLuna({ lunaSend: opts.lunaSend });
    this.mic = new Mic({
      luna: this.luna,
      log: (m) => this.log('info', m),
      source: opts.micSource,
      busName: opts.voiceBusName,
      channel: opts.micChannel,
      gainDb: opts.micGainDb,
      bufferSeconds: opts.bufferSeconds,
      pollMs: opts.micPollMs,
      restartMs: opts.micRestartMs,
      keepAliveMs: opts.micKeepAliveMs,
      onChange: (s) => {
        if (!s.on) { this.endRun('mic-lost', { tell: false }); this.endListening('mic-lost'); } else this.maybeListen();
        this.emit('mic-status', s);
      },
    });
    this.playback = new Playback({
      opts: this.opts, luna: this.luna, log: (l, m) => this.log(l, m),
      emit: (name, payload) => this.emit(name, payload),
      sendPlayed: (conn) => this.write(conn, 'played'),
    });
    this.pipeline = null;   // a run's pipeline in HA that may still answer: { transcript, text, timer }
    this.server = null;
    this.conns = new Set();
    this.owner = null;      // the connection that ran `run-satellite`
    this.paused = false;
    this.hold = null;       // audio-start waiting to be told apart as answer or announce: { conn, d, events, timer }
    this.run = null;        // { conn, unfollow, timer, pending, sent }
    this.listening = null;  // alwaysListen: { conn, unfollow, pending, sentBytes }, the continuous stream for the wake word in HA
  }

  get port() { return this.server ? this.server.address().port : this.opts.port; }

  // Replaces the list of allowed IP addresses (see `allowedHosts`) while running, for example after resolving a name.
  setAllowedHosts(list) {
    this.allowed = new Set((list || []).map(normalizeAddress));
  }

  // Listens, warns about an open port, starts the microphone.
  start() {
    if (this.allowed.size === 0) {
      const msg = 'allowedHosts is empty: any device on the network can connect and open the microphone';
      this.log('warn', msg);
      this.emit('warning', { message: msg });
    }
    this.server = net.createServer((sock) => this.accept(sock));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.removeListener('error', reject);
        this.server.on('error', (e) => this.fail(e));
        this.log('info', 'listening on ' + this.opts.host + ':' + this.port);
        if (this.opts.startMic) this.mic.start();
        this.playback.start();
        resolve();
      });
    });
  }

  async stop() {
    this.endRun('stopped', { tell: false });
    this.endListening('stopped');
    this.disarm();
    this.dropHold();
    this.playback.stop();
    this.mic.stop();
    for (const c of this.conns) c.sock.destroy();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => s.close(r));
    }
  }

  // ---- commands from the host ----

  startRun() {
    if (!this.owner) return { started: false, reason: 'not-connected' };
    if (this.paused) return { started: false, reason: 'paused' };
    if (this.run || this.listening) return { started: false, reason: 'run-active' };
    if (!this.mic.status().on) return { started: false, reason: 'mic-off' };
    const buffer = this.mic.take();
    const run = this.openStream('run', 'asr', false, buffer);
    run.timer = setTimeout(() => this.endRun('timeout'), this.opts.maxRunSeconds * 1000);
    this.arm();
    this.emit('run-start', { bufferMs: Math.round(buffer.length / BYTES_PER_MS) });
    return { started: true };
  }

  stopRun() {
    if (!this.run) return false;
    this.endRun('stopped');
    return true;
  }

  // Silence on the tts sink that ducks the programme, ahead of an answer. Resolves { started: true } or
  // { started: false, reason }. Opts: maxSeconds (capped by warmUpMaxSeconds), wakeSound (false = none).
  warmUp(o) { return this.playback.warmUp(o); }

  // Ends the warm-up (opts.done: write the done sound first). Returns false when none was running.
  stopWarmUp(o) { return this.playback.stopWarmUp(o); }

  // Plays a Buffer or a readable stream of raw audio (opts.format: { rate, width: 2, channels }, default
  // 44100 Hz mono) on the same sink. Resolves { ok } when it has been heard. opts.signal (AbortSignal): aborting drops
  // this play's queued audio (other audio is untouched), stops reading the stream and resolves { ok: false, aborted: true }.
  // What is already written to the sink (about playLeadMs) still sounds.
  play(stream, o) { return this.playback.play(stream, o); }

  // Opens (true) or closes (false) the microphone; a running run ends with 'mic-lost'. With startMic: false this is the
  // only way the mic opens (call it after start()).
  setMic(on) {
    if (on) this.mic.start(); else this.mic.stop();
  }

  // Calls fn(Buffer) with the processed microphone audio (S16 LE, 16 kHz, mono) until the returned function is called.
  followMic(fn) { return this.mic.follow(fn); }

  clearMic() { this.mic.clear(); }

  micStatus() { return this.mic.status(); }

  // true / false: the TV is awake (the mic may run) by the last power poll; null when unknown.
  micAwake() { return this.mic.awake(); }

  // Live settings: micChannel, micGainDb, bufferSeconds.
  configure(o) {
    this.mic.configure({ channel: o.micChannel, gainDb: o.micGainDb, bufferSeconds: o.bufferSeconds });
    if (o.duckLevel !== undefined) this.playback.setDuckLevel(o.duckLevel);
  }

  status() {
    return {
      listening: !!this.server, wakeStream: !!this.listening, connected: !!this.owner, paused: this.paused, running: !!this.run, mic: this.mic.status(),
      warm: !!this.playback.wake, playing: this.playback.speaking(), duckLevel: this.playback.duckLevel,
    };
  }

  // ---- connections ----

  accept(sock) {
    const address = normalizeAddress(sock.remoteAddress);
    if (this.allowed.size && !this.allowed.has(address)) {
      this.log('warn', 'refused connection from ' + address + ' (not in allowedHosts)');
      this.emit('refused', { address });
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    const conn = { sock, address };
    this.conns.add(conn);
    const parser = new Parser((ev) => this.onEvent(conn, ev));
    sock.on('data', (b) => {
      try { parser.push(b); } catch (e) {
        this.log('warn', 'dropping connection from ' + address + ': ' + e.message);
        sock.destroy();
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.closed(conn));
  }

  // Ends everything tied to the satellite connection: the run, the wake stream (`tell`: audio-stop to HA), the wait for an
  // answer and the audio being played.
  release(reason, { runReason = reason, tell = false } = {}) {
    this.endRun(runReason, { tell: false });
    this.endListening(reason, { tell });
    this.disarm();
    this.dropHold();
    this.playback.abortAll(reason);
  }

  closed(conn) {
    this.conns.delete(conn);
    if (this.owner !== conn) return;
    this.release('disconnected');
    this.owner = null;
    this.paused = false;
    this.emit('disconnected', { address: conn.address, reason: 'closed' });
  }

  write(conn, type, data, payload) {
    if (conn.sock.destroyed) return;
    conn.sock.write(encode(type, data, payload));
  }

  onEvent(conn, ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'describe': return this.write(conn, 'info', this.info());
      case 'ping': return this.write(conn, 'pong', d.text === undefined ? {} : { text: d.text });
      case 'run-satellite': return this.claim(conn);
      default: break;
    }
    if (this.owner !== conn) return; // only the satellite connection drives anything else
    switch (ev.type) {
      case 'pause-satellite':
        if (!this.paused) {
          this.paused = true;
          this.release('paused', { tell: true });
          this.emit('paused', {});
        }
        break;
      case 'transcribe': this.emit('stt-start', { language: d.language }); break;
      case 'detection':
        if (this.listening) { this.emit('wake', { name: d.name }); this.playback.warmUp(); }
        break;
      case 'transcript':
        if (this.listening && !this.pipeline) this.arm();
        this.emit('stt-stop', { text: d.text === undefined ? '' : d.text });
        if (this.pipeline) { this.pipeline.transcript = true; this.pipeline.heard = d.text === undefined ? '' : d.text; }
        this.endRun('transcript', { tell: false });
        this.arm();
        break;
      case 'synthesize':
        if (this.pipeline) { this.pipeline.text = d.text === undefined ? '' : d.text; this.pipeline.voice = d.voice; this.arm(); }
        if (this.hold) this.resolveHold();
        break;
      case 'audio-start': this.audioStart(conn, d); break;
      case 'audio-chunk': if (this.hold) this.hold.events.push(ev); else this.playback.chunkRx(d, ev.payload); break;
      case 'audio-stop': if (this.hold) this.hold.events.push(ev); else this.audioStop(); break;
      case 'voice-started': this.emit('voice-start', d); break;
      case 'voice-stopped': this.emit('voice-stop', d); break;
      case 'error':
        this.emit('pipeline-error', { text: d.text, code: d.code });
        this.endRun('error', { tell: false, error: { text: d.text, code: d.code } });
        this.disarm();
        if (this.listening) { this.playback.stopWarmUp(); this.resend(); }
        break;
      default: break; // unknown or not yet handled events are ignored, as HA does
    }
  }

  claim(conn) {
    if (this.owner && this.owner !== conn) {
      const old = this.owner;
      this.log('info', 'new satellite connection from ' + conn.address + ' replaces the one from ' + old.address);
      this.release('replaced', { runReason: 'disconnected' });
      this.owner = null;
      old.sock.destroy();
      this.conns.delete(old);
      this.emit('disconnected', { address: old.address, reason: 'replaced' });
    }
    if (!this.owner) {
      this.owner = conn;
      this.paused = false;
      this.log('info', 'satellite connection from ' + conn.address);
      this.emit('connected', { address: conn.address });
      this.maybeListen();
    } else if (this.paused) {
      this.paused = false;
      this.emit('resumed', {});
      this.maybeListen();
    }
  }

  info() {
    return {
      asr: [], tts: [], handle: [], intent: [], wake: [],
      mic: [{ name: this.mic.deviceId || 'remote1', description: this.mic.source === 'remote' ? 'LG Magic Remote microphone' : 'webOS TV microphone', attribution: { name: '', url: '' }, installed: true, version: null, mic_format: MIC_FORMAT }],
      snd: [],
      satellite: {
        name: this.opts.name, description: 'webOS Wyoming satellite', attribution: { name: '', url: '' },
        installed: true, version: pkg.version, area: this.opts.area, has_vad: false, supports_trigger: false,
      },
    };
  }

  // ---- runs ----

  stream(run, buf) {
    if (this.run !== run && this.listening !== run) return;
    run.pending = run.pending.length ? Buffer.concat([run.pending, buf]) : buf;
    const size = this.opts.chunkBytes;
    while (run.pending.length >= size) this.chunk(run, run.pending.slice(0, size)), run.pending = run.pending.slice(size);
    if (backlog(run.conn.sock) > MAX_QUEUED_BYTES) {
      if (run === this.listening) { this.endListening('backpressure', { tell: false }); this.relisten(2000); } else this.endRun('backpressure', { tell: false });
    }
  }

  chunk(run, payload) {
    const timestamp = Math.round(run.sentBytes / BYTES_PER_MS);
    run.sentBytes += payload.length;
    this.write(run.conn, 'audio-chunk', Object.assign({ timestamp }, MIC_FORMAT), payload);
  }

  // Starts the mic stream for slot 'run' (one run, from the asr stage) or 'listening' (the wake word in HA, restarting):
  // run-pipeline and audio-start, then the buffer (if any) and the live audio.
  openStream(slot, startStage, restartOnEnd, buffer) {
    const conn = this.owner;
    const s = this[slot] = { conn, unfollow: null, timer: null, pending: Buffer.alloc(0), sentBytes: 0 };
    this.write(conn, 'run-pipeline', { start_stage: startStage, end_stage: 'tts', restart_on_end: restartOnEnd });
    this.write(conn, 'audio-start', Object.assign({ timestamp: 0 }, MIC_FORMAT));
    if (buffer) this.stream(s, buffer);
    s.unfollow = this.mic.follow((b) => this.stream(s, b));
    return s;
  }

  // Stops the mic stream in the slot; `tell` (default true) flushes the rest and sends audio-stop. Returns the stream, or null.
  closeStream(slot, o = {}) {
    const s = this[slot];
    if (!s) return null;
    this[slot] = null;
    clearTimeout(s.timer);
    if (s.unfollow) s.unfollow();
    if (o.tell !== false) {
      if (s.pending.length) this.chunk(s, s.pending);
      this.write(s.conn, 'audio-stop', { timestamp: Math.round(s.sentBytes / BYTES_PER_MS) });
    }
    return s;
  }

  // Ends the audio of the current run. `tell`: flush the rest and send audio-stop to HA.
  endRun(reason, o = {}) {
    if (!this.closeStream('run', o)) return;
    const info = { reason };
    if (o.error) info.error = o.error;
    this.emit('run-stop', info);
    // HA may still answer a run that ended on our side (mic lost, time-out, stopRun): keep waiting a while.
    if (['timeout', 'mic-lost', 'backpressure', 'stopped'].includes(reason) && this.pipeline) this.arm();
  }

  // ---- alwaysListen: the wake word runs in Home Assistant ----

  // Starts the continuous stream (run-pipeline from the wake stage, restart_on_end) when everything allows it.
  maybeListen() {
    if (!this.opts.alwaysListen || !this.server || this.listening || this.run || !this.owner || this.paused) return;
    if (!this.mic.status().on) return;
    this.openStream('listening', 'wake', true);
  }

  // Home Assistant does not restart after an error: ask for a new pipeline on the same stream.
  resend() {
    const l = this.listening;
    setTimeout(() => {
      if (this.listening === l && l) this.write(l.conn, 'run-pipeline', { start_stage: 'wake', end_stage: 'tts', restart_on_end: true });
    }, 500).unref();
  }

  relisten(ms) {
    clearTimeout(this.relistenTimer);
    this.relistenTimer = setTimeout(() => this.maybeListen(), ms);
    this.relistenTimer.unref();
  }

  endListening(reason, o = {}) {
    if (!this.closeStream('listening', o)) return;
    this.log('info', 'listening ended: ' + reason);
  }

  // ---- the pipeline in HA behind a run, and the audio HA sends back ----

  // (Re)starts the wait for an answer: while a run streams or HA is working on a transcript, audio that
  // follows is the answer to it; if nothing comes in answerTimeoutSeconds the pipeline is given up.
  arm() {
    if (!this.pipeline) this.pipeline = { transcript: false, heard: null, text: null, voice: null, timer: null };
    clearTimeout(this.pipeline.timer);
    if (this.run) return;   // the run's own limit covers the streaming part
    const p = this.pipeline;
    p.timer = setTimeout(() => {
      if (this.pipeline !== p) return;
      this.pipeline = null;
      this.emit('no-answer', { transcript: p.transcript });
    }, this.opts.answerTimeoutSeconds * 1000);
  }

  disarm() {
    if (!this.pipeline) return;
    clearTimeout(this.pipeline.timer);
    this.pipeline = null;
  }

  // Audio from HA outside a run is an announcement; after a `synthesize` it is the answer. Audio while the
  // microphone still streams cannot be an answer: HA cancelled the run for an announce, and the run ends here.
  // Audio after a transcript but before any `synthesize` is either a streamed answer (HA sends `synthesize` a
  // moment later) or an announce that cancelled the pipeline (nothing follows): it is held for CLASSIFY_MS.
  audioStart(conn, d) {
    const p = this.pipeline;
    if (!this.run && p && p.transcript && p.text === null) {
      this.dropHold();
      this.hold = { conn, d, events: [], timer: setTimeout(() => this.resolveHold(), CLASSIFY_MS) };
      return;
    }
    this.beginAudio(conn, d);
  }

  resolveHold() {
    const h = this.hold;
    if (!h) return;
    clearTimeout(h.timer);
    this.hold = null;
    this.beginAudio(h.conn, h.d);
    for (const ev of h.events) {
      if (ev.type === 'audio-chunk') this.playback.chunkRx(ev.data || {}, ev.payload); else this.audioStop();
    }
  }

  dropHold() {
    if (!this.hold) return;
    clearTimeout(this.hold.timer);
    this.hold = null;
  }

  beginAudio(conn, d) {
    const format = { rate: d.rate, width: d.width, channels: d.channels };
    let kind = 'announce';
    let cancelled = false;
    if (this.run) {
      this.endRun('announce', { tell: false });
      cancelled = true;
    } else if (this.pipeline && this.pipeline.text !== null) {
      kind = 'tts';
    } else if (this.pipeline) {
      cancelled = true;
    }
    const p = this.pipeline;
    if (kind === 'announce' && cancelled) this.disarm();
    if (kind === 'tts') clearTimeout(p.timer);
    // The answer to a run: `speakAnswer({ text, heard })` (an option) decides whether it is spoken; it is announced
    // either way with the `answer` event, so the host can show it.
    let silent = false;
    if (kind === 'tts') {
      const answer = { text: p.text || '', heard: p.heard || '' };
      let speak = true;
      if (typeof this.opts.speakAnswer === 'function') {
        try { speak = this.opts.speakAnswer(answer) !== false; } catch (e) { speak = true; }
      }
      silent = !speak;
      this.emit('answer', Object.assign({ spoken: speak }, answer));
    }
    this.playback.beginRx(conn, kind, format, {
      cancelled, silent, event: kind === 'tts' ? { text: p.text, voice: p.voice } : {},
    });
  }

  audioStop() {
    const rx = this.playback.rx;
    if (!rx) return;
    this.playback.endRx((r) => {
      if (r.kind === 'tts') {
        this.disarm();
        this.playback.stopWarmUp();
      } else if (r.info.cancelled) {
        this.playback.stopWarmUp();
      }
    });
  }

  fail(e) {
    this.log('error', String(e && e.message || e));
    if (this.listenerCount('error')) this.emit('error', e);
  }
}

function defaultLog(level, msg) {
  console.error('[webos-wyoming-satellite] ' + level + ': ' + msg);
}

module.exports = { Satellite };
