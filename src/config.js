'use strict';
/*
 * The configuration file of the standalone service: one JSON object, validated as a whole so that
 * every problem is reported at once. Unknown keys are errors (a typo must not silently fall back
 * to a default, least of all in allowedHosts).
 *
 * {
 *   "port": 10700, "host": "0.0.0.0", "name": "webOS TV", "area": null,
 *   "allowedHosts": ["192.0.2.10"],
 *   "alwaysListen": true,
 *   "mic": { "source": "internal", "channel": 0, "gainDb": 15, "bufferSeconds": 2 },   // source "remote": the Magic Remote
 *   "trigger": { "key": 428 },     // optional: push to talk on this remote key (428 = mic); needs alwaysListen false
 *   "answers": { "toast": false, "speak": "always", "speakOver": 80 },   // speak "auto": questions and long replies
 *   "sounds": { "wake": null, "done": null },
 *   "duckLevel": null,
 *   "logLevel": "info",
 *   "advanced": { "holdMs": 350, "pacat": "/usr/bin/pacat", ... }
 * }
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

class ConfigError extends Error {
  constructor(problems, file) {
    super((file ? file + ': ' : '') + (problems.length === 1 ? problems[0] : problems.length + ' problems in the configuration:\n  - ' + problems.join('\n  - ')));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOG_LEVELS = ['info', 'warn', 'error'];
const ADVANCED_NUMBERS = ['holdMs', 'maxRunSeconds', 'warmUpMaxSeconds', 'answerTimeoutSeconds', 'maxQueueSeconds', 'playLeadMs',
  'micPollMs', 'micRestartMs', 'micKeepAliveMs', 'chunkBytes', 'wakeSoundMaxDelayMs', 'duckPollMs', 'duckAfterMs', 'duckWaitMs', 'duckMinMs'];
const ADVANCED_STRINGS = ['pacat', 'lunaSend', 'sink'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseConfig(raw, o = {}) {
  const problems = [];
  const bad = (what, why) => problems.push(what + ' ' + why);
  if (!isObject(raw)) throw new ConfigError(['the configuration must be a JSON object']);

  const unknown = (obj, allowed, prefix) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(prefix + k, 'is not a known setting');
  };
  const section = (name) => {
    if (raw[name] === undefined) return {};
    if (!isObject(raw[name])) { bad(name, 'must be an object'); return {}; }
    return raw[name];
  };
  const number = (obj, key, prefix, def, min, max, integer) => {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) {
      bad(prefix + key, 'must be ' + (integer ? 'an integer' : 'a number') + ' from ' + min + ' to ' + max);
      return def;
    }
    return v;
  };
  const text = (obj, key, prefix, def, nullable) => {
    const v = obj[key];
    if (v === undefined) return def;
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || !v) { bad(prefix + key, 'must be ' + (nullable ? 'a non-empty string or null' : 'a non-empty string')); return def; }
    return v;
  };

  unknown(raw, ['port', 'host', 'name', 'area', 'allowedHosts', 'alwaysListen', 'mic', 'trigger', 'answers', 'sounds', 'duckLevel', 'logLevel', 'advanced'], '');
  const options = {
    port: number(raw, 'port', '', 10700, 0, 65535, true),
    host: text(raw, 'host', '', '0.0.0.0'),
    name: text(raw, 'name', '', 'webOS TV'),
    area: text(raw, 'area', '', null, true),
    allowedHosts: [],
    alwaysListen: true,
  };

  if (raw.allowedHosts !== undefined) {
    if (!Array.isArray(raw.allowedHosts)) bad('allowedHosts', 'must be a list of IP addresses');
    else {
      raw.allowedHosts.forEach((h, i) => {
        if (typeof h === 'string' && net.isIP(h)) options.allowedHosts.push(h);
        else bad('allowedHosts[' + i + ']', 'must be an IP address (host names are not matched), got ' + JSON.stringify(h));
      });
    }
  }
  if (raw.alwaysListen !== undefined) {
    if (typeof raw.alwaysListen !== 'boolean') bad('alwaysListen', 'must be true or false');
    else options.alwaysListen = raw.alwaysListen;
  }

  const mic = section('mic');
  unknown(mic, ['source', 'channel', 'gainDb', 'bufferSeconds'], 'mic.');
  options.micSource = 'internal';
  if (mic.source !== undefined) {
    if (mic.source !== 'internal' && mic.source !== 'remote') bad('mic.source', 'must be "internal" or "remote"');
    else options.micSource = mic.source;
  }
  options.micChannel = number(mic, 'channel', 'mic.', 0, 0, options.micSource === 'remote' ? 0 : 4, true);

  // Push to talk: a remote key starts a run; the microphone is closed in between.
  options.triggerKey = null;
  if (raw.trigger !== undefined && raw.trigger !== null) {
    const trigger = section('trigger');
    unknown(trigger, ['key'], 'trigger.');
    options.triggerKey = number(trigger, 'key', 'trigger.', 428, 1, 65535, true);
    if (options.alwaysListen) bad('trigger', 'needs "alwaysListen": false (push to talk and a continuous stream exclude each other)');
    options.startMic = false;
  }
  // What happens to the answer of a run: shown as a toast, spoken, or both. speak "auto" speaks a reply to a question
  // and a long reply; a short reply to a command is only shown.
  const answers = section('answers');
  unknown(answers, ['toast', 'speak', 'speakOver'], 'answers.');
  options.answerToast = false;
  if (answers.toast !== undefined) {
    if (typeof answers.toast !== 'boolean') bad('answers.toast', 'must be true or false');
    else options.answerToast = answers.toast;
  }
  options.answerSpeak = 'always';
  if (answers.speak !== undefined) {
    if (!['always', 'never', 'auto'].includes(answers.speak)) bad('answers.speak', 'must be "always", "never" or "auto"');
    else options.answerSpeak = answers.speak;
  }
  options.answerSpeakOver = number(answers, 'speakOver', 'answers.', 80, 0, 10000, true);
  options.micGainDb = number(mic, 'gainDb', 'mic.', 15, -20, 40, false);
  options.bufferSeconds = number(mic, 'bufferSeconds', 'mic.', 2, 0, 10, false);

  const sounds = section('sounds');
  unknown(sounds, ['wake', 'done'], 'sounds.');
  const base = o.baseDir;
  const soundPath = (v) => (v && base && !path.isAbsolute(v) ? path.join(base, v) : v);
  options.wakeSound = soundPath(text(sounds, 'wake', 'sounds.', null, true));
  options.doneSound = soundPath(text(sounds, 'done', 'sounds.', null, true));

  options.duckLevel = raw.duckLevel === undefined || raw.duckLevel === null ? null : number(raw, 'duckLevel', '', null, 0, 100, false);

  let logLevel = 'info';
  if (raw.logLevel !== undefined) {
    if (!LOG_LEVELS.includes(raw.logLevel)) bad('logLevel', 'must be one of ' + LOG_LEVELS.join(', '));
    else logLevel = raw.logLevel;
  }

  const adv = section('advanced');
  unknown(adv, [...ADVANCED_NUMBERS, ...ADVANCED_STRINGS, 'duckApps'], 'advanced.');
  for (const k of ADVANCED_NUMBERS) if (adv[k] !== undefined) options[k] = number(adv, k, 'advanced.', undefined, 0, 1e9, false);
  for (const k of ADVANCED_STRINGS) if (adv[k] !== undefined) options[k] = text(adv, k, 'advanced.', undefined);
  if (adv.duckApps !== undefined) {
    if (!Array.isArray(adv.duckApps) || adv.duckApps.some((a) => typeof a !== 'string' || !a)) bad('advanced.duckApps', 'must be a list of app ids');
    else options.duckApps = adv.duckApps;
  }

  if (problems.length) throw new ConfigError(problems);
  return { options, logLevel };
}

// Reads and validates a config file. Errors name the file. Relative sound paths are relative to the file.
function loadConfig(file) {
  let rawText;
  try { rawText = fs.readFileSync(file, 'utf8'); } catch (e) { throw new ConfigError(['cannot read ' + file + ': ' + e.message]); }
  let raw;
  try { raw = JSON.parse(rawText); } catch (e) { throw new ConfigError([file + ' is not valid JSON: ' + e.message]); }
  try {
    return parseConfig(raw, { baseDir: path.dirname(path.resolve(file)) });
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(e.problems, file);
    throw e;
  }
}

module.exports = { parseConfig, loadConfig, ConfigError };
