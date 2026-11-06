'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createLuna } = require('../src/luna');
const { Mic } = require('../src/mic');
const { createFakeTv } = require('./helpers/fake-tv');
const { sleep, until, samples } = require('./helpers/util');

const NAME = 'com.example.helloworld';
let t0 = 0;   // the start of the current test; the fake's call log spans all tests
const tv = createFakeTv();
test.after(() => tv.cleanup());
test.beforeEach(() => { t0 = Date.now(); }, { timeout: 1000 });
test.beforeEach(() => tv.setState({ power: 'Active', output: 'tv_speaker', die: false, timeoutMs: 0, remote: true, remoteOwner: undefined, remoteStops: 0, lastRestart: 0 }));

let mic = null;
function make(extra = {}) {
  const luna = createLuna({ lunaSend: tv.lunaSend });
  mic = new Mic({ luna, log: () => {}, source: 'remote', gainDb: 0, bufferSeconds: 1, pollMs: 50, restartMs: 100, ...extra });
  return mic;
}
const state = () => JSON.parse(fs.readFileSync(tv.dir + '/state.json', 'utf8'));
const remoteCalls = () => tv.calls().filter((c) => c.t >= t0 && /voiceinput\/(startStreaming|restartTimer|stopStreaming)/.test(c.uri) && (c.payload.deviceId === 'remote1' || c.payload.id === 'remote1'));
test.afterEach(async () => {
  if (mic) { mic.stop(); mic = null; }
  await until('remote stream ended', () => !state().remoteOwner, 3000).catch(() => {});
  tv.setState({ remoteOwner: undefined });
  await sleep(150);
});

test('the fake refuses a stop from another name, as the tv does', async () => {
  tv.setState({ remoteOwner: NAME });
  const out = execFileSync(tv.lunaSend, ['-n', '1', 'luna://com.webos.service.voiceinput/stopStreaming', '{"id":"remote1"}']).toString();
  assert.match(out, /permission fail/);
  tv.setState({ remoteOwner: undefined });
});

test('waits for the remote, then streams its one channel; every remote call goes out under one name, none subscribed', async () => {
  tv.setState({ remote: false });
  make().start();
  await sleep(300);
  assert.equal(mic.status().on, false, 'no remote, no stream');
  tv.setState({ remote: true });
  await until('stream on', () => mic.status().on);
  await sleep(600);
  const b = mic.take();
  assert.ok(b.length > 10000, 'audio arrives: ' + b.length + ' bytes');
  assert.ok(samples(b).every((v) => v === 1000), 'one channel, 0 dB');
  const calls = remoteCalls();
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c.name === NAME), JSON.stringify(calls.map((c) => c.name)));
  assert.ok(calls.every((c) => !c.payload.subscribe), 'no subscription holds the name');
});

test('stop() really stops the remote stream, so the next press can start one at once', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  mic.stop();
  await until('stopStreaming went through', () => state().remoteStops === 1 && !state().remoteOwner);
  make().start();
  await until('on again right away', () => mic.status().on, 2000);
});

test('restartTimer under the same name keeps a stream alive past the tv timeout', async () => {
  tv.setState({ timeoutMs: 300 });
  make({ keepAliveMs: 100 }).start();
  await until('stream on', () => mic.status().on);
  const since = mic.status().since;
  await sleep(1200);
  assert.equal(mic.status().on, true, 'still on after 4 timeouts');
  assert.equal(mic.status().since, since, 'the same stream, not a restarted one');
  assert.ok(remoteCalls().filter((c) => c.uri.endsWith('restartTimer')).length >= 5);
});

test('a leftover stream of our own name is stopped and a fresh one started', async () => {
  tv.setState({ remoteOwner: NAME });
  make().start();
  await until('stream on', () => mic.status().on, 3000);
  assert.ok(state().remoteStops >= 1, 'the leftover was stopped first');
});

test('a stream someone else owns is left alone; ours starts once it ends', async () => {
  tv.setState({ remoteOwner: 'com.webos.app.voice' });
  make().start();
  await sleep(500);
  assert.equal(mic.status().on, false);
  assert.equal(state().remoteOwner, 'com.webos.app.voice', 'not ours to stop');
  tv.setState({ remoteOwner: undefined });
  await until('stream on', () => mic.status().on, 3000);
});
