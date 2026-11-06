'use strict';
/*
 * Luna service calls through `luna-send`, one at a time.
 *
 *   const luna = createLuna({ lunaSend: '/usr/bin/luna-send' });
 *   luna.call('com.webos.service.tvpower/power/getPowerState', {}, (err, reply) => {});
 *   luna.call(uri, payload, cb, { name: 'com.example.helloworld' });   // sent under that service name (-m)
 *
 * luna-send runs through execFile, so its reply comes back on a pipe. `err` is set when
 * luna-send fails, times out, or answers returnValue false (the reply is still passed along).
 * A busy queue delays later calls; the queue is per createLuna() instance. Calls with a `name` register that
 * service name for their duration, and only one process can hold a name, so the queue running one call at a time is
 * what lets several calls share a name.
 */
const { execFile } = require('child_process');

const DEFAULT_LUNA_SEND = '/usr/bin/luna-send';

function createLuna(opts = {}) {
  const lunaSend = opts.lunaSend || DEFAULT_LUNA_SEND;
  const queue = [];
  let busy = false;

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    const as = job.opts && job.opts.name ? ['-m', job.opts.name] : [];
    execFile(lunaSend, ['-n', '1', '-w', '3000'].concat(as, ['luna://' + job.uri, JSON.stringify(job.payload || {})]),
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        busy = false;
        let reply = null;
        try { reply = JSON.parse(stdout); } catch (e) { /* no JSON */ }
        if (!err && !reply) err = new Error('no reply');
        if (!err && reply.returnValue === false) err = new Error(reply.errorText || 'returnValue false');
        if (err) err.message = job.uri + ': ' + err.message;
        next();
        job.cb(err, reply);
      });
  }

  return {
    lunaSend,
    call(uri, payload, cb, opts) {
      queue.push({ uri, payload, cb, opts });
      next();
    },
  };
}

// Complete JSON objects out of luna-send's streaming output (printed indented, over several lines).
class JsonStream {
  constructor(cb) { this.text = ''; this.cb = cb; }

  push(part) {
    this.text += part;
    let depth = 0, start = -1, inString = false, esc = false, done = 0;
    for (let i = 0; i < this.text.length; i++) {
      const c = this.text[i];
      if (inString) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}' && depth > 0 && --depth === 0) {
        try { this.cb(JSON.parse(this.text.slice(start, i + 1))); } catch (e) { /* skip */ }
        done = i + 1;
      }
    }
    this.text = this.text.slice(done);
  }
}

module.exports = { createLuna, JsonStream, DEFAULT_LUNA_SEND };
