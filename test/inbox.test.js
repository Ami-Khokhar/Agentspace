'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PAGE_JS } = require('../src/page');

/**
 * Behavioral tests of the served script: a minimal fake DOM and a controllable
 * fetch replace the browser. The script is exercised as the client would run
 * it, using the service's actual response shapes — never a copy of its logic.
 */

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.textContent = '';
    this.listeners = {};
  }

  get textContent() {
    if (this._text !== '') return this._text;
    return this.children.map((child) => child.textContent).join('\n');
  }

  set textContent(value) {
    this._text = value; // assigning a string clears children, like the DOM
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }

  trigger(type, event) {
    this.listeners[type](event);
  }

  /** Walk every descendant element. */
  walk(visit) {
    for (const child of this.children) {
      visit(child);
      child.walk(visit);
    }
  }
}

function runApp() {
  const elements = {};
  const ids = ['signin', 'token', 'status', 'inbox', 'reload-sessions', 'session-list', 'session-detail'];
  for (const id of ids) elements[id] = new FakeElement('div');
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tagName) => new FakeElement(tagName),
  };
  const pendingFetches = [];
  const fetches = [];
  const fetch = (url, options) =>
    new Promise((resolve, reject) => {
      const entry = { url, options };
      fetches.push(entry);
      pendingFetches.push({
        entry,
        resolveJson: (body) => resolve({ ok: true, json: async () => body }),
        rejectError: (err) => reject(err),
      });
    });
  const sandbox = { document, fetch, Promise: global.Promise };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(PAGE_JS, sandbox, { filename: 'served-app.js' });
  return {
    elements,
    fetches,
    pending: pendingFetches,
    connect() {
      elements.token.value = 'page-token';
      elements.signin.trigger('submit', { preventDefault() {} });
    },
    select(id) {
      const row = elements['session-list'].children.find((child) =>
        child.children.some((line) => line.textContent.startsWith(id + ' '))
      );
      assert.ok(row, `session list has a row for ${id}`);
      row.trigger('click', {});
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('two sessions are listed with explicit statuses and either can be selected', async () => {
  const app = runApp();
  app.connect();
  assert.equal(app.pending.length, 1);
  assert.equal(app.fetches[0].url, '/sessions');
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'working', hasPendingQuestion: false },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();
  assert.equal(app.elements.status.textContent, 'connected');
  const rows = app.elements['session-list'].children;
  assert.match(rows[0].textContent, /session-1 — status: working/);
  assert.match(rows[1].textContent, /session-2 — status: needs-user/);
  assert.equal(app.elements['session-detail'].children.length, 0, 'nothing is shown before selection');

  // Select the second session and check what is rendered uses the API shape.
  app.select('session-2');
  assert.ok(app.fetches[1].url.endsWith('/sessions/session-2'), `selection reads that session: ${app.fetches[1].url}`);
  app.pending[1].resolveJson({
    sessionId: 'session-2',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-2', revision: 2, text: 'Proceed?', status: 'open' },
  });
  await flush();
  const detail = app.elements['session-detail'].textContent;
  assert.match(detail, /session: session-2/);
  assert.match(detail, /status: needs-user/);
  assert.match(detail, /open question: Proceed\? \(revision 2\)/);

  // Now select the other identifier: its own state replaces the panel.
  app.select('session-1');
  app.pending[2].resolveJson({ sessionId: 'session-1', status: 'working', activeQuestion: null });
  await flush();
  assert.match(app.elements['session-detail'].textContent, /status: working/);
  assert.match(app.elements['session-detail'].textContent, /no open question/);
  assert.ok(!app.elements['session-detail'].textContent.includes('session-2'), 'previous selection content is gone');
  assert.equal(app.elements['session-list'].children[0].className, 'selected', 'the selected row is marked');
  assert.equal(app.elements['session-list'].children[1].className, '', 'the other row is not marked');
});

test('switching clears content immediately and a slower earlier read cannot replace it', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'working', hasPendingQuestion: false },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: false },
    ],
  });
  await flush();

  // Select session-2 but hold its read response (a slow read).
  app.select('session-2');
  assert.equal(app.fetches[1].url, '/sessions/session-2');
  const cleared = app.elements['session-detail'].textContent;
  assert.ok(!cleared.includes('session-1'), `switching clears immediately, saw: ${cleared}`);
  assert.match(cleared, /loading session-2/);

  // Quickly select session-1, whose read comes back first.
  app.select('session-1');
  assert.equal(app.fetches[2].url, '/sessions/session-1');
  app.pending[2].resolveJson({ sessionId: 'session-1', status: 'working', activeQuestion: null });
  await flush();
  assert.match(app.elements['session-detail'].textContent, /session: session-1/);

  // Release the slower earlier read now — after the newer selection already
  // rendered. Without selection-identity/generation guarding it would paint
  // session-2 (the previous selection) over the current one.
  const lateEntry = app.pending[1];
  assert.equal(lateEntry.entry.url, '/sessions/session-2');
  lateEntry.resolveJson({ sessionId: 'session-2', status: 'needs-user', activeQuestion: null });
  await flush();
  const final = app.elements['session-detail'].textContent;
  assert.ok(!final.includes('session-2'), `late previous-selection result must be discarded, saw: ${final}`);
  assert.match(final, /session: session-1/);
  assert.equal(app.elements['session-list'].children[0].className, 'selected', 'selection stays on session-1');
  assert.equal(app.elements['session-list'].children[1].className, '', 'the other row is not marked');
});

test('session and question text rendered by the script is inert, not markup', async () => {
  const app = runApp();
  const hostileText = '<b>bold</b><script>alert(1)</script><img src=x>';
  app.connect();
  app.pending[0].resolveJson({
    sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }],
  });
  await flush();
  app.select('session-1');
  app.pending[1].resolveJson({
    sessionId: 'session-1',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-1', revision: 1, text: hostileText, status: 'open' },
  });
  await flush();
  const detail = app.elements['session-detail'];
  assert.match(detail.textContent, new RegExp(hostileText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'text is shown verbatim');
  detail.walk((node) => {
    assert.equal(node.tagName, 'div', 'only plain div elements are created, never parsed markup');
    assert.equal(node.children.length, 0, 'lines carry no child elements');
  });
});
