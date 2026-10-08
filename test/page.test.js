'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createServer } = require('../src/server');
const { PAGE_HTML, PAGE_JS } = require('../src/page');
const { startLauncher } = require('../src/launcher');
const { createSandbox } = require('./dom');

async function start() {
  const service = createServer({ port: 0 });
  while (!service.address()) await new Promise((r) => setTimeout(r, 5));
  const base = `http://127.0.0.1:${service.address().port}`;
  const get = (path) => request(base, path, 'GET', null, service.secret, {});
  return { base, service, secret: service.secret, get };
}

function request(base, path, method, body, secret, { headers = {}, host = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(body);
    const req = http.request(base + path, {
      method,
      headers: {
        ...(host ? { host } : {}),
        ...(origin ? { origin } : {}),
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(data ? { 'content-length': data.length } : {}),
        ...headers,
      },
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('fixed page and script are served on loopback with safe headers and no external assets', async () => {
  const { get, service } = await start();
  try {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.equal(page.text, PAGE_HTML, 'page is the fixed literal, not generated');

    const script = await get('/app.js');
    assert.equal(script.status, 200);
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(script.text, PAGE_JS, 'script is the fixed literal, not generated');
    for (const banned of ['console.', 'localStorage', 'sessionStorage', 'document.cookie', 'http://', 'https://']) {
      assert.ok(!script.text.includes(banned), `served script must not reference ${banned}`);
    }
    assert.ok(!page.text.includes('http://') && !page.text.includes('https://'), 'page references no external assets');

    // Assets are fixed and read-only: POSTing to the asset path never writes.
    assert.equal((await request(`http://127.0.0.1:${service.address().port}`, '/app.js', 'POST', '{}', service.secret, {})).status, 404);
  } finally {
    await service.close();
  }
});

test('traversal-like paths are rejected for the page and everywhere else', async () => {
  const { service } = await start();
  try {
    const base = `http://127.0.0.1:${service.address().port}`;
    // The guard runs on the raw request path, before URL normalisation.
    for (const path of ['/..', '/../app.js', '/.','/%2e', '/..%2fapp.js', '/app.js/../x', '/sessions/../questions/pending', '/.%2e/app.js', '/..%5c..%5cetc']) {
      const status = await rawRequest(service.address().port, `GET ${path} HTTP/1.1`);
      assert.equal(status, 400, `${path} must be rejected server-side`);
    }
    // Through the normal http client these stay un-normalised to the server,
    // and must still not serve an asset.
    for (const path of ['/..%2fsessions', '/app.js/%2e%2e/x']) {
      const res = await request(base, path, 'GET', null, service.secret, {});
      assert.ok(res.status === 400 || res.status === 404, `${path} -> ${res.status}`);
    }
  } finally {
    await service.close();
  }
});

function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = require('node:net').connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    let head = '';
    socket.on('data', (d) => { if (!head) head = d.split('\r\n')[0]; });
    socket.on('end', () => resolve(Number(head.split(' ')[1])));
    socket.on('error', reject);
  });
}

test('page assets keep the hostile Host/Origin guards and stay unauthenticated-API-free', async () => {
  const { base, get, service } = await start();
  try {
    const host = await request(base, '/', 'GET', null, service.secret, { host: 'attacker.example' });
    assert.equal(host.status, 421);
    assert.equal(JSON.parse(host.text).error, 'badHost');

    const crossOrigin = await request(base, '/app.js', 'GET', null, service.secret, { origin: 'https://evil.example' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.text).error, 'badOrigin');
    assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);

    // Assets serve no API data: with no token, browsers fetch assets but any
    // API read is still 401.
    assert.equal((await request(base, '/app.js', 'GET', null, null, {})).status, 200);
    assert.equal((await request(base, '/sessions', 'GET', null, null, {})).status, 401);
    assert.equal((await get('/sessions')).status, 200);
  } finally {
    await service.close();
  }
});

