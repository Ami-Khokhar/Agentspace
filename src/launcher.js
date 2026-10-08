'use strict';

/**
 * Local launcher for the bootstrap page. It asks the operator to choose a
 * token, reads it once into memory (hidden, not echoed, never printed back),
 * and starts the loopback service. The token never appears in a URL, in
 * output, or in any stored data; the operator pastes it once into the opened
 * page, where it stays in memory for the life of the tab.
 */

const readline = require('node:readline');
const { Writable } = require('node:stream');
const { createServer } = require('./server');

/**
 * Ask with terminal: true, so readline enables raw mode on a real TTY: the
 * terminal's own line discipline (which would echo every typed character into
 * scrollback) is switched off, and readline's echo goes only to the muted
 * stream below, where every non-newline character is stripped. History is
 * disabled so the token never enters readline's in-memory history either.
 */
function askHidden(query, input, output) {
  output.write(query);
  // Muted echo stream: readline (terminal: true) writes its echo and cursor
  // control here; every character except line breaks is dropped, so nothing
  // typed is ever visible on the terminal or in scrollback.
  const muted = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      const newlines = text.replace(/[^\n\r]/g, '');
      if (newlines) output.write(newlines);
      cb();
    },
  });
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input,
      output: muted,
      terminal: true,
      historySize: 0,
    });
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; rl.close(); resolve(value); } };
    rl.question('', (answer) => { settle(answer); if (answer) output.write('\n'); });
    rl.on('error', reject);
    rl.on('close', () => settle(''));
  });
}

async function startLauncher({ port = 0, input = process.stdin, output = process.stdout } = {}) {
  const secret = await askHidden('Type a local token (hidden), then press Enter: ', input, output);
  if (!secret) throw new Error('agentspace: a non-empty token is required');
  const service = createServer({ port, secret });
  while (!service.address()) await new Promise((r) => setTimeout(r, 10));
  const url = `http://127.0.0.1:${service.address().port}`;
  output.write(`Agentspace page: ${url}\nSign in with the token you chose; it stays in memory only.\n`);
  return { url, service, close: service.close };
}

module.exports = { startLauncher };

if (require.main === module) {
  startLauncher().catch((err) => {
    process.stderr.write(`agentspace: ${err.message}\n`);
    process.exit(1);
  });
}
