'use strict';
/*
 * The tv's microphone (`internal1`) or the Magic Remote's (`source: 'remote'`) as a local stream with a pre-roll buffer.
 *
 *   const mic = new Mic({ luna, lunaSend, log, channel: 0, gainDb: 15, bufferSeconds: 2,
 *                         pollMs: 3000, restartMs: 5000, keepAliveMs: 4000, onChange(status) {} });
 *   mic.start();          // the stream runs while the tv is awake, off otherwise
 *   mic.take();           // Buffer (S16 LE, 16 kHz, mono, gain applied) of the last bufferSeconds; empties it
 *   mic.follow(fn);       // fn(Buffer) for every processed chunk from now on; returns a stop function
 *   mic.clear();          // empties the buffer
 *   mic.status();         // { on, output, since, restarts, bufferMs }
 *   mic.awake();          // true/false by the last poll, null when unknown
 *   mic.configure({...}); // channel, gainDb, bufferSeconds, pollMs, restartMs, keepAliveMs; out-of-range keeps the old value
 *   mic.stop();
 *
 * `voiceinput/startStreaming {"id":"internal1","subscribe":true}` answers with the path of a
 * unix socket that delivers the preprocessed stream: raw PCM, 16 kHz, S16 LE, 5 channels. One
 * channel is taken, with a fixed gain. With `source: 'remote'` the stream is
 * `startStreaming {"deviceId":"remote1","deviceType":"remote","keyType":"thinQtv","subscribe":true}`: one channel at
 * 16 kHz S16 LE, and starting it switches the remote's microphone on (its LED lights) without a key held. The remote is
 * listed by getDevices only while it is connected. `restartTimer` and `stopStreaming` take `{ id }`. Nothing leaves the tv here; audio only goes to followers.
 *
 * ON while the power state is Active, Screen Off or Screen Saver. OFF in Active Standby,
 * Suspend, or when unreadable: the tv is never woken for the microphone; this only reads the
 * power state and the sound output.
 *
 * RESTARTS: (1) the sound output changes between polls; (2) `voiceinput/getDevices` (subscribe)
 * reports another device list (sound1 <-> sound2); (3) the stream or socket closes by itself
 * (retry after restartMs); (4) the tv is not awake: closed. While the socket is open,
 * `voiceinput/restartTimer` is sent every keepAliveMs: without it the tv ends the stream after
 * about 10 s ("voice stop", reason "timeout occurs"). Closing kills luna-send, destroys the
 * socket and calls stopStreaming.
 */
const { spawn } = require('child_process');
const net = require('net');
const { JsonStream } = require('./luna');

const { AWAKE } = require('./power');
const VOICE = 'com.webos.service.voiceinput/';
const POWER = 'com.webos.service.tvpower/power/getPowerState';
const VOLUME = 'com.webos.service.audio/master/getVolume';
// The tv microphone (`internal1`) delivers 5 channels; the Magic Remote (`remote1`) delivers one.
const CHANNELS = { internal: 5, remote: 1 };
const BYTES_PER_S = 16000 * 2;

function number(v, min, max, fallback) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

class Mic {
  constructor(opts) {
    this.opts = opts;
    this.luna = opts.luna;
    this.lunaSend = opts.lunaSend || this.luna.lunaSend;
    this.log = opts.log || (() => {});
    this.source = opts.source === 'remote' ? 'remote' : 'internal';
    this.channels = CHANNELS[this.source];
    this.frame = this.channels * 2;
    this.deviceId = this.source === 'remote' ? null : 'internal1';   // the remote's id comes from getDevices
    this.waitLogged = false;
    this.configure(opts);
    this.started = false;
    this.timer = null;
    this.stream = null;     // { proc, sock, output }
    this.devices = null;    // the getDevices subscription { proc, last }
    this.busy = false;      // open or close in progress
    this.polling = false;
    this.isAwake = null;
    this.notBefore = 0;     // restart pause after a stream died
    this.on = false;
    this.output = null;
    this.since = null;
    this.restarts = 0;
    this.chunks = [];
    this.total = 0;
    this.rest = Buffer.alloc(0);
    this.followers = [];
  }

