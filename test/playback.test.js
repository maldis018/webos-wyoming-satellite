'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Satellite } = require('../src');
const { createFakeTv } = require('./helpers/fake-tv');
const { createFakePacat, spans, wav, pcm } = require('./helpers/fake-pacat');
const { FakeHa } = require('./helpers/fake-ha');
const { sleep, until } = require('./helpers/util');

const tv = createFakeTv();
const sink = createFakePacat();
test.after(() => { tv.cleanup(); sink.cleanup(); });

const live = [];
const clients = [];
let logs;
async function makeSat(extra = {}) {
  logs = [];
  sink.reset();
  const sat = new Satellite({
    port: 0, allowedHosts: ['127.0.0.1'], lunaSend: tv.lunaSend, pacat: sink.pacat,
    log: (level, msg) => logs.push({ level, msg }),
    micGainDb: 20, bufferSeconds: 1, micPollMs: 100, micRestartMs: 100,
    holdMs: 150, answerTimeoutSeconds: 0.5,
    ...extra,
  });
  live.push(sat);
  sat.events = [];
  for (const name of ['run-start', 'run-stop', 'stt-stop', 'warm-up-start', 'warm-up-stop', 'tts-start', 'tts-end', 'played',
    'announce-start', 'announce-end', 'no-answer', 'sink-lost']) {
    sat.on(name, (e) => sat.events.push({ name, e, t: Date.now() }));
  }
  sat.names = () => sat.events.map((x) => x.name);
  sat.event = (name) => sat.events.find((x) => x.name === name);
  await sat.start();
  return sat;
}
async function ha(sat) {
  const c = await FakeHa.connect(sat.port);
  clients.push(c);
  await c.takeSatellite();
  return c;
}
// Home Assistant sending audio: all at once, in 2048-byte chunks, faster than real time.
function sendAudio(c, buf, rate = 22050) {
  c.send('audio-start', { rate, width: 2, channels: 1, timestamp: 0 });
  for (let i = 0; i < buf.length; i += 2048) {
    c.send('audio-chunk', { rate, width: 2, channels: 1, timestamp: 0 }, buf.slice(i, i + 2048));
  }
  c.send('audio-stop', { timestamp: 0 });
}
const mism = (calls) => calls.filter((c) => /volume/i.test(c.uri) && !/get/i.test(c.uri));

test.beforeEach(() => tv.setState({ power: 'Active', output: 'tv_speaker', die: false, timeoutMs: 0, glob: null, apps: {}, fg: 'com.webos.app.home' }));
test.afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await Promise.all(live.splice(0).map((s) => s.stop()));
  await sleep(150);
});

test('warmUp plays silence on ptts, paced in real time, from one pacat', async () => {
  const sat = await makeSat();
  const t0 = Date.now();
  assert.deepEqual(await sat.warmUp(), { started: true });
  await until('pacat started', () => sink.starts().length > 0);
  const args = sink.starts()[0].args;
  assert.ok(args.includes('ptts') && args.includes('--rate=44100') && args.includes('--format=s16le') && args.includes('--channels=1'), args.join(' '));
  await sleep(600);
  const ms = sink.bytes().length / 88.2;
  const elapsed = Date.now() - t0;
  assert.ok(ms >= 400 && ms <= elapsed + 200, 'silence written ' + ms + ' ms after ' + elapsed + ' ms');
  assert.deepEqual(spans(sink.bytes()), [], 'only silence');
  assert.equal(sink.starts().length, 1);
  assert.equal(sat.status().warm, true);
  assert.equal(sat.names().filter((n) => n === 'warm-up-start').length, 1);
});

test('the wake sound is written first, converted to 44.1 kHz mono, into the same stream', async () => {
  const sat = await makeSat({ wakeSound: wav(16000, 200, 5000) });
  await sat.warmUp();
  await sleep(500);
  const sp = spans(sink.bytes());
  assert.equal(sp.length, 1);
  assert.ok(sp[0].start < 5 && Math.abs((sp[0].end - sp[0].start) - 200) < 5, JSON.stringify(sp));
  assert.equal(sink.bytes().readInt16LE(2000), 5000);
  assert.equal(sink.starts().length, 1);
});

