# Changelog

## Unreleased

- Runs on Node 8.12 (webOS 5): no `node:` module prefixes, no `for await`, a fallback for `writableLength`.
- `mic.source: "remote"`: the Magic Remote's microphone, for TVs without one in the set.
- `trigger: { key }`: push to talk on a remote key (428, the mic key), with the microphone closed between presses.
- `answers`: show answers as toasts and speak them always, never, or for questions and long replies (`auto`); events
  `answer` and `pipeline-error`, option `speakAnswer({ text, heard })`.
- `deploy/deploy.sh`: deploy from a computer with a config kept outside the repository, and verify the TV against git.
- The remote's voiceinput calls go out under one service name (`advanced.voiceBusName`, default
  `com.example.helloworld`) and unsubscribed, because voiceinput only lets the name that started a stream stop it or
  keep it alive. The remote's microphone now turns off when the run ends, a press right after works, and long commands
  are kept alive.
- Fix: a SIGTERM right after start could kill the service before its signal handlers were installed.
- Fix: the boot script's `stop` left the node process running (it looked for the supervisor's children after killing
  it), so `restart` failed with the port in use.

## 0.1.0

- Standalone service: `bin/webos-wyoming-satellite.js` runs from one JSON configuration file (`--config`, `--check`), with
  validation that reports every problem, and `init/webos-wyoming-satellite.sh` to start it at boot on a rooted TV.
- `alwaysListen`: continuous mic stream from the wake stage for a wake word detected in Home Assistant (event `wake`).
- `startMic` option and `setMic(on)`: the host decides when the microphone opens.
- `warmUp()` while already warm plays the wake sound again.
- `play(stream, { signal })`: an `AbortSignal` cancels that play only.
- Fix: stopping right after starting no longer leaves the duck guard running.

Earlier work in this release:

- Playback on `ptts`: `warmUp()` / `stopWarmUp()`, one continuous stream from warm-up to the end of the answer with a
  paced silence, wake and done sounds (WAV options), the answer of a run, `announce` from Home Assistant with `played`,
  `play(stream)`, and the events `warm-up-start/stop`, `tts-start/end`, `played`, `announce-start/end`, `no-answer`, `sink-lost`.
- Ducking by `TTSMixingRatio` only (`duckLevel`, `duckApps`) with a duck guard for apps that write their own value;
  the library never sets a volume.

- Wyoming server: `describe`/`info`, `ping`/`pong`, `run-satellite`/`pause-satellite`, `allowedHosts`.
- TV microphone (`internal1`) with pre-roll buffer, restart rules and `restartTimer`.
- `startRun()` / `stopRun()` / `followMic()` and the event set described in the README.