  configure(o) {
    this.channel = Math.floor(number(o.channel, 0, this.channels - 1, this.channel === undefined ? 0 : this.channel));
    this.gainDb = number(o.gainDb, -20, 40, this.gainDb === undefined ? 15 : this.gainDb);
    this.bufferSeconds = number(o.bufferSeconds, 0, 10, this.bufferSeconds === undefined ? 2 : this.bufferSeconds);
    this.factor = Math.pow(10, this.gainDb / 20);
    this.pollMs = number(o.pollMs, 20, 60000, this.pollMs || (this.source === 'remote' ? 250 : 3000));   // push to talk wants the remote stream quickly
    this.restartMs = number(o.restartMs, 20, 60000, this.restartMs || 5000);
    this.keepAliveMs = number(o.keepAliveMs, 0, 60000, this.keepAliveMs === undefined ? 4000 : this.keepAliveMs);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.poll();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.isAwake = null;
    this.close(() => {});
  }

  awake() { return this.isAwake; }

  status() {
    return { on: this.on, output: this.output, since: this.since, restarts: this.restarts,
      bufferMs: Math.round(this.total / BYTES_PER_S * 1000) };
  }

  follow(fn) {
    this.followers.push(fn);
    return () => { const i = this.followers.indexOf(fn); if (i >= 0) this.followers.splice(i, 1); };
  }

  clear() { this.chunks = []; this.total = 0; }

  take() {
    const all = Buffer.concat(this.chunks, this.total);
    const max = Math.floor(this.bufferSeconds * BYTES_PER_S / 2) * 2;
    this.clear();
    return all.length > max ? all.slice(all.length - max) : all;
  }

  changed() { if (this.opts.onChange) this.opts.onChange(this.status()); }

  // One look at the tv: power state, and the sound output while streaming.
  poll() {
    if (!this.started || this.polling || this.busy) return;
    this.polling = true;
    this.luna.call(POWER, {}, (err, r) => {
      const awake = !err && r && AWAKE[r.state] === true;
      if (!this.started) { this.polling = false; return; }
      this.isAwake = err || !r ? null : awake;
      if (!awake) {
        this.polling = false;
        if (this.stream) { this.log('mic: tv ' + (err ? 'unreadable' : r.state) + ', stream off'); this.close(() => {}); }
        return;
      }
      this.luna.call(VOLUME, {}, (errV, v) => {
        this.polling = false;
        const output = !errV && v && v.volumeStatus ? v.volumeStatus.soundOutput : null;
        if (!this.started || this.busy) return;
        if (!this.stream) { if (Date.now() >= this.notBefore) this.openWhenReady(output); return; }
        if (output && this.stream.output && output !== this.stream.output) this.restart('output ' + this.stream.output + ' -> ' + output);
      });
    });
  }

  // The remote is a voice device only while it is connected (it drops out after ~45 s idle), so its id is
  // looked up before each open; while it is missing, the next poll looks again.
  openWhenReady(output) {
    if (this.source !== 'remote') return this.open(output);
    this.busy = true;
    this.luna.call(VOICE + 'getDevices', {}, (err, r) => {
      this.busy = false;
      if (!this.started || this.stream) return;
      const list = !err && r && Array.isArray(r.devices) ? r.devices : [];
      const dev = list.filter((d) => d.deviceType === 'remote')[0];
      if (!dev) {
        if (!this.waitLogged) { this.log('mic: waiting for the remote to connect'); this.waitLogged = true; }
        return;
      }
      this.waitLogged = false;
      this.deviceId = dev.id;
      this.open(output);
    });
  }

