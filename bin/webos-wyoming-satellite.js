#!/usr/bin/env node
'use strict';
const path = require('path');
const { startService } = require('../src/service');
const { loadConfig, ConfigError } = require('../src/config');
const pkg = require('../package.json');

const HELP = `webos-wyoming-satellite ${pkg.version}

Usage: webos-wyoming-satellite [--config <file>] [--check]

  -c, --config <file>  configuration file (default: $WEBOS_WYOMING_SATELLITE_CONFIG, else ./config.json)
      --check          validate the configuration and exit
  -h, --help           this text
  -v, --version        print the version
`;

function parseArgs(argv) {
  const a = { config: null, check: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--config' || v === '-c') a.config = argv[++i];
    else if (v.startsWith('--config=')) a.config = v.slice(9);
    else if (v === '--check') a.check = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--version' || v === '-v') a.version = true;
    else throw new ConfigError(['unknown argument ' + v + ' (see --help)']);
  }
  if (a.config === undefined || a.config === '') throw new ConfigError(['--config needs a file']);
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.version) { process.stdout.write(pkg.version + '\n'); return 0; }
  const configPath = path.resolve(args.config || process.env.WEBOS_WYOMING_SATELLITE_CONFIG || 'config.json');
  if (args.check) {
    loadConfig(configPath);
    process.stdout.write('config ok: ' + configPath + '\n');
    return 0;
  }
  // The handlers go in before the service starts: it logs "listening" before startService resolves, and a SIGTERM in
  // between would otherwise kill the process without stopping the microphone.
  let svc = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (!svc) return;   // still starting: stopped as soon as it is up
    svc.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  svc = await startService({ configPath });
  if (stopping) stop();
  return null;   // keep running
}

main().then((code) => { if (code !== null) process.exit(code); }, (e) => {
  if (e instanceof ConfigError) { process.stderr.write(e.message + '\n'); process.exit(2); }
  process.stderr.write('webos-wyoming-satellite: ' + (e && e.message || e) + '\n');
  process.exit(1);
});
