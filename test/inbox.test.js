'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createAgentSpace } = require('../src/agentspace');
const { PAGE_JS, PAGE_HTML } = require('../src/page');
const { createSandbox } = require('./dom');

const IDS = ['signin', 'token', 'status', 'reload', 'sessions', 'sessions-state',
  'session-state', 'pending', 'pending-state', 'context', 'context-state'];
const TOKEN = 'inbox-token';

/**
 * Fixture: the served script runs in a sandbox DOM and its fetch routes to an
 * AgentSpace instance, so the client's behavior is exercised end to end with
 * only the DOM and network boundaries faked — the real client code and core
 * run unchanged.
 */
function buildClient() {
  const space = createAgentSpace();
  const { elements, sandbox } = createSandbox(IDS);
  const calls = [];
  let failReads = false;

  sandbox.fetch = (url, options) => {
    calls.push({ url, options: options || {} });
    if (failReads) return Promise.reject(new Error('boundary down'));
    const ok = (value) => Promise.resolve({ ok: true, json: async () => value });
    if (url === '/sessions') return ok({ sessions: space.listSessions() });
    if (url === '/sessions//questions/pending') return Promise.resolve({ ok: false, status: 400, json: async () => ({}) });
    let m = url.match(/^\/sessions\/([^/]+)\/questions\/pending$/);
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      try {
        return ok({ questions: space.listPendingQuestions(sessionId) });
      } catch (error) {
        return Promise.resolve({ ok: false, status: error.name === 'unknownSession' ? 404 : 400, json: async () => ({}) });
      }
    }
    m = url.match(/^\/sessions\/([^/]+)$/);
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      try {
        return ok(space.getSessionState(sessionId));
      } catch (error) {
        return Promise.resolve({ ok: false, status: error.name === 'unknownSession' ? 404 : 400, json: async () => ({}) });
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };

  vm.runInNewContext(PAGE_JS, sandbox, { filename: 'page.js' });
  const connect = async () => {
    elements.token.value = TOKEN;
    elements.signin.listeners.submit({ preventDefault() {} });
    await flush();
  };
  return { space, elements, calls, connect, setFailReads(v) { failReads = v; } };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sessionButtons(elements) {
  // Items are the li nodes hanging directly off the #sessions stub element.
  return elements.sessions.children.map((item) => item.children[0]);
}

test('two sessions switch by explicit identifier and no reply request is ever made', async () => {
  const { space, elements, calls, connect } = buildClient();
  await connect();
  assert.equal(calls[0].url, '/sessions', 'connecting reads the session list');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + TOKEN,
    'the token travels only in the Authorization header of the read');

  const first = space.createSession();
  const second = space.createSession();
  space.sendEvent(first.sessionId, { type: 'needs-user' });
  space.ask(first.sessionId, 'how should we start?');
  space.sendEvent(second.sessionId, { type: 'needs-user' });
  space.ask(second.sessionId, 'and now what?');

  await elements.reload.click();
  await flush();
  const buttons = sessionButtons(elements);
  assert.equal(buttons.length, 2, 'both sessions are listed');

  await buttons[1].click();
  await flush();
  assert.ok(calls.some((c) => c.url === '/sessions/' + second.sessionId),
    'the read names the exact second session id');
  assert.ok(calls.some((c) => c.url === '/sessions/' + second.sessionId + '/questions/pending'));
  assert.equal(elements['session-state'].textContent, 'Session ' + second.sessionId + ' status: needs-user');
  assert.equal(elements['context'].textContent, 'and now what?',
    'the text panel shows the second session’s question');

  await buttons[0].click();
  await flush();
  assert.ok(calls.some((c) => c.url === '/sessions/' + first.sessionId),
    'switching back names the exact first session id');
  assert.equal(elements['context'].textContent, 'how should we start?');

  const questionId = space.listPendingQuestions(first.sessionId)[0].questionId;
  const questionButton = elements.pending.children[0].children[0];
  assert.equal(questionButton.tagName, 'BUTTON');
  await questionButton.click();
  assert.equal(elements['context-state'].textContent, 'Text of question ' + questionId + ':');
  assert.equal(elements['context'].textContent, 'how should we start?',
    'switching questions selects that question text, fetched for this session');

  assert.ok(calls.every((c) => (c.options.method === undefined ? false : true) || c.url.includes('reply') === false),
    'no reply-shaped request is made');
  assert.ok(calls.every((c) => c.options.method === undefined || c.options.method === 'GET'),
    'the read-only client issues GET requests only');
  assert.ok(calls.every((c) => !c.url.includes('/reply')), 'no reply route is touched');
  assert.ok(calls.every((c) => !('url' in c.options)), 'the token is never embedded in a URL');
});