  open(output) {
    const stream = { proc: null, sock: null, output };
    this.stream = stream;
    this.rest = Buffer.alloc(0);
    // sound1 <-> sound2 restarts concern the tv microphone only; for the remote a changing list would cut a command short.
    if (this.source !== 'remote') this.followDevices();
    const request = this.source === 'remote'
      ? { deviceId: this.deviceId, deviceType: 'remote', keyType: 'thinQtv', subscribe: true }
      : { id: 'internal1', subscribe: true };
    stream.proc = spawn(this.lunaSend, ['-i', 'luna://' + VOICE + 'startStreaming', JSON.stringify(request)],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const json = new JsonStream((j) => {
      if (this.stream !== stream) return;
      if (j.socketPath && !stream.sock) {
        stream.sock = net.connect(j.socketPath, () => {
          if (this.stream !== stream) return;
          this.on = true; this.output = output; this.since = new Date().toISOString();
          stream.keepAlive = this.keepAliveMs
            ? setInterval(() => this.luna.call(VOICE + 'restartTimer', { id: this.deviceId }, () => {}), this.keepAliveMs) : null;
          this.log('mic: stream on (' + this.deviceId + ', output ' + output + ', channel ' + this.channel + ', ' + this.gainDb + ' dB)');
          this.changed();
        });
        stream.sock.on('data', (b) => { if (this.stream === stream) this.ingest(b); });
        stream.sock.on('error', () => {});
        stream.sock.on('close', () => this.died(stream, 'socket closed'));
      } else if (j.returnValue === false) {
        this.died(stream, 'startStreaming: ' + (j.errorText || 'returnValue false'));
      }
    });
    stream.proc.stdout.on('data', (d) => json.push(String(d)));
    stream.proc.on('error', (e) => this.died(stream, 'luna-send: ' + e.message));
    stream.proc.on('exit', () => this.died(stream, 'luna-send ended'));
  }

  // The stream went away by itself: tidy up; the next poll starts it again after a pause.
  died(stream, reason) {
    if (this.stream !== stream) return;
    this.log('mic: stream lost (' + reason + ')');
    this.restarts++;
    this.notBefore = Date.now() + this.restartMs;
    this.close(() => {});
  }

  restart(reason) {
    this.log('mic: restart (' + reason + ')');
    this.restarts++;
    this.close(() => this.poll());
  }

  // While a stream runs, another list of devices (sound1 <-> sound2) means a restart.
  followDevices() {
    if (this.devices) return;
    const d = this.devices = { proc: null, last: null };
    d.proc = spawn(this.lunaSend, ['-i', 'luna://' + VOICE + 'getDevices', JSON.stringify({ subscribe: true })],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const json = new JsonStream((j) => {
      if (!j.devices || this.devices !== d) return;
      const list = JSON.stringify(j.devices.map((x) => x.id).sort());
      if (d.last !== null && list !== d.last && this.stream && !this.busy) this.restart('devices ' + d.last + ' -> ' + list);
      d.last = list;
    });
    d.proc.stdout.on('data', (b) => json.push(String(b)));
    d.proc.on('error', () => {});
  }

  stopDevices() {
    if (!this.devices) return;
    const p = this.devices.proc;
    this.devices = null;
    try { p.kill(); } catch (e) { /* gone */ }
  }

  close(cb) {
    const stream = this.stream;
    this.stopDevices();
    if (!stream) return cb();
    this.stream = null;
    this.busy = true;
    if (stream.keepAlive) clearInterval(stream.keepAlive);
    try { if (stream.sock) stream.sock.destroy(); } catch (e) { /* gone */ }
    try { stream.proc.kill(); } catch (e) { /* gone */ }
    this.clear();
    if (this.on) { this.on = false; this.changed(); }
    this.luna.call(VOICE + 'stopStreaming', { id: this.deviceId }, () => {
      this.busy = false;
      cb();
    });
  }

  // Raw 5-channel frames in; one channel, with gain, to the buffer and the followers.
  ingest(b) {
    const data = this.rest.length ? Buffer.concat([this.rest, b]) : b;
    const FRAME = this.frame;
    const frames = Math.floor(data.length / FRAME);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(data.readInt16LE(i * FRAME + this.channel * 2) * this.factor);
      out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
    }
    this.rest = data.slice(frames * FRAME);
    this.chunks.push(out);
    this.total += out.length;
    for (const fn of this.followers.slice()) { try { fn(out); } catch (e) { /* a follower must not break the stream */ } }
    const max = Math.floor(this.bufferSeconds * BYTES_PER_S / 2) * 2;
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= max) this.total -= this.chunks.shift().length;
  }
}

module.exports = { Mic };