test('warmUp({ wakeSound: false }) and a warm-up that starts too late have no wake sound', async () => {
  const sat = await makeSat({ wakeSound: wav(44100, 100, 5000) });
  await sat.warmUp({ wakeSound: false });
  await sleep(300);
  assert.deepEqual(spans(sink.bytes()), []);
  sat.stopWarmUp();
  await sleep(500);
  sink.reset();
  const late = await makeSat({ wakeSound: wav(44100, 100, 5000), wakeSoundMaxDelayMs: -1 });
  await late.warmUp();
  await sleep(300);
  assert.deepEqual(spans(sink.bytes()), []);
});

test('warmUp is refused when the tv is off', async () => {
  tv.setState({ power: 'Suspend' });
  const sat = await makeSat();
  assert.deepEqual(await sat.warmUp(), { started: false, reason: 'tv-off' });
  assert.equal(sink.starts().length, 0);
});

test('a warm-up ends on its maximum, with a reason, and the sink closes after the hold time', async () => {
  const sat = await makeSat({ warmUpMaxSeconds: 0.4 });
  await sat.warmUp({ maxSeconds: 60 });   // the option caps the call
  await until('warm-up-stop', () => sat.names().includes('warm-up-stop'));
  assert.equal(sat.event('warm-up-stop').e.reason, 'timeout');
  assert.equal(sat.status().warm, false);
  await sleep(500);
  const n = sink.chunks().length;
  await sleep(300);
  assert.equal(sink.chunks().length, n, 'nothing is written after the sink closed');
});

test('stopWarmUp ends the warm-up; with done the done sound is written into the stream first', async () => {
  const sat = await makeSat({ doneSound: wav(44100, 120, 4000) });
  await sat.warmUp();
  await sleep(300);
  assert.equal(sat.stopWarmUp({ done: true }), true);
  assert.equal(sat.stopWarmUp(), false);
  await sleep(700);
  const sp = spans(sink.bytes());
  assert.equal(sp.length, 1);
  assert.ok(Math.abs((sp[0].end - sp[0].start) - 120) < 5, JSON.stringify(sp));
  assert.ok(sp[0].start >= 250, 'after the silence: ' + sp[0].start);
  assert.equal(sink.starts().length, 1);
  assert.equal(sat.event('warm-up-stop').e.reason, 'stopped');
});

test('the answer to a run plays on the same stream as the warm-up, played follows the end of the sound', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await sat.warmUp();
  await until('mic', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  c.send('transcribe', { language: 'en' });
  c.send('transcript', { text: 'hello' });
  await until('run over', () => sat.names().includes('run-stop'));
  c.send('synthesize', { text: 'hi there', voice: { name: 'x' } });
  const tSend = Date.now();
  sendAudio(c, pcm(22050, 1000, 6000));
  await c.waitFor('played');
  const waited = Date.now() - tSend;
  assert.ok(waited >= 900 && waited <= 1600, 'played after ' + waited + ' ms');
  assert.equal(sink.starts().length, 1, 'one pacat from warm-up to the end of the answer');
  const sp = spans(sink.bytes());
  assert.equal(sp.length, 1);
  assert.ok(Math.abs((sp[0].end - sp[0].start) - 1000) < 5, 'answer is 1000 ms at 44.1 kHz: ' + JSON.stringify(sp));
  assert.equal(sat.event('tts-start').e.text, 'hi there');
  const names = sat.names();
  assert.ok(names.indexOf('tts-start') < names.indexOf('tts-end') && names.indexOf('tts-end') < names.indexOf('played'), names.join());
  assert.equal(sat.event('played').e.kind, 'tts');
  // the warm-up ends with the answer and the sink closes after the hold time
  await until('warm-up over', () => !sat.status().warm);
  assert.equal(sat.event('warm-up-stop').e.reason, 'stopped');
  await sleep(500);
  const n = sink.chunks().length;
  await sleep(300);
  assert.equal(sink.chunks().length, n);
});

test('the answer is resampled without gaps when the chunks do not align with frames', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  sat.startRun();
  c.send('transcript', { text: 'x' });
  const ramp = Buffer.alloc(4410 * 2);
  for (let i = 0; i < 4410; i++) ramp.writeInt16LE(1000 + i, i * 2);   // 200 ms at 22050 Hz, rising
  c.send('audio-start', { rate: 22050, width: 2, channels: 1, timestamp: 0 });
  for (const [a, b] of [[0, 1001], [1001, 4000], [4000, ramp.length]]) c.send('audio-chunk', { rate: 22050, width: 2, channels: 1 }, ramp.slice(a, b));
  c.send('audio-stop', { timestamp: 0 });
  await c.waitFor('played');
  const out = sink.bytes();
  const sp = spans(out);
  assert.equal(sp.length, 1);
  const first = Math.round(sp[0].start * 44.1);
  const samples = [];
  for (let i = first; i < first + 8819; i++) samples.push(out.readInt16LE(i * 2));
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1] && samples[i] - samples[i - 1] <= 1, 'rises smoothly at ' + i);
  assert.ok(Math.abs(sp[0].end - sp[0].start - 200) < 3);
});