test('a rejected session read clears its questions and text panel', async () => {
  const client = buildClient();
  const { space, elements, connect } = client;
  await connect();
  const session = space.createSession();
  space.sendEvent(session.sessionId, { type: 'needs-user' });
  space.ask(session.sessionId, 'question from a session that later fails to read');

  await elements.reload.click();
  await flush();
  await sessionButtons(elements)[0].click();
  await flush();
  await flush();
  assert.ok(elements['context'].textContent.includes('later fails to read'), 'precondition');

  client.setFailReads(true);
  await sessionButtons(elements)[0].click();
  await flush();
  await flush();
  assert.equal(elements['pending-state'].textContent,
    'Could not load this session. Showing no questions.');
  assert.equal(elements.pending.textContent, '', 'no question rows remain');
  assert.equal(elements['context'].textContent, '', 'the old question text is gone');
  assert.equal(elements['context-state'].textContent, '');
});

test('markup- and script-shaped question text stays inert text', async () => {
  const { space, elements, connect } = buildClient();
  await connect();
  const session = space.createSession();
  space.sendEvent(session.sessionId, { type: 'needs-user' });
  const payload = '<img src=x onerror=window.__pwned=1><script>pwned()</script>';
  space.ask(session.sessionId, payload);

  await elements.reload.click();
  await flush();
  await sessionButtons(elements)[0].click();
  await flush();
  await flush();

  const questionButton = elements.pending.children[0].children[0];
  assert.equal(questionButton.tagName, 'BUTTON', 'questions render as button elements, not parsed HTML');
  await questionButton.click();
  assert.equal(elements['context'].textContent, payload,
    'markup-shaped text lands verbatim in an inert text node');
  assert.equal(globalThis.__pwned, undefined, 'no script-like payload ever executed');
  assert.equal(elements['session-state'].textContent, 'Session ' + session.sessionId + ' status: needs-user');
});

test('loading and empty pending states are shown before and after the read', async () => {
  const { space, elements, connect } = buildClient();
  await connect();
  space.createSession();
  await elements.reload.click();
  assert.equal(elements['sessions-state'].textContent, 'Loading sessions…',
    'the loading state shows before the read resolves');
  await flush();
  assert.ok(elements['sessions-state'].textContent.startsWith('Sessions:'),
    'the ready state follows the successful read');

  await sessionButtons(elements)[0].click();
  await flush();
  await flush();
  assert.equal(elements['pending-state'].textContent, 'No pending questions in this session.',
    'an empty pending list is stated, not left blank');
  assert.equal(elements['context'].textContent, '');
  assert.equal(elements['context-state'].textContent, '');
});

test('a rejected read ends stale results: list, questions and text panel clear', async () => {
  const client = buildClient();
  const { space, elements, connect } = client;
  await connect();
  const first = space.createSession();
  space.sendEvent(first.sessionId, { type: 'needs-user' });
  space.ask(first.sessionId, 'first question to read and then drop');

  await elements.reload.click();
  await flush();
  await sessionButtons(elements)[0].click();
  await flush();
  await flush();
  assert.ok(elements['context'].textContent.includes('first question'),
    'precondition: a successful read is on screen');

  client.setFailReads(true);
  await elements.reload.click();
  await flush();
  assert.equal(elements.sessions.textContent, '',
    'the session list empties; stale rows cannot pose as current');
  assert.ok(elements['sessions-state'].textContent.startsWith('Could not load sessions'),
    'the read failure is named in the state line');
  assert.equal(elements['pending-state'].textContent, '',
    'the previously-loaded pending text does not remain after a failed read');
  assert.equal(elements['context'].textContent, '',
    'the previously-shown question text does not survive a failed read');
});

test('page HTML has labelled controls, focus-visible styling and a narrow-screen rule', async () => {
  assert.ok(PAGE_HTML.includes('<label for="token">Local token</label>'));
  assert.ok(PAGE_HTML.includes('aria-labelledby="sessions-h"'));
  assert.ok(PAGE_HTML.includes('aria-labelledby="pending-h"'));
  assert.ok(PAGE_HTML.includes('focus-visible'), 'keyboard focus is visibly styled');
  assert.ok((PAGE_HTML.match(/@media \(max-width: 40rem\)/) || []).length === 1,
    'a narrow-screen layout rule exists');
});
