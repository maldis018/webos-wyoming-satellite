'use strict';
/*
 * Key presses from the Magic Remote, read from the kernel input devices.
 *
 *   const keys = new Keys({ code: 428, log, onPress() {} });
 *   keys.start();   // finds the remote's /dev/input/event* devices and reads them
 *   keys.stop();
 *
 * Reading does not grab the devices: the tv (and other readers such as Glasshouse) still see every key.
 * Each device is read by its own `cat` child, because a blocking read of a character device inside Node
 * would hold one of the four libuv threads for as long as the device is open.
 *
 * A record is struct input_event for a 32-bit process: tv_sec, tv_usec (4 bytes each), type (u16),
 * code (u16), value (s32), 16 bytes. EV_KEY is type 1; value 1 is a press, 0 a release, 2 a repeat.
 * The mic key of the 2020 Magic Remote (MR20GA) is code 428 (KEY_VOICECOMMAND in Linux terms).
 */
const fs = require('fs');
const { spawn } = require('child_process');

const EV_KEY = 1;
const RECORD = 16;
const NAMES = /LGE RCU|LGE M-RCU|Smart Remote RCU Input|LGE Simple Premium/;

// The event devices whose names look like a remote, from /proc/bus/input/devices.
function findDevices(text, names) {
  const found = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const name = /^N: Name="([^"]*)"/m.exec(block);
    const handlers = /^H: Handlers=(.*)$/m.exec(block);
    if (!name || !handlers || !names.test(name[1])) continue;
    const ev = /\b(event\d+)\b/.exec(handlers[1]);
    if (ev) found.push({ name: name[1], path: '/dev/input/' + ev[1] });
  }
  return found;
}

class Keys {
  constructor(opts) {
    this.code = opts.code;
    this.log = opts.log || (() => {});
    this.onPress = opts.onPress || (() => {});
    this.names = opts.names || NAMES;
    this.debounceMs = opts.debounceMs === undefined ? 300 : opts.debounceMs;
    this.procs = [];
    this.last = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    let text = '';
    try { text = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (e) { this.log('warn', 'keys: cannot read input devices: ' + e.message); }
    const devices = findDevices(text, this.names);
    if (!devices.length) this.log('warn', 'keys: no remote input devices found');
    for (const d of devices) this.read(d);
    this.log('info', 'keys: watching key ' + this.code + ' on ' + devices.map((d) => d.path).join(', '));
  }

  read(d) {
    const proc = spawn('cat', [d.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let rest = Buffer.alloc(0);
    proc.stdout.on('data', (b) => {
      const data = rest.length ? Buffer.concat([rest, b]) : b;
      const n = Math.floor(data.length / RECORD);
      for (let i = 0; i < n; i++) {
        const o = i * RECORD;
        if (data.readUInt16LE(o + 8) === EV_KEY && data.readUInt16LE(o + 10) === this.code && data.readInt32LE(o + 12) === 1) this.pressed(d);
      }
      rest = data.slice(n * RECORD);
    });
    proc.on('error', (e) => this.log('warn', 'keys: ' + d.path + ': ' + e.message));
    proc.on('exit', () => {
      const i = this.procs.indexOf(proc);
      if (i >= 0) this.procs.splice(i, 1);
      if (this.started) this.log('warn', 'keys: reader for ' + d.path + ' ended');
    });
    this.procs.push(proc);
  }

  // One press can arrive on several devices of the same remote; count it once.
  pressed(d) {
    const now = Date.now();
    if (now - this.last < this.debounceMs) return;
    this.last = now;
    this.log('info', 'keys: key ' + this.code + ' pressed (' + d.name + ')');
    try { this.onPress(); } catch (e) { this.log('error', 'keys: press handler failed: ' + e.message); }
  }

  stop() {
    this.started = false;
    for (const p of this.procs.slice()) { try { p.kill(); } catch (e) { /* gone */ } }
    this.procs = [];
  }
}

module.exports = { Keys, findDevices };