test('announce from HA plays and is confirmed with played; events announce-start and announce-end', async () => {
  const sat = await makeSat({ holdMs: 100 });
  const c = await ha(sat);
  const tSend = Date.now();
  sendAudio(c, pcm(22050, 600, 3000));
  await c.waitFor('played');
  const waited = Date.now() - tSend;
  assert.ok(waited >= 500 && waited <= 1300, 'played after ' + waited + ' ms');
  const sp = spans(sink.bytes());
  assert.equal(sp.length, 1);
  assert.ok(Math.abs(sp[0].end - sp[0].start - 600) < 5);
  await until('announce-end', () => sat.names().includes('announce-end'));
  assert.deepEqual(sat.names().filter((n) => /announce|played|tts/.test(n)), ['announce-start', 'played', 'announce-end']);
  assert.equal(sat.event('played').e.kind, 'announce');
  await until('sink closed', async () => { const n = sink.chunks().length; await sleep(250); return sink.chunks().length === n; });
});

test('an announce during a run cancels the run cleanly and plays', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  sat.startRun();
  await sleep(100);
  sendAudio(c, pcm(22050, 300, 3000));
  await c.waitFor('played');
  const stop = sat.event('run-stop');
  assert.equal(stop.e.reason, 'announce');
  assert.equal(c.of('audio-stop').length, 0, 'no audio-stop for a run HA cancelled');
  assert.equal(sat.status().running, false);
  assert.equal(sat.event('announce-start') !== undefined, true);
  assert.equal(sat.event('tts-start'), undefined);
  // a new run works afterwards
  assert.equal(sat.startRun().started, true);
});

test('an announce during a warm-up that waited for a run ends that warm-up', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  await sat.warmUp();
  sat.startRun();
  sendAudio(c, pcm(22050, 200, 3000));
  await c.waitFor('played');
  await until('warm-up over', () => !sat.status().warm);
  assert.equal(sink.starts().length, 1);
});

test('a run that gets a transcript but no answer (dedupe loser): no-answer event, warm-up ends on stopWarmUp or its maximum', async () => {
  const sat = await makeSat({ warmUpMaxSeconds: 1.5 });
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  await sat.warmUp();
  sat.startRun();
  c.send('transcript', { text: 'x' });
  await until('no-answer', () => sat.names().includes('no-answer'), 2000);
  assert.equal(sat.event('no-answer').e.transcript, true);
  assert.equal(sat.status().warm, true, 'the host decides: still warm');
  await until('maximum', () => !sat.status().warm, 3000);
  assert.equal(sat.event('warm-up-stop').e.reason, 'timeout');
  // after the give-up, audio from HA is an announce, not an answer
  sendAudio(c, pcm(22050, 100, 3000));
  await c.waitFor('played');
  assert.equal(sat.event('announce-start') !== undefined, true);
});

test('audio that follows a synthesize after a stopped run still counts as the answer', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  sat.startRun();
  await sleep(100);
  sat.stopRun();
  c.send('transcript', { text: 'x' });
  c.send('synthesize', { text: 'ok' });
  sendAudio(c, pcm(22050, 100, 3000));
  await c.waitFor('played');
  assert.equal(sat.event('tts-start').e.text, 'ok');
});

test('a lost sink ends the warm-up and says so', async () => {
  const sat = await makeSat({ pacat: '/bin/false' });
  const r = await sat.warmUp();
  await until('sink-lost', () => sat.names().includes('sink-lost') || r.started === false);
  assert.equal(sat.status().warm, false);
});

test('a closed connection while audio is arriving drops the queue', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  sendAudio(c, pcm(22050, 5000, 3000));
  await until('announce-start', () => sat.names().includes('announce-start'));
  await sleep(100);
  c.close();
  await until('disconnected', () => !sat.status().connected);
  await sleep(400);
  const played = spans(sink.bytes()).reduce((a, s) => a + s.end - s.start, 0);
  assert.ok(played < 1500, 'only what was already written ahead is played: ' + played + ' ms');
});

