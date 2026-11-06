'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConfig, loadConfig, ConfigError } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-config-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); return f; };
const errors = (cfg) => { try { parseConfig(cfg); } catch (e) { assert.ok(e instanceof ConfigError); return e.problems; } return []; };

test('an empty config gives the defaults of a satellite that lets Home Assistant run the wake word', () => {
  const { options, logLevel } = parseConfig({});
  assert.equal(options.port, 10700);
  assert.deepEqual(options.allowedHosts, []);
  assert.equal(options.alwaysListen, true);
  assert.equal(options.duckLevel, null);
  assert.equal(options.micChannel, 0);
  assert.equal(options.micGainDb, 15);
  assert.equal(logLevel, 'info');
});

test('the documented shape maps onto satellite options', () => {
  const { options } = parseConfig({
    port: 10701, host: '127.0.0.1', name: 'Bedroom TV', area: 'Bedroom', allowedHosts: ['192.0.2.10', '2001:db8::1'],
    alwaysListen: false, mic: { channel: 2, gainDb: 6, bufferSeconds: 1 }, sounds: { wake: '/sounds/wake.wav', done: null },
    duckLevel: 60, logLevel: 'warn', advanced: { holdMs: 500, pacat: '/opt/pacat', lunaSend: '/opt/luna-send', sink: 'voice' },
  });
  assert.deepEqual(options, {
    port: 10701, host: '127.0.0.1', name: 'Bedroom TV', area: 'Bedroom', allowedHosts: ['192.0.2.10', '2001:db8::1'],
    alwaysListen: false, micSource: 'internal', micChannel: 2, triggerKey: null, micGainDb: 6, bufferSeconds: 1,
    wakeSound: '/sounds/wake.wav', doneSound: null,
    duckLevel: 60, holdMs: 500, pacat: '/opt/pacat', lunaSend: '/opt/luna-send', sink: 'voice',
  });
});

test('push to talk on the remote: mic.source remote, trigger key, mic closed until a press', () => {
  const { options } = parseConfig({ alwaysListen: false, mic: { source: 'remote', gainDb: 0 }, trigger: { key: 428 } });
  assert.equal(options.micSource, 'remote');
  assert.equal(options.triggerKey, 428);
  assert.equal(options.startMic, false);
  assert.equal(options.micGainDb, 0);
  assert.equal(parseConfig({ alwaysListen: false, trigger: {} }).options.triggerKey, 428);
  const text = errors({ mic: { source: 'phone', channel: 0 }, trigger: { key: 428, hold: true } }).join('\n');
  for (const needle of ['mic.source', 'trigger.hold', 'alwaysListen']) assert.ok(text.includes(needle), needle + ' not in:\n' + text);
  assert.ok(errors({ alwaysListen: false, mic: { source: 'remote', channel: 1 } }).join().includes('mic.channel'), 'the remote has one channel');
});

test('every problem is reported at once, with the path of the setting', () => {
  const p = errors({
    port: 99999, allowedHosts: ['living-room.local', 5], mic: { channel: 7, gainDb: 'loud' }, duckLevel: 120,
    sounds: { wake: 3 }, logLevel: 'chatty', advanced: { holdMs: -1 },
  });
  const text = p.join('\n');
  for (const needle of ['port', 'allowedHosts[0]', 'allowedHosts[1]', 'mic.channel', 'mic.gainDb', 'duckLevel', 'sounds.wake', 'logLevel', 'advanced.holdMs']) {
    assert.ok(text.includes(needle), needle + ' not in:\n' + text);
  }
});

test('unknown settings are errors (typos must not pass silently)', () => {
  assert.ok(errors({ alowedHosts: [] }).join().includes('alowedHosts'));
  assert.ok(errors({ mic: { chanel: 1 } }).join().includes('mic.chanel'));
  assert.ok(errors({ advanced: { nope: 1 } }).join().includes('advanced.nope'));
  assert.ok(errors([]).length && errors('x').length && errors(null).length, 'must be an object');
});

test('loadConfig reads a file, resolves sound paths relative to it, and explains a missing or broken file', () => {
  const ok = write('ok.json', { sounds: { wake: 'sounds/wake.wav', done: '/abs/done.wav' } });
  const { options } = loadConfig(ok);
  assert.equal(options.wakeSound, path.join(dir, 'sounds', 'wake.wav'));
  assert.equal(options.doneSound, '/abs/done.wav');
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), (e) => e instanceof ConfigError && /missing\.json/.test(e.message) && /cannot read/.test(e.message));
  const bad = write('bad.json', '{ "port": ');
  assert.throws(() => loadConfig(bad), (e) => e instanceof ConfigError && /bad\.json/.test(e.message) && /JSON/.test(e.message));
  const invalid = write('invalid.json', { port: -1 });
  assert.throws(() => loadConfig(invalid), (e) => e instanceof ConfigError && /invalid\.json/.test(e.message) && /port/.test(e.message));
});
