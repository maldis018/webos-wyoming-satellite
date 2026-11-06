'use strict';
/*
 * Push to talk: a key on the remote starts a run.
 *
 *   const ptt = pushToTalk(satellite, { code: 428, log, waitSeconds: 4 });
 *   ptt.stop();
 *
 * A press ducks the programme (warm-up, with the wake sound if one is set), opens the microphone, and starts a run as
 * soon as the stream is on; the audio heard since the stream opened goes first, so a command spoken right after the
 * press is not cut. Home Assistant ends the run when it hears the speech end. A press during a run ends it. The
 * microphone closes again when the run stops, so it is only open between a press and the end of the command.
 * Use it with `startMic: false` and `alwaysListen: false`.
 */
const { Keys } = require('./keys');

function pushToTalk(sat, opts) {
  const log = opts.log || (() => {});
  const waitMs = (opts.waitSeconds === undefined ? 4 : opts.waitSeconds) * 1000;
  let pending = null;   // a press waiting for the stream: { onMic, timer }

  const settle = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    sat.removeListener('mic-status', pending.onMic);
    pending = null;
  };

  const begin = () => {
    settle();
    const r = sat.startRun();
    log('info', 'ptt: ' + (r.started ? 'run started' : 'run not started (' + r.reason + ')'));
    if (!r.started) { sat.setMic(false); sat.stopWarmUp(); }
  };

  const onRunStop = ({ reason }) => {
    log('info', 'ptt: run ended (' + reason + ')');
    sat.setMic(false);
  };
  sat.on('run-stop', onRunStop);

  const press = () => {
    const st = sat.status();
    if (st.running) { sat.stopRun(); return; }
    if (pending) return;
    if (!st.connected) { log('warn', 'ptt: Home Assistant has not connected to the satellite'); return; }
    if (st.paused) { log('info', 'ptt: the satellite is muted in Home Assistant'); return; }
    sat.warmUp().catch(() => {});
    if (sat.micStatus().on) { begin(); return; }
    pending = {
      onMic: (s) => { if (s.on) begin(); },
      timer: setTimeout(() => {
        settle();
        log('warn', 'ptt: the remote microphone did not open within ' + waitMs / 1000 + ' s');
        sat.setMic(false);
        sat.stopWarmUp();
      }, waitMs),
    };
    sat.on('mic-status', pending.onMic);
    sat.setMic(true);
  };

  const keys = new Keys({ code: opts.code, log, onPress: press });
  keys.start();

  return {
    press,
    stop() {
      settle();
      keys.stop();
      sat.removeListener('run-stop', onRunStop);
    },
  };
}

module.exports = { pushToTalk };