test('play(buffer) and play(stream) play through the same player and resolve when heard', async () => {
  const sat = await makeSat();
  const t0 = Date.now();
  const r = await sat.play(pcm(44100, 400, 2000));
  assert.deepEqual(r, { ok: true });
  assert.ok(Date.now() - t0 >= 350);
  const { Readable } = require('node:stream');
  const t1 = Date.now();
  const r2 = await sat.play(Readable.from([pcm(11025, 200, 2500), pcm(11025, 200, 2500)]), { format: { rate: 11025, width: 2, channels: 1 } });
  assert.equal(r2.ok, true);
  assert.ok(Date.now() - t1 >= 350);
  const sp = spans(sink.bytes());
  assert.equal(sp.length, 2);
  assert.ok(Math.abs(sp[1].end - sp[1].start - 400) < 5);
});

test('ducking: the level is set at start, per-app values are set back, and the volume is never touched', async () => {
  tv.setState({ glob: '90', apps: { 'youtube.leanback.v4': 50 } });
  const sat = await makeSat({ duckLevel: 35, duckApps: ['youtube.leanback.v4'], duckAfterMs: 100, duckPollMs: 100000 });
  await until('level applied', () => sat.status().duckLevel === 35);
  const st = () => JSON.parse(require('node:fs').readFileSync(require('node:path').join(tv.dir, 'state.json'), 'utf8'));
  assert.equal(st().glob, '35');
  // the app's own value was cleared by the global set, then written again by the app (as YouTube did)
  tv.setState({ apps: { 'youtube.leanback.v4': 50 } });
  tv.setState({ fg: 'youtube.leanback.v4' });
  await until('set back', () => String(st().apps['youtube.leanback.v4']) === '35');
  assert.equal(st().glob, '35', 'the global value was not deleted');
  // a whole answer and an announce later
  const c = await ha(sat);
  await sat.warmUp();
  sendAudio(c, pcm(22050, 200, 3000));
  await c.waitFor('played');
  sat.stopWarmUp();
  await sat.play(pcm(44100, 100, 1000));
  assert.deepEqual(mism(tv.calls()), [], 'no volume call');
  const writes = tv.calls().filter((x) => /setSystemSettings/.test(x.uri));
  for (const w of writes) assert.deepEqual(Object.keys(w.payload.settings), ['TTSMixingRatio']);
  for (const a of sink.starts()) assert.ok(!a.args.some((x) => /volume/i.test(x)));
});

test('without duckLevel the tv settings are left alone', async () => {
  const before = tv.calls().length;
  const sat = await makeSat();
  await sat.warmUp();
  await sleep(200);
  const mine = tv.calls().slice(before);
  assert.equal(mine.filter((x) => JSON.stringify(x.payload).includes('TTSMixingRatio')).length, 0);
  assert.equal(mine.filter((x) => /getForegroundAppInfo/.test(x.uri)).length, 0);
});

test('warmUp while already warm plays the wake sound again, but not with wakeSound: false', async () => {
  const sat = await makeSat({ wakeSound: wav(44100, 100, 5000) });
  await sat.warmUp();
  await sleep(500);
  assert.equal(spans(sink.bytes()).length, 1);
  assert.deepEqual(await sat.warmUp(), { started: true, already: true });
  await sleep(500);
  assert.equal(spans(sink.bytes()).length, 2, 'a second ping');
  await sat.warmUp({ wakeSound: false });
  await sleep(400);
  assert.equal(spans(sink.bytes()).length, 2, 'no third ping');
  assert.equal(sink.starts().length, 1);
  assert.equal(sat.names().filter((n) => n === 'warm-up-start').length, 1);
});

test('play() with an AbortSignal stops its own audio, resolves { ok: false, aborted: true } and leaves other audio alone', async () => {
  const sat = await makeSat();
  const ac = new AbortController();
  const long = pcm(44100, 3000, 6000);
  const p = sat.play(long, { signal: ac.signal });
  const q = sat.play(pcm(44100, 300, 3000));
  await sleep(300);
  ac.abort();
  assert.deepEqual(await p, { ok: false, aborted: true });
  assert.deepEqual(await q, { ok: true });
  await sleep(500);
  const ms = sink.bytes().length / 88.2;
  assert.ok(ms < 2000, 'the long sound was cut short, wrote ' + ms + ' ms');
  assert.equal(sat.status().playing, false);
});

