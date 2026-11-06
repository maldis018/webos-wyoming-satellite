'use strict';
/*
 * Ducking: the tv lowers the foreground app while something plays on the tts sink (ptts), to the
 * percentage in the system setting `TTSMixingRatio`. This library never touches the volume; it only
 * sets that percentage, and keeps it where it should be.
 *
 * Facts this relies on (measured on a webOS 6 tv):
 * - The key is global, with optional per-app values; an app without its own value uses the global
 *   one. The audio service reads it when an app comes to the foreground.
 * - deleteSystemSettings for the key deletes it everywhere (the global value and every per-app
 *   value), whatever app_id it gets. That is how per-app values are cleared.
 * - A read without app_id never finds the global value; a read for an app id that has no value of
 *   its own returns it. PROBE_APP is such an id.
 */
const { spawn } = require('child_process');
const { JsonStream } = require('./luna');

const SETTINGS = 'com.webos.settingsservice/';
const KEY = 'TTSMixingRatio';
const PROBE_APP = 'webos.wyoming.satellite.probe';

function validLevel(level) {
  if (level === null || level === undefined || level === '') return null;
  const n = Number(level);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

// What audiod uses for this app: its own value, else the global one; null when there is none.
// cb(err, value)
function readApp(luna, app, cb) {
  luna.call(SETTINGS + 'getSystemSettings', { category: 'sound', keys: [KEY], app_id: app }, (err, r) => {
    if (err) return cb(/no matched result/i.test(err.message) ? null : err, null);
    cb(null, validLevel(r.settings && r.settings[KEY]));
  });
}

// Sets one app's own value and reads it back; deletes nothing. cb(err, value)
function setApp(luna, app, level, cb) {
  const n = validLevel(level);
  if (n === null) return cb(new Error('duck level must be 0-100, got ' + level));
  luna.call(SETTINGS + 'setSystemSettings', { category: 'sound', settings: { [KEY]: String(n) }, app_id: app }, (err) => {
    if (err) return cb(err);
    readApp(luna, app, (err2, value) => {
      if (err2) return cb(err2);
      if (value !== n) return cb(new Error('duck level: set ' + n + ' for ' + app + ' but the tv reports ' + value));
      cb(null, value);
    });
  });
}

// Clears every per-app value, sets the global value and reads it back. cb(err, value)
function setGlobal(luna, level, cb) {
  const n = validLevel(level);
  if (n === null) return cb(new Error('duck level must be 0-100, got ' + level));
  luna.call(SETTINGS + 'deleteSystemSettings', { category: 'sound', keys: [KEY], app_id: PROBE_APP }, (delErr) => {
    // Nothing to delete is fine; anything else is reported but the global value is still set.
    const note = delErr && !/no matched result/i.test(delErr.message) ? delErr : null;
    luna.call(SETTINGS + 'setSystemSettings', { category: 'sound', settings: { [KEY]: String(n) } }, (err) => {
      if (err) return cb(err);
      readApp(luna, PROBE_APP, (err2, value) => {
        if (err2) return cb(err2);
        if (value !== n) return cb(new Error('duck level: set ' + n + ' but the tv reports ' + value));
        cb(note, value);
      });
    });
  });
}

/*
 * The duck guard: every app's TTSMixingRatio must be the duck level.
 *
 * An app with its own value is ducked to that, not to the duck level, and an app can write its
 * own value at any time (one did, while the global value was another). The guard reads the value
 * of the foreground app and of the listed apps and sets a deviating one back with setApp: one
 * write for that app only, nothing deleted, so the global value never goes missing.
 *
 * When it checks: when the foreground app changes (getForegroundAppInfo, subscribed) and again
 * `afterMs` later (an app that writes its value while it starts), every `pollMs`, and when asked
 * (check('warm-up'), at most every `minMs`). Never while busy() is true: it tries again after
 * `waitMs`.
 *
 *   const g = new DuckGuard({ luna, level: () => 70, busy: () => false, apps: ['some.app'] });
 *   g.start(); g.check(reason, cb); g.stop();
 */
class DuckGuard {
  constructor(o) {
    this.luna = o.luna;
    this.level = o.level;
    this.busy = o.busy || (() => false);
    this.log = o.log || (() => {});
    this.apps = o.apps || [];
    this.pollMs = o.pollMs === undefined ? 60000 : o.pollMs;
    this.afterMs = o.afterMs === undefined ? 3000 : o.afterMs;
    this.waitMs = o.waitMs || 1000;
    this.minMs = o.minMs === undefined ? 10000 : o.minMs;
    this.started = false;
    this.foreground = null;
    this.running = false;
    this.again = false;
    this.waitTimer = null;
    this.pollTimer = null;
    this.afterTimer = null;
    this.followTimer = null;
    this.proc = null;
    this.lastWarmUp = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.follow();
    if (this.pollMs > 0) this.pollTimer = setInterval(() => this.check('periodic'), this.pollMs);
    this.check('start');
  }

  stop() {
    this.started = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.waitTimer);
    clearTimeout(this.afterTimer);
    clearTimeout(this.followTimer);
    this.waitTimer = this.afterTimer = this.followTimer = null;
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* gone */ } }
  }

  // luna-send -i getForegroundAppInfo {subscribe: true}: one object now, one per change.
  follow() {
    const p = this.proc = spawn(this.luna.lunaSend, ['-i', 'luna://com.webos.applicationManager/getForegroundAppInfo', JSON.stringify({ subscribe: true })],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const json = new JsonStream((j) => {
      if (this.proc !== p || typeof j.appId !== 'string' || !j.appId || j.appId === this.foreground) return;
      this.foreground = j.appId;
      this.check('foreground ' + j.appId);
      clearTimeout(this.afterTimer);
      this.afterTimer = setTimeout(() => this.check('foreground +' + this.afterMs + ' ms'), this.afterMs);
    });
    p.stdout.on('data', (d) => json.push(String(d)));
    const gone = () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.started) this.followTimer = setTimeout(() => { if (this.started) this.follow(); }, 5000);
    };
    p.on('error', gone);
    p.on('exit', gone);
  }

  // cb(err, repaired): repaired lists { app, was, now } of the apps set back.
  check(reason, cb) {
    cb = cb || (() => {});
    if (!this.started) return cb(null, []);
    if (reason === 'warm-up') {
      if (Date.now() - this.lastWarmUp < this.minMs) return cb(null, []);
      this.lastWarmUp = Date.now();
    }
    if (this.running) { this.again = true; return cb(null, []); }
    const want = this.level();
    if (want === null || want === undefined) return cb(null, []);
    if (this.busy()) {
      if (!this.waitTimer) this.waitTimer = setTimeout(() => { this.waitTimer = null; this.check(reason); }, this.waitMs);
      return cb(null, []);
    }
    this.running = true;
    const list = this.apps.slice();
    if (this.foreground && !list.includes(this.foreground)) list.push(this.foreground);
    const repaired = [];
    const next = (i, lastError) => {
      if (i >= list.length || !this.started) {
        this.running = false;
        if (this.again) { this.again = false; setImmediate(() => this.check('again')); }
        return cb(lastError, repaired);
      }
      const app = list[i];
      readApp(this.luna, app, (err, value) => {
        if (err) { this.log('warn', 'duck guard: read ' + app + ': ' + err.message); return next(i + 1, err); }
        if (value === null || value === want) return next(i + 1, lastError);
        setApp(this.luna, app, want, (err2) => {
          if (err2) { this.log('warn', 'duck guard: ' + app + ' not set back: ' + err2.message); return next(i + 1, err2); }
          this.log('info', 'duck guard: ' + app + ' had its own TTSMixingRatio ' + value + ', set to ' + want + ' (' + reason + ')');
          repaired.push({ app, was: value, now: want });
          next(i + 1, lastError);
        });
      });
    };
    next(0, null);
  }
}

module.exports = { validLevel, readApp, setApp, setGlobal, DuckGuard, PROBE_APP };
