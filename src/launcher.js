'use strict';

/**
 * Local launcher for the bootstrap page. It asks the operator to choose a
 * token, reads it once into memory (hidden, not echoed, never printed back),
 * and starts the loopback service. The token never appears in a URL, in
 * output, or in any stored data; the operator pastes it once into the opened
 * page, where it stays in memory for the life of the tab.
 */

const readline = require('node:readline');
const { createServer } = require('./server');

/** Read one line without echoing the characters that were typed. */
function askHidden(query, input, output) {
  output.write(query);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input,
      terminal: false,
      output: { write: (chunk) => { output.write(String(chunk).replace(/[^\n\r]/g, '')); return true; } },
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