test('served page script keeps the token in memory and sends it only as Authorization', async () => {
  const { base, get, service } = await start();
  try {
    const appJs = (await get('/app.js')).text;

    const ids = ['signin', 'token', 'status', 'reload', 'sessions', 'sessions-state',
      'session-state', 'pending', 'pending-state', 'context', 'context-state'];
    const { elements, sandbox } = createSandbox(ids);
    vm.runInNewContext(appJs, sandbox, { filename: 'served-app.js' });

    const fetchCalls = [];
    sandbox.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, json: async () => ({ sessions: [{ sessionId: 'session-1', status: 'working', hasPendingQuestion: false }] }) };
    };

    elements.token.value = 'secret-page-token';
    // Simulate the browser firing the submit event on the form.
    assert.equal(typeof elements.signin.listeners.submit, 'function', 'script registers a submit handler');
    elements.signin.listeners.submit.call(null, { preventDefault() {} });

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchCalls.length, 1, 'bootstrap itself does one fetch');
    assert.equal(fetchCalls[0].url, '/sessions', 'token is never put in the URL');
    assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer secret-page-token');
    assert.equal(elements.status.textContent, 'connected', 'bootstrap reports success');
    assert.ok(elements.sessions.children.length === 1, 'the fetched session list is rendered once');
  } finally {
    await service.close();
  }
});

test('launcher keeps the token out of a fake-TTY echo (raw mode, muted output)', async () => {
  // A real terminal would echo typed characters back through readline's
  // output stream. The fake TTY records that channel separately from the
  // launcher's own prompt output so a mute bug cannot hide behind
  // PassThrough's lack of echo (the regression this guards: terminal: false
  // left the OS line discipline echoing the token verbatim into scrollback).
  const ttyEcho = [];
  const fakeTtyInput = new PassThrough();
  fakeTtyInput.isTTY = true;
  const rawModes = [];
  fakeTtyInput.setRawMode = (mode) => { rawModes.push(mode); };
  const fakeTtyOutput = new PassThrough();
  const originalWrite = fakeTtyOutput.write.bind(fakeTtyOutput);
  fakeTtyOutput.write = (chunk, ...rest) => {
    ttyEcho.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  const captured = [];
  const output = { write: (s) => { captured.push(String(s)); return true; } };
  const pending = startLauncher({ input: fakeTtyInput, output });
  await new Promise((r) => setTimeout(r, 20));
  fakeTtyInput.write('echo-secret-token\r');
  const launcher = await pending;
  try {
    assert.ok(rawModes.includes(true), 'readline must enable raw mode so the OS never echoes');
    const echoed = ttyEcho.join('');
    assert.ok(!echoed.includes('echo-secret-token'), 'nothing echoed to the terminal names the token');
    const printed = captured.join('');
    assert.ok(!printed.includes('echo-secret-token'), 'launcher output never names the token');
    assert.ok(/Type a local token/.test(captured.join('')));
  } finally {
    await launcher.close();
  }
});

test('launcher: manual token entry, nothing about the token is printed, page is reachable', async () => {
  const input = new PassThrough();
  const captured = [];
  const output = { write: (s) => { captured.push(String(s)); return true; } };
  const pending = startLauncher({ input, output });
  await new Promise((r) => setTimeout(r, 20));
  input.write('launch-secret-token\n');
  const launcher = await pending;
  try {
    const printed = captured.join('');
    assert.ok(/Type a local token/.test(printed), 'launcher prompts the operator');
    assert.match(printed, /^Agentspace page: http:\/\/127\.0\.0\.1:\d+$/m, 'launcher prints the loopback page address');
    assert.ok(!printed.includes('launch-secret-token'), 'launcher never prints the token');
    assert.ok(!launcher.url.includes('launch-secret-token'), 'page address carries no token');

    const page = await request(launcher.url, '/', 'GET', null, 'launch-secret-token', {});
    assert.equal(page.status, 200);
    const rejected = await request(launcher.url, '/sessions', 'GET', null, null, {});
    assert.equal(rejected.status, 401, 'launcher service still rejects unauthenticated API reads');
  } finally {
    await launcher.close();
  }
});