test('play() with a signal that is already aborted plays nothing; an aborted stream stops being read', async () => {
  const sat = await makeSat();
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await sat.play(pcm(44100, 500, 5000), { signal: ac.signal }), { ok: false, aborted: true });
  await sleep(300);
  assert.deepEqual(spans(sink.bytes()), []);
  const ac2 = new AbortController();
  let reads = 0;
  async function* source() { for (;;) { reads++; yield pcm(44100, 100, 5000); await sleep(20); } }
  const p = sat.play(source(), { signal: ac2.signal });
  await sleep(200);
  ac2.abort();
  assert.deepEqual(await p, { ok: false, aborted: true });
  const n = reads;
  await sleep(200);
  assert.equal(reads, n, 'stream no longer read');
});

test('an announce after a transcript without synthesize is an announce, not the answer', async () => {
  const sat = await makeSat({ answerTimeoutSeconds: 3 });
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  sat.startRun();
  c.send('transcript', { text: 'x' });
  await sleep(50);
  sendAudio(c, pcm(22050, 200, 3000));          // HA cancelled the pipeline for an announce
  await c.waitFor('played');
  assert.equal(sat.event('played').e.kind, 'announce');
  assert.ok(sat.event('announce-start'));
  assert.equal(sat.event('tts-start'), undefined);
  assert.equal(sat.event('no-answer'), undefined, 'the cancelled pipeline is given up');
});

test('streamed answer audio that arrives just before synthesize is still the answer', async () => {
  const sat = await makeSat({ answerTimeoutSeconds: 3 });
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  sat.startRun();
  c.send('transcript', { text: 'x' });
  await sleep(50);
  c.send('audio-start', { rate: 22050, width: 2, channels: 1, timestamp: 0 });
  await sleep(60);
  c.send('synthesize', { text: 'hi', voice: {} });
  c.send('audio-chunk', { rate: 22050, width: 2, channels: 1, timestamp: 0 }, pcm(22050, 100, 3000));
  c.send('audio-stop', { timestamp: 0 });
  await c.waitFor('played');
  assert.equal(sat.event('played').e.kind, 'tts');
  assert.ok(sat.event('tts-start'));
  assert.equal(sat.event('announce-start'), undefined);
});

test('micAwake reports the power state seen by the mic without reaching into the mic', async () => {
  const sat = await makeSat();
  await until('awake', () => sat.micAwake() === true);
  tv.setState({ power: 'Active Standby' });
  await until('asleep', () => sat.micAwake() === false);
});

test('speakAnswer false: the answer is announced with what was heard, nothing plays, played still goes to HA', async () => {
  const seen = [];
  const sat = await makeSat({ speakAnswer: (a) => { seen.push(a); return false; } });
  const answers = [];
  sat.on('answer', (a) => answers.push(a));
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  c.send('transcript', { text: 'turn off the office lamp' });
  await until('run over', () => sat.names().includes('run-stop'));
  c.send('synthesize', { text: 'Turned off the light' });
  const tSend = Date.now();
  sendAudio(c, pcm(22050, 1000, 6000));
  await c.waitFor('played');
  assert.ok(Date.now() - tSend < 500, 'played at once, not after the 1 s of audio');
  assert.deepEqual(seen, [{ text: 'Turned off the light', heard: 'turn off the office lamp' }]);
  assert.deepEqual(answers, [{ spoken: false, text: 'Turned off the light', heard: 'turn off the office lamp' }]);
  assert.equal(sink.starts().length, 0, 'no pacat for a muted answer');
  assert.equal(sat.event('played').e.kind, 'tts');
});

test('speakAnswer true: the answer plays as usual and is announced as spoken', async () => {
  const sat = await makeSat({ speakAnswer: () => true });
  const answers = [];
  sat.on('answer', (a) => answers.push(a));
  const c = await ha(sat);
  await until('mic', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  c.send('transcript', { text: 'what is the weather?' });
  await until('run over', () => sat.names().includes('run-stop'));
  c.send('synthesize', { text: 'Sunny' });
  sendAudio(c, pcm(22050, 300, 6000));
  await c.waitFor('played');
  assert.equal(answers[0].spoken, true);
  assert.ok(spans(sink.bytes()).length === 1, 'the answer played');
});
