# webos-wyoming-satellite

A [Wyoming](https://github.com/OHF-Voice/wyoming) satellite for rooted LG webOS TVs. Home Assistant
connects to the TV and sees an `assist_satellite`, fed by the TV's own microphone (`internal1`).
It is a standalone service (configured by one JSON file) and a Node library.

Status: 0.1.0. It provides the Wyoming server, the microphone, a continuous stream for a wake word detected in
Home Assistant, and playing answers and announcements on the TV with ducking of the running programme.

## Requirements

- An LG webOS TV with root access (the library calls `luna-send` and reads the voice-input socket).
- Node 8.12 or newer on the TV (webOS 5 ships 8.12; newer TVs ship 20+). No npm, no dependencies: Node
  built-ins only. The code is CommonJS (`require`), so it also loads from a plain script on a TV without a package
  manager. The tests need Node 20.12 or newer on the computer that runs them.
- Home Assistant with the Wyoming integration (add the TV by host and port). For a wake word in
  Home Assistant, run openWakeWord there; this library does not detect wake words itself.

## Install the service on the TV

You need a rooted LG webOS TV with SSH access. Node is already on the TV (check with `node --version`, 8.12 or newer);
there is no npm and no git on it, and the satellite needs neither.

1. **Copy the files.** From a computer with this repository (or an unpacked release), copy `bin/`, `src/`,
   `init/`, `package.json` and a configuration file to a directory on the TV that survives reboots. `/media/developer` is a writable, persistent
   location on rooted TVs:

   ```
   ssh root@<tv> mkdir -p /media/developer/webos-wyoming-satellite
   scp -r bin src init package.json root@<tv>:/media/developer/webos-wyoming-satellite/
   scp config.example.json root@<tv>:/media/developer/webos-wyoming-satellite/config.json
   ```

2. **Edit `config.json`** on the TV (below). At least set `allowedHosts` to the address of Home Assistant.
3. **Check it:** `node bin/webos-wyoming-satellite.js --check --config config.json` prints `config ok` or lists every
   problem and exits with code 2.
4. **Run it once by hand:** `node bin/webos-wyoming-satellite.js --config config.json`. It logs `listening on ...`.
   Stop it with Ctrl+C.
5. **Start it at boot.** The script `init/webos-wyoming-satellite.sh` starts the service, keeps it running (it is
   started again 5 s after it ends, except after a rejected configuration) and takes `start`, `stop`, `restart` and `status`.
   Rooted TVs run executable scripts from an init.d-style directory at boot; with the Homebrew Channel root tooling
   that is `/var/lib/webosbrew/init.d/`:

   ```
   ssh root@<tv> 'cp /media/developer/webos-wyoming-satellite/init/webos-wyoming-satellite.sh /var/lib/webosbrew/init.d/50-webos-wyoming-satellite && chmod +x /var/lib/webosbrew/init.d/50-webos-wyoming-satellite'
   ssh root@<tv> /var/lib/webosbrew/init.d/50-webos-wyoming-satellite start
   ```

   The script reads `WWS_DIR` (default `/media/developer/webos-wyoming-satellite`), `WWS_CONFIG`, `WWS_NODE`, `WWS_LOG`
   (default `satellite.log` next to the code, rotated at 256 kB) and `WWS_RUN`; its header explains each. If your
   TV uses another boot mechanism, run `webos-wyoming-satellite.sh start` from it. To stop the service while
   testing: `... webos-wyoming-satellite.sh stop`.

### The configuration file

One JSON object. Unknown settings are errors, and all problems are reported together. Relative sound paths are
relative to the configuration file. Everything is optional; the values below are the defaults unless noted.

```json
{
  "port": 10700,
  "host": "0.0.0.0",
  "name": "webOS TV",
  "area": null,
  "allowedHosts": [],
  "alwaysListen": true,
  "mic": { "channel": 0, "gainDb": 15, "bufferSeconds": 2 },
  "sounds": { "wake": null, "done": null },
  "duckLevel": null,
  "logLevel": "info",
  "advanced": {}
}
```

- `allowedHosts`: IP addresses (not host names) allowed to connect. **Set it.** See Security below: empty means open
  and the service logs a warning at start.
- `alwaysListen`: `true` (the default of the config file; the library option defaults to `false`) streams the mic
  continuously to Home Assistant, which runs the wake word. **Privacy:** while it is on, everything the TV microphone
  hears is sent to your Home Assistant, not only after a wake word. Set it to `false` to avoid that. See below.
- `mic`: which of the 5 mic channels (0-4), gain in dB (-20..40), and the pre-wake-word buffer in seconds.
- `sounds`: WAV files (16-bit PCM, any rate) for the wake and the done sound.
- `duckLevel`: percent (0-100) the programme is turned down to while the satellite plays; `null` leaves the TV
  settings alone.
- `logLevel`: `info`, `warn` or `error`. The service logs to stderr; the boot script writes that to its log file.
- `advanced`: any of the numeric tuning options of the library table below (`holdMs`, `maxRunSeconds`,
  `warmUpMaxSeconds`, `answerTimeoutSeconds`, `maxQueueSeconds`, `playLeadMs`, `micPollMs`, `micRestartMs`,
  `micKeepAliveMs`, `chunkBytes`, `wakeSoundMaxDelayMs`, the `duck*Ms` timings), `duckApps`, and the strings `pacat`,
  `lunaSend`, `sink`.

### Add the TV to Home Assistant

1. In Home Assistant: Settings, Devices & services, Add integration, **Wyoming Protocol**.
2. Enter the IP address of the TV and the `port` (10700 by default). Home Assistant creates a device with an
   `assist_satellite` entity named after `name` (and the area, if `area` is set).
3. Set the pipeline of the satellite on its device page (the "Assistant" select).

Make sure the address of Home Assistant is in `allowedHosts`. Home Assistant opens several connections (a short probe
about every 30 seconds and one long-lived satellite connection); all come from the same address.

### Run the wake word in Home Assistant

The satellite does not detect wake words itself. With `alwaysListen: true` it streams the TV microphone to Home
Assistant, which runs the wake word:

1. Install the **openWakeWord** add-on (Settings, Add-ons) and start it; Home Assistant discovers it through the
   Wyoming integration.
2. In Settings, Voice assistants, open the assistant you use for the TV and choose a wake word (for example "ok nabu")
   next to its speech-to-text and text-to-speech.
3. Say the wake word near the TV. The programme is turned down (`duckLevel`), the wake sound plays if configured, and
   the answer is spoken on the TV. `assist_satellite.announce` plays announcements the same way.

The audio stream is continuous while the TV is on and Home Assistant has the satellite unmuted. It goes to Home
Assistant on your network only. The microphone is closed while the TV is off.

### Push to talk on the Magic Remote

TVs without a microphone in the set (for example the 2020 CX) can use the Magic Remote's instead. Start from
`config.remote.example.json`:

- `"mic": { "source": "remote" }` streams the remote's microphone (one channel, 16 kHz). The remote is a voice device
  only while it is connected, so it is looked up at each press. Starting the stream switches the remote's microphone on
  by itself; the key does not have to be held.
- `"trigger": { "key": 428 }` starts a run when that key is pressed (428 is the mic key of the MR20GA remote), read
  from `/dev/input/event*` without grabbing it, so the TV and other readers still see it. Needs `"alwaysListen": false`.
  The microphone is open only from the press until Home Assistant has the transcript; a press during a run ends it.
- To stop the TV's own voice assistant answering the same key, keep the key from LG's key filters, for example with
  Glasshouse's remote key settings (set the Microphone key to Home Assistant).

Known limit: `voiceinput` lets only the client that started a stream stop it or keep it alive, and each `luna-send` is
a new client, so the remote's microphone stays on until the TV's own timeout (about 10 s after the press; no audio is
sent once the run has ended), a press within that time is refused, and a command longer than about 10 s is cut off.

### Answers as toasts

`"answers": { "toast": true, "speak": "auto", "speakOver": 80 }` shows every answer (and a failed run) as a toast on the
TV. `speak` decides whether it is also spoken: `always` (the default), `never`, or `auto`, which speaks the reply to a
question (a question mark, or a sentence that opens like one) and any reply longer than `speakOver` characters, and only
shows a short reply to a command such as "Turned off the light". A muted answer is not played, and `played` still goes
to Home Assistant so the pipeline ends normally. Announcements are always spoken.

### Deploy from a computer

`TV_HOST=<tv> deploy/deploy.sh deploy <config.json>` copies the code and your config (kept wherever you like, outside
the repository) over one SSH connection, validates it, installs the boot hook and restarts the service.
`deploy/deploy.sh verify <config.json>` checks that every deployed file matches the working tree. `SSH_KEY_PUB` selects
an agent-held key.

## Use as a library

Copy the directory to the TV (or add it as a git submodule) and:

```js
const { Satellite } = require('./webos-wyoming-satellite');

const sat = new Satellite({
  port: 10700,
  allowedHosts: ['192.0.2.10'],       // the address of Home Assistant
  name: 'Living room TV',
  micChannel: 0, micGainDb: 15, bufferSeconds: 2,
  log: (level, message) => console.log(level, message),
});

sat.on('connected', ({ address }) => {});
sat.on('run-stop', ({ reason }) => {});
await sat.start();

// when something else heard the wake word:
const r = sat.startRun();             // { started: true } or { started: false, reason }
```

## Security: `allowedHosts`

The Wyoming protocol has no authentication. `allowedHosts` is the only gate: a list of IP
addresses (exact match; IPv4-mapped IPv6 addresses are compared as IPv4). A connection from any
other address is closed and logged with its address (`log('warn', 'refused connection from ...')`,
event `refused`). **An empty list lets every device on the network in** and logs a warning at
`start()` (event `warning`): any device on your LAN could open the TV microphone.

## API

The package root exports `Satellite`, an `EventEmitter`. The other modules in `src/` are internal.

### Options (`new Satellite(options)`)

| option | default | meaning |
|---|---|---|
| `port` | `10700` | TCP port HA connects to (`0` = pick a free one, see `sat.port`) |
| `host` | `'0.0.0.0'` | listen address |
| `allowedHosts` | `[]` | IPs allowed to connect; empty = open, with a warning |
| `name` | `'webOS TV'` | satellite and device name shown in HA |
| `area` | `null` | suggested HA area |
| `startMic` | `true` | open the microphone at `start()`; `false` leaves it closed until `setMic(true)` |
| `alwaysListen` | `false` | library default `false` (the standalone config file defaults to `true`). Stream the mic continuously to Home Assistant and let it run the wake word (see below; privacy note there); `startRun` is then not available |
| `micChannel` | `0` | which of the 5 mic channels (0-4) |
| `micGainDb` | `15` | gain in dB (-20..40) |
| `bufferSeconds` | `2` | pre-wake-word buffer kept in memory (0..10 s), sent first by `startRun` |
| `micPollMs` | `3000` | how often the power state and sound output are read |
| `micRestartMs` | `5000` | pause before reopening a lost mic stream |
| `micKeepAliveMs` | `4000` | `restartTimer` interval (the TV ends a silent stream after ~10 s); 0 = off |
| `maxRunSeconds` | `15` | safety limit for the audio of one run |
| `chunkBytes` | `2048` | size of the `audio-chunk` payloads sent to HA |
| `lunaSend` | `/usr/bin/luna-send` | path of `luna-send` (tests point this at a fake) |
| `log` | stderr | `log(level, message)`, level `info`, `warn` or `error` |
| `wakeSound` | `null` | WAV file (path or Buffer, 16-bit PCM, any rate) written into the stream at the start of a warm-up |
| `doneSound` | `null` | WAV file written into the stream by `stopWarmUp({ done: true })` |
| `wakeSoundMaxDelayMs` | `500` | no wake sound when the warm-up starts later than this after the `warmUp()` call (a late sound lands in the command) |
| `duckLevel` | `null` | percent (0-100) the foreground app is turned down to while anything plays; `null` = do not touch the tv settings |
| `duckApps` | `[]` | app ids whose own ducking value is checked by the duck guard (the foreground app is always checked) |
| `warmUpMaxSeconds` | `15` | longest warm-up; a call's `maxSeconds` can only shorten it |
| `answerTimeoutSeconds` | `10` | how long after a run (or its transcript) audio from Home Assistant still counts as its answer |
| `holdMs` | `350` | the sink stays open this long after the last sound or warm-up, so the programme does not jump back before the receiver is ready |
| `maxQueueSeconds` | `120` | audio from Home Assistant queued further ahead than this is dropped |
| `pacat` | `/usr/bin/pacat` | path of `pacat` (tests point this at a fake) |
| `sink` | `ptts` | PulseAudio sink for voice |
| `playLeadMs` | `120` | how far ahead of the play clock audio is written; sounds start at most this late |
| `duckPollMs`, `duckAfterMs`, `duckWaitMs`, `duckMinMs` | `60000`, `3000`, `1000`, `10000` | duck guard timing: periodic check, check after a foreground change, retry while audio plays, minimum gap between warm-up checks |

### Commands

- `await sat.start()` / `await sat.stop()`: listen and start the mic / close everything.
- `sat.startRun()` returns `{ started: true }` or `{ started: false, reason }` with reason
  `not-connected`, `paused`, `run-active` or `mic-off`. A run sends `run-pipeline`
  (`start_stage: asr`, `end_stage: tts`), the buffer, then live audio (16 kHz, 16-bit, mono).
- `sat.stopRun()` ends the audio (sends `audio-stop`); returns false when no run is active.
- `sat.followMic(fn)` calls `fn(Buffer)` for every processed mic chunk and returns a function to
  stop. Several followers get the same audio (for other mic users next to the satellite).
- `sat.configure({ micChannel, micGainDb, bufferSeconds, duckLevel })` changes these settings while running;
  out-of-range values keep the old one. `sat.clearMic()` empties the buffer.
- `sat.status()` is `{ listening, wakeStream, connected, paused, running, mic, warm, playing, duckLevel }`; `sat.micStatus()` is
  `{ on, output, since, restarts, bufferMs }`; `sat.micAwake()` is `true` or `false` by the last power poll
  (`null` when unknown).
- `await sat.warmUp({ maxSeconds, wakeSound })` plays silence on `ptts` (ducking), with the wake sound first; resolves
  `{ started: true }` or `{ started: false, reason }` (`tv-off`, `sink-lost`, or the luna error). Calling it again
  while warm moves the limit and plays the wake sound again (unless `wakeSound: false`), so a new wake word during the
  hold still gets its ping. It works without a run of its own.
- `sat.stopWarmUp({ done })` ends it (with `done: true` the done sound is written first); returns false when none runs.
- `await sat.play(bufferOrStream, { format, signal })` plays raw s16le audio (`format`: `{ rate, width: 2, channels }`, default
  44100 Hz mono) and resolves `{ ok }` when it has been heard. Abort the optional `signal` (`AbortSignal`) to cancel: that
  play's queued audio is dropped (other audio is untouched), a stream stops being read, and it resolves
  `{ ok: false, aborted: true }`. Roughly `playLeadMs` of audio already written to the sink still sounds.
- `sat.setAllowedHosts(list)` replaces the `allowedHosts` list (IP addresses) at any time, for example after a host name has
  been resolved; call it before `start()` to avoid the open-port warning.
- `sat.setMic(on)` opens or closes the microphone (a running run ends with `mic-lost`). Use it with `startMic: false`.

### Events

| event | payload | when |
|---|---|---|
| `connected` | `{ address }` | Home Assistant took the satellite connection (`run-satellite`) |
| `disconnected` | `{ address, reason }` | it closed, or a newer connection replaced it (`replaced`) |
| `paused` / `resumed` | | HA muted (`pause-satellite`) / unmuted the satellite |
| `run-start` | `{ bufferMs }` | `startRun` began streaming |
| `run-stop` | `{ reason, error? }` | `transcript`, `error`, `paused`, `disconnected`, `mic-lost`, `timeout`, `backpressure`, `stopped`, `announce` |
| `stt-start` / `stt-stop` | `{ language }` / `{ text }` | HA started / finished speech to text |
| `voice-start` / `voice-stop` | `{ timestamp }` | HA's speech detection heard speech start / end |
| `mic-status` | `{ on, output, since, restarts, bufferMs }` | the mic stream went on or off (output change, TV on/off, lost stream) |
| `refused` | `{ address }` | a connection outside `allowedHosts` |
| `warning` | `{ message }` | empty `allowedHosts` |
| `error` | `Error` | server error (only emitted when someone listens) |
| `warm-up-start` | `{ maxSeconds }` | the warm-up plays |
| `warm-up-stop` | `{ reason }` | `stopped`, `timeout` or `sink-lost` |
| `tts-start` | `{ text, voice }` | the audio of an answer begins to arrive |
| `tts-end` | | Home Assistant has sent all of the answer (it may still be playing) |
| `announce-start` | | an announcement begins to arrive |
| `played` | `{ kind, ok }` | the answer (`tts`) or announcement was heard and `played` went to Home Assistant; `ok` is false when the sink failed |
| `announce-end` | `{ ok }` | the announcement was heard (together with `played`) |
| `no-answer` | `{ transcript }` | no audio came for the run in `answerTimeoutSeconds` |
| `sink-lost` | `{ reason }` | `pacat` ended or failed |

## Sound and ducking

One `pacat` process on the `ptts` sink carries everything that is played: the warm-up silence, the wake sound, the
answer, the done sound, announcements and `play()` audio. It opens at the start of a warm-up (or at the first
sound) and closes `holdMs` after the last one, so the sink never goes idle in between. That keeps the programme
ducked and keeps an ARC path to a sound bar from dropping out.

- The silence is paced in Node. Piping `/dev/zero` into `pacat` would let it read ahead about 0.7 s, which delays
  the sounds written after it.
- Home Assistant sends audio (usually 22050 Hz, 16-bit mono) faster than real time. It is queued, converted to
  44100 Hz mono and played at its own pace; `played` goes back when the end has been heard.
- Ducking is only the system setting `TTSMixingRatio` (`duckLevel`): the tv lowers the foreground app by that
  percentage while `ptts` plays. At `start()` the global value is set and every per-app value cleared; the duck
  guard then checks the foreground app (and `duckApps`) and writes the level back for an app that has its own,
  deviating value. The library never changes the volume of the tv or the receiver (no `setVolume` call anywhere).
- Audio from Home Assistant is an answer when it follows a transcript or `synthesize` of a run started by
  `startRun()`; otherwise it is an announcement (`assist_satellite.announce`). An announcement that arrives while
  a run is still streaming cancels that run (`run-stop` with reason `announce`, no `audio-stop`).
- A warm-up ends on `stopWarmUp()`, on its maximum, when the answer or a cancelling announcement has been played,
  or when the sink is lost. A run whose answer never comes (for example when another satellite won) gets a
  `no-answer` event after `answerTimeoutSeconds`; the warm-up is then up to the host (`stopWarmUp()`) or its maximum.

## Wake word in Home Assistant (`alwaysListen`)

**Privacy:** with `alwaysListen` the microphone audio is streamed to Home Assistant all the time the conditions below
hold, not only after a wake word. Use it only with a Home Assistant you trust, on a network you trust.

With `alwaysListen: true` the satellite sends `run-pipeline` from the `wake` stage with `restart_on_end` and streams the
microphone continuously once Home Assistant has taken the connection, the mic is on and the satellite is not muted.
Home Assistant runs the wake word (openWakeWord) on that stream. A `detection` from Home Assistant emits `wake`
({ name }) and starts the warm-up (ducking and wake sound); the answer then plays as usual and ends the warm-up. After
an `error` (for example no speech recognised) the warm-up ends and the satellite asks for a new pipeline. The stream
stops while muted or when the mic is lost, and restarts by itself.

## How it behaves towards Home Assistant

- Home Assistant opens several connections: a short `describe`-only probe about every 30 s, and
  one long-lived satellite connection. A probe is answered and closed; it never takes over.
  The connection that sends `run-satellite` is the satellite; a new `run-satellite` from another
  connection replaces (and closes) a stale one.
- `ping` is answered with `pong` immediately, also while streaming; HA drops the connection after
  5 s of silence.
- Unknown events are ignored.

## Microphone behaviour

The mic runs while the TV is awake (Active, Screen Off, Screen Saver) and is closed otherwise;
the TV is never woken for it. It restarts when the sound output changes (speaker/ARC), when the
device list changes, when the stream is lost, and keeps the stream alive with `restartTimer`.

## Tests

```
npm test            # node --test test/*.test.js
```

No TV needed: the tests run a fake Home Assistant client over a real TCP socket, a fake
`luna-send` executable with a small TV model (power state, sound output, voice-input streams, the
`TTSMixingRatio` setting, the foreground app) and a fake `pacat` that records what is played and when.

## License

MIT
