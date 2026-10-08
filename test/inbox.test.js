'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PAGE_HTML, PAGE_JS } = require('../src/page');

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

  getAttribute(name) {
    return (this._attrs || {})[name] !== undefined ? this._attrs[name] : null;
  }

  setAttribute(name, value) {
    if (!this._attrs) this._attrs = {};
    this._attrs[name] = String(value);
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
  const ids = ['signin', 'token', 'status', 'inbox', 'reload-sessions', 'retry-reads', 'session-list', 'session-detail', 'question-list', 'question-detail'];
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
        // Raw response control, for reply receipts where the status code is
        // the payload (202 is the only acceptance signal the page looks at).
        resolveRaw: (response) => resolve(response),
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
    selectQuestion(id) {
      const row = elements['question-list'].children.find((child) =>
        child.children.some((line) => line.textContent.startsWith('question: ' + id + ' '))
      );
      assert.ok(row, `pending question list has a row for ${id}`);
      row.trigger('click', {});
    },
  };
}

test('the first sessions read shows honest loading and error states and can recover', async () => {
  const app = runApp();
  app.connect();
  // While the read is outstanding the section holds its own loading state,
  // not stale content from an earlier state.
  assert.match(app.elements['session-list'].textContent, /loading sessions/);
  assert.equal(app.elements['reload-sessions'].disabled, true, 'the reload control is held while the read is in flight');

  // A failing read is labelled where the user looks, and leaves nothing that
  // could be mistaken for the current list.
  app.pending[0].rejectError(new Error('status-500'));
  await flush();
  const failed = app.elements['session-list'].textContent;
  assert.match(failed, /could not load sessions \(status-500\)/);
  assert.ok(!failed.includes('loading sessions'), 'the loading state is replaced by the error');
  assert.match(app.elements['status'].textContent, /could not load sessions \(status-500\)/);
  assert.equal(app.elements['reload-sessions'].disabled, false, 'recovery is possible again');
  assert.equal(app.elements.status.textContent, 'could not load sessions (status-500)');
  assert.equal(app.elements['session-list'].children.length, 1, 'one honest status line, no stale rows');

  // The retry button re-reads and shows the real sessions.
  app.elements['retry-reads'].trigger('click', {});
  assert.equal(app.pending.length, 2);
  app.pending[1].resolveJson({ sessions: [{ sessionId: 'session-1', status: 'working', hasPendingQuestion: false }] });
  await flush();
  assert.match(app.elements['session-list'].textContent, /session-1 — status: working/);
  assert.ok(!app.elements['session-list'].textContent.includes('could not load sessions'), 'the error is gone');
  assert.equal(app.elements.status.textContent, 'connected');
});

test('a failed session state read labels the failure and a retry recovers', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }],
  });
  await flush();

  app.select('session-1');
  app.pending[1].rejectError(new Error('status-503'));
  await flush();
  const failed = app.elements['session-detail'].textContent;
  assert.match(failed, /could not load session-1 \(status-503\)/);
  assert.ok(!failed.includes('needs-user'), 'no stale status is presented as current');
  const list = app.elements['question-list'].textContent;
  assert.match(list, /pending questions unavailable/);
  assert.ok(!list.includes('loading pending questions'), 'no fake loading state after the dependent read is cancelled');
  assert.ok(!list.includes('question:'), 'no stale pending question is shown after a failed read');

  // Retrying re-reads only the current selection's own endpoints.
  app.elements['retry-reads'].trigger('click', {});
  assert.equal(app.pending[2].entry.url, '/sessions/session-1', 'the retry re-reads the selected session');
  assert.equal(app.pending.length, 3);
  app.pending[2].resolveJson({
    sessionId: 'session-1',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-1', revision: 1, text: 'now loaded?', status: 'open' },
  });
  await flush();
  app.pending[3].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'now loaded?' }] });
  await flush();
  assert.match(app.elements['session-detail'].textContent, /open question: now loaded\? \(revision 1\)/);
  assert.match(app.elements['question-list'].textContent, /question: question-1 — revision 1/);
});

test('a retry after a failed pending read succeeds and shows the real questions', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [{ sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true }],
  });
  await flush();
  app.select('session-2');
  app.pending[1].resolveJson({ sessionId: 'session-2', status: 'needs-user', activeQuestion: null });
  await flush();
  app.pending[2].rejectError(new Error('status-500'));
  await flush();
  assert.ok(!app.elements['question-list'].textContent.includes('loading pending questions'), 'no loading content remains');
  assert.ok(!app.elements['question-list'].textContent.includes('question:'), 'no unrelated question is shown as current');
  assert.match(app.elements['session-detail'].textContent, /session: session-2/);

  app.elements['retry-reads'].trigger('click', {});
  assert.equal(app.pending[3].entry.url, '/sessions/session-2');
  app.pending[3].resolveJson({ sessionId: 'session-2', status: 'needs-user', activeQuestion: null });
  await flush();
  app.pending[4].resolveJson({ questions: [{ sessionId: 'session-2', questionId: 'question-9', revision: 4, text: 'recovered?' }] });
  await flush();
  assert.match(app.elements['question-list'].textContent, /question: question-9 — revision 4/);
  assert.ok(!app.elements['question-list'].textContent.includes('pending questions unavailable'), 'recovery replaces the unavailable label');
  // Every read is still a plain GET of a service read endpoint.
  for (const f of app.fetches) {
    assert.ok(/^(\/sessions|\/questions)/.test(f.url), `only service reads are requested, saw ${f.url}`);
  }
});

test('session and question rows are keyboard-operable and labelled', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'working', hasPendingQuestion: false },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();

  // Both rows are labelled and keyboard accessible.
  for (const row of app.elements['session-list'].children) {
    assert.equal(row.tabIndex, 0, 'a session row is in the keyboard tab order');
    assert.equal(row.getAttribute('role'), 'button');
    assert.match(row.getAttribute('aria-label'), /Open session session-[12], status /);
  }

  // Keyboard activation selects the session, like clicking.
  const row2 = app.elements['session-list'].children[1];
  row2.trigger('keydown', { key: ' ', preventDefault() {} });
  assert.ok(app.fetches[1].url.endsWith('/sessions/session-2'), 'Enter/space opens the named session');
  row2.trigger('keydown', { key: 'Tab', preventDefault() {} });
  assert.equal(app.fetches.length, 2, 'non-activation keys do nothing');

  app.pending[1].resolveJson({ sessionId: 'session-2', status: 'needs-user', activeQuestion: null });
  await flush();
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-2', questionId: 'question-2', revision: 2, text: 'Proceed?' }] });
  await flush();
  const questionRow = app.elements['question-list'].children.find((child) =>
    child.getAttribute('aria-label') === 'Open question question-2 of session session-2'
  );
  assert.ok(questionRow, 'the pending question row is labelled with its exact identity');
  assert.equal(questionRow.tabIndex, 0);
  questionRow.trigger('keydown', { key: 'Enter', preventDefault() {} });
  assert.match(app.elements['question-detail'].textContent, /text: Proceed\?/);
});

test('the page exposes labelled controls, visible-focus and narrow-screen CSS', async () => {
  // The sign-in control has a real <label>; read rows use explicit labels.
  assert.match(PAGE_HTML, /<label for="token">Local token<\/label>/);
  assert.match(PAGE_HTML, /id="retry-reads" type="button">Retry latest read</);
  assert.match(PAGE_HTML, /id="reload-sessions" type="button">Reload sessions</);
  // Visible keyboard focus and a narrow-screen adjustment are in the page,
  // not left to unreliable browser defaults.
  assert.match(PAGE_HTML, /:focus-visible \{ outline: 3px solid/);
  assert.match(PAGE_HTML, /@media \(max-width: 600px\)/);
  // No inline one-off styles that could unbalance the stylesheet.
  assert.ok(!PAGE_HTML.includes('style='), 'styling stays in the stylesheet, not inline attributes');
});

test('a failed session-list label survives a later successful selection read and the list itself can recover', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [{ sessionId: 'session-1', status: 'working', hasPendingQuestion: false }],
  });
  await flush();

  // Select the session fully, then fail a reload of the list.
  app.select('session-1');
  app.pending[1].resolveJson({ sessionId: 'session-1', status: 'working', activeQuestion: null });
  await flush();
  app.pending[2].resolveJson({ questions: [] });
  await flush();

  app.elements['reload-sessions'].trigger('click', {});
  app.pending[3].rejectError(new Error('status-500'));
  await flush();
  assert.match(app.elements['session-list'].textContent, /could not load sessions \(status-500\)/);

  // "Retry latest read" re-runs the selection reads only; that success must
  // not re-render the empty list array and erase the failed read's label.
  app.elements['retry-reads'].trigger('click', {});
  app.pending[4].resolveJson({
    sessionId: 'session-1',
    status: 'working',
    activeQuestion: { questionId: 'question-1', revision: 1, text: 'still here?', status: 'open' },
  });
  await flush();
  app.pending[5].resolveJson({ questions: [] });
  await flush();
  const list = app.elements['session-list'].textContent;
  assert.match(list, /could not load sessions \(status-500\)/, 'the failed list read keeps its own honest label');
  assert.ok(!list.includes('loading sessions'), 'no fake loading state covers the failure');
  const detail = app.elements['session-detail'].textContent;
  assert.match(detail, /session: session-1/);
  assert.equal(app.fetches[app.fetches.length - 1].url, '/sessions/session-1/questions/pending', 'the retry re-reads the selection, not the list');

  // The documented recovery path for the list is reloading it.
  app.elements['reload-sessions'].trigger('click', {});
  app.pending[6].resolveJson({
    sessions: [{ sessionId: 'session-1', status: 'working', hasPendingQuestion: false }],
  });
  await flush();
  const recovered = app.elements['session-list'].textContent;
  assert.match(recovered, /session-1 — status: working/);
  assert.ok(!recovered.includes('could not load sessions'), 'a successful reload clears the old error');
});

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
  // The session state read also triggers that session's pending-question read.
  assert.equal(app.fetches[2].url, '/sessions/session-2/questions/pending', 'selection reads that session’s own pending questions');
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-2', questionId: 'question-2', revision: 2, text: 'Proceed?' }] });
  await flush();
  assert.match(app.elements['question-list'].textContent, /question: question-2 — revision 2/);
  assert.ok(!app.elements['question-list'].textContent.includes('session-1'), 'the list is scoped to the selected session');

  // Select a question: the exact identity of that question is shown.
  app.selectQuestion('question-2');
  const questionDetail = app.elements['question-detail'].textContent;
  assert.match(questionDetail, /question: question-2/);
  assert.match(questionDetail, /session: session-2/);
  assert.match(questionDetail, /revision: 2/);
  assert.match(questionDetail, /text: Proceed\?/);

  // Now select the other identifier: its own state replaces the panel.
  app.select('session-1');
  app.pending[3].resolveJson({ sessionId: 'session-1', status: 'working', activeQuestion: null });
  await flush();
  assert.match(app.elements['session-detail'].textContent, /status: working/);
  assert.match(app.elements['session-detail'].textContent, /no open question/);
  assert.ok(!app.elements['session-detail'].textContent.includes('session-2'), 'previous selection content is gone');
  assert.ok(!app.elements['question-detail'].textContent.includes('question-2'), 'the question panel is cleared when the session changes');
  assert.match(app.elements['question-list'].textContent, /loading pending questions/);
  assert.equal(app.elements['session-list'].children[0].className.includes('selected'), true, 'the selected row is marked');
  assert.equal(app.elements['session-list'].children[1].className.includes('selected'), false, 'the other row is not marked');
  // Its own pending read shows an explicit empty state, never session-2's list.
  assert.equal(app.fetches[4].url, '/sessions/session-1/questions/pending');
  app.pending[4].resolveJson({ questions: [] });
  await flush();
  assert.match(app.elements['question-list'].textContent, /session-1 has no pending questions/);
  assert.ok(!app.elements['question-list'].textContent.includes('question-2', "the previous session's questions are not reused"));
});

test('a question selection shows its exact identity and never sends a reply request', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();

  // Session-1 has its own question with its own identity.
  app.select('session-1');
  app.pending[1].resolveJson({
    sessionId: 'session-1',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-1', revision: 1, text: 'session one question?', status: 'open' },
  });
  await flush();
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'session one question?' }] });
  await flush();
  app.selectQuestion('question-1');
  const first = app.elements['question-detail'].textContent;
  assert.match(first, /question: question-1/);
  assert.match(first, /session: session-1/);
  assert.match(first, /revision: 1/);
  assert.match(first, /text: session one question\?/);

  // The second session's question is never shown under the first selection.
  app.select('session-2');
  app.pending[3].resolveJson({
    sessionId: 'session-2',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-2', revision: 2, text: 'session two question?', status: 'open' },
  });
  await flush();
  app.pending[4].resolveJson({ questions: [{ sessionId: 'session-2', questionId: 'question-2', revision: 2, text: 'session two question?' }] });
  await flush();
  app.selectQuestion('question-2');
  const second = app.elements['question-detail'].textContent;
  assert.match(second, /question: question-2/);
  assert.match(second, /session: session-2/);
  assert.match(second, /text: session two question\?/);
  assert.ok(!second.includes('session one question'), "no other session's question text remains");

  // Read-only: every request is a GET of a read endpoint, never a reply.
  for (const f of app.fetches) {
    assert.equal(f.options.method, undefined, `every request is a GET, saw ${f.options.method} ${f.url}`);
    assert.ok(!/\/reply/.test(f.url), `no reply request is ever made, saw ${f.url}`);
    assert.ok(/^(\/sessions|\/questions)/.test(f.url), `only service reads are requested, saw ${f.url}`);
  }
  assert.equal(app.fetches.length, 5, 'each selection reads exactly its state and its pending questions');
});

test('delayed reads and stale question controls cannot display a previous session\u0027s questions', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();

  // Load session-1 fully but hold its pending-question read.
  app.select('session-1');
  app.pending[1].resolveJson({
    sessionId: 'session-1',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-1', revision: 1, text: 'session one pending?', status: 'open' },
  });
  await flush();
  assert.equal(app.fetches[2].url, '/sessions/session-1/questions/pending');
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'session one pending?' }] });
  await flush();
  // Select and verify session-1's question, and keep its row element: after
  // switching, it becomes a stale control from a previous selection.
  app.selectQuestion('question-1');
  assert.match(app.elements['question-detail'].textContent, /session: session-1/);
  const staleRow = app.elements['question-list'].children.find((child) =>
    child.children.some((line) => line.textContent.startsWith('question: question-1 '))
  );
  assert.ok(staleRow, 'session-1 has a pending question row before the switch');

  // Now switch to session-2 and hold its reads; click the stale control.
  app.select('session-2');
  assert.match(app.elements['question-list'].textContent, /loading pending questions/);
  assert.equal(app.elements['question-detail'].textContent, '', 'the question panel is cleared immediately');
  staleRow.trigger('click', {}); // stale control from session-1's list
  assert.ok(!app.elements['question-detail'].textContent.includes('session one pending'), 'a stale question control is inert');

  // Session-2's reads resolve first, out of order relative to session-1's.
  app.pending[3].resolveJson({
    sessionId: 'session-2',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-2', revision: 2, text: 'session two pending?', status: 'open' },
  });
  await flush();
  assert.equal(app.fetches[4].url, '/sessions/session-2/questions/pending');

  // Start a third selection (back to session-1) while session-2's pending
  // read is still outstanding, then resolve the OLD reads out of order.
  app.select('session-1');
  app.pending[4].resolveJson({ questions: [{ sessionId: 'session-2', questionId: 'question-2', revision: 2, text: 'session two pending?' }] });
  await flush();
  const shuffled = app.elements['question-list'].textContent;
  assert.ok(!shuffled.includes('session two pending'), `late old-selection pending rendered, saw: ${shuffled}`);
  assert.ok(!app.elements['question-detail'].textContent.includes('session two pending'), 'no discarded pending read drives the question panel');
  assert.match(shuffled, /loading pending questions/, 'the current selection keeps its own loading state');

  // The current selection completes; the resolved old question-2 read stays
  // discarded while session-1's questions come back.
  app.pending[5].resolveJson({ sessionId: 'session-1', status: 'needs-user', activeQuestion: null });
  await flush();
  app.pending[6].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 3, text: 'session one pending again?' }] });
  await flush();
  const finalList = app.elements['question-list'].textContent;
  assert.ok(!finalList.includes('session two pending'), `discarded pending read leaked, saw: ${finalList}`);
  assert.match(finalList, /question: question-1 — revision 3/, "the current session's questions are shown");
  staleRow.trigger('click', {}); // the old session-1 row from the first load
  assert.ok(!app.elements['question-detail'].textContent.includes('session one pending?'), 'a stale question control is inert');
  app.selectQuestion('question-1');
  assert.match(app.elements['question-detail'].textContent, /session: session-1/);
  assert.match(app.elements['question-detail'].textContent, /text: session one pending again\?/);
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
  app.pending[3].resolveJson({ questions: [] });
  await flush();
  assert.match(app.elements['question-list'].textContent, /session-1 has no pending questions/);

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
  assert.ok(app.elements['session-list'].children[0].className.includes('selected'), 'selection stays on session-1');
  assert.ok(!app.elements['session-list'].children[1].className.includes('selected'), 'the other row is not marked');
});

test('a failing pending-questions read leaves the session state intact and labels the right read', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();
  app.select('session-1');
  app.pending[1].resolveJson({
    sessionId: 'session-1',
    status: 'needs-user',
    activeQuestion: { questionId: 'question-1', revision: 1, text: 'help?', status: 'open' },
  });
  await flush();

  // The pending read fails (bad status). It must not erase the session state
  // that just rendered, and the error must name the pending read, not the
  // session which actually loaded.
  assert.equal(app.fetches[2].url, '/sessions/session-1/questions/pending');
  app.pending[2].rejectError(new Error('status-500'));
  await flush();
  const detail = app.elements['session-detail'].textContent;
  assert.match(detail, /session: session-1/, `session detail keeps its state, saw: ${detail}`);
  assert.match(detail, /status: needs-user/);
  assert.match(detail, /open question: help\?/);
  assert.ok(!detail.includes('could not load'), `no session-load error is invented, saw: ${detail}`);
  const list = app.elements['question-list'].textContent;
  assert.match(list, /could not load pending questions \(status-500\)/);
  assert.ok(!list.includes('loading pending questions'), 'the loading state is replaced by the error');

  // A failing session state read still reports against that read only.
  app.select('session-2');
  app.pending[3].rejectError(new Error('status-401'));
  await flush();
  assert.match(app.elements['session-detail'].textContent, /could not load session-2 \(status-401\)/);
  const list2 = app.elements['question-list'].textContent;
  assert.match(list2, /pending questions unavailable/, 'the dependent read is labelled unavailable, not shown as loading');
  assert.ok(!list2.includes('question:'), 'and no stale question is presented as current');
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

  // The selected question's context text is equally inert.
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 1, text: hostileText }] });
  await flush();
  app.selectQuestion('question-1');
  const questionDetail = app.elements['question-detail'];
  assert.match(questionDetail.textContent, new RegExp(hostileText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'question text is shown verbatim');
  questionDetail.walk((node) => {
    assert.ok(['div', 'textarea', 'button'].includes(node.tagName), 'only plain div lines plus the composer controls are created, never parsed markup');
    if (node.tagName === 'div') assert.equal(node.children.length, 0, 'text lines carry no child elements');
  });
});

function selectLoadedQuestion(app, session, question) {
  app.select(session);
  // findLast: if the same read was made before (an earlier composer test
  // step), the first promise is already settled, so target the newest one.
  const detail = app.pending.findLast((p) => p.entry.url === '/sessions/' + session);
  detail.resolveJson({ sessionId: session, status: 'needs-user', activeQuestion: null });
  return flush().then(() => {
    const pendingRead = app.pending.findLast((p) => p.entry.url === '/sessions/' + session + '/questions/pending');
    pendingRead.resolveJson({ questions: Array.isArray(question) ? question : [question] });
    return flush();
  });
}

function composerOf(app) {
  const detail = app.elements['question-detail'];
  const textArea = detail.children.find((n) => n.tagName === 'textarea');
  const sendButton = detail.children.find((n) => n.tagName === 'button');
  const statusLine = detail.children[detail.children.length - 1];
  assert.ok(textArea && sendButton && statusLine, 'the composer has a text field, a send button and a status line');
  return { textArea, sendButton, statusLine };
}

function replyCount(app) {
  return app.fetches.filter((f) => /\/reply$/.test(f.url)).length;
}

test('a submitted reply keeps its captured target when the selection changes', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({
    sessions: [
      { sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true },
      { sessionId: 'session-2', status: 'needs-user', hasPendingQuestion: true },
    ],
  });
  await flush();
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-1', revision: 3, text: 'go ahead?' });
  app.selectQuestion('question-1');

  const { textArea, sendButton, statusLine } = composerOf(app);
  textArea.value = '  yes, proceed  ';
  sendButton.trigger('click', {});
  await flush();

  // The request is built at submission, from the submitted question only.
  const reply = app.fetches.find((f) => /\/reply$/.test(f.url));
  assert.equal(reply.url, '/sessions/session-1/questions/question-1/reply', 'the reply names the exact session and question');
  assert.equal(reply.options.method, 'POST');
  assert.equal(reply.options.headers.authorization, 'Bearer page-token');
  assert.deepEqual(JSON.parse(reply.options.body), { revision: 3, text: 'yes, proceed' }, 'revision and text are captured at submission');
  assert.match(statusLine.textContent, /sending reply/);
  assert.equal(sendButton.disabled, true, 'the send button is held while the reply is in flight');

  // Switch the selection while the reply is unresolved: the request must not
  // be redirected to the new selection.
  app.select('session-2');
  app.pending.find((p) => p.entry.url === '/sessions/session-2').resolveJson({ sessionId: 'session-2', status: 'needs-user', activeQuestion: null });
  await flush();
  const pendingReply = app.pending.find((p) => p.entry.url === '/sessions/session-1/questions/question-1/reply');
  assert.equal(JSON.parse(pendingReply.entry.options.body).revision, 3, 'the in-flight body still carries the original revision');
  pendingReply.resolveJson({ ok: true, status: 202, json: async () => ({ accepted: true }) });
  await flush();
  assert.equal(replyCount(app), 1, 'exactly one reply was submitted');
});

test('a second submit while a reply is pending makes no second request', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({ sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }] });
  await flush();
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'ready?' });
  app.selectQuestion('question-1');
  const { textArea, sendButton } = composerOf(app);
  textArea.value = 'first';
  sendButton.trigger('click', {});
  await flush();

  assert.equal(replyCount(app), 1);
  textArea.value = 'second';
  sendButton.trigger('click', {}); // duplicate click while still pending
  await flush();
  assert.equal(replyCount(app), 1, 'the pending submit cannot generate a second request');
  const sent = JSON.parse(app.fetches.find((f) => /\/reply$/.test(f.url)).options.body);
  assert.equal(sent.text, 'first', 'the edited text never became a second request');
  assert.equal(sendButton.disabled, true);

  app.pending.find((p) => /\/reply$/.test(p.entry.url)).resolveRaw({ status: 202 });
  await flush();
  assert.equal(sendButton.disabled, false, 'submitting is possible again once the reply settles');
});

test('a 202 receipt is worded as acceptance for routing, never as delivery', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({ sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }] });
  await flush();
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-1', revision: 2, text: 'there?' });
  app.selectQuestion('question-1');
  const { textArea, sendButton, statusLine } = composerOf(app);
  textArea.value = 'ack';
  sendButton.trigger('click', {});
  await flush();
  app.pending.find((p) => /\/reply$/.test(p.entry.url)).resolveRaw({ status: 202 });
  await flush();

  assert.match(statusLine.textContent, /accepted for routing/, 'acceptance is named for what it is');
  assert.ok(!/deliver|acknowledg/i.test(statusLine.textContent), 'no delivered or acknowledged claim is made');
});

test('a failed reply is labelled and submitting is restored', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({ sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }] });
  await flush();
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'there?' });
  app.selectQuestion('question-1');
  const { textArea, sendButton, statusLine } = composerOf(app);
  textArea.value = 'retry me';
  sendButton.trigger('click', {});
  await flush();
  app.pending.find((p) => /\/reply$/.test(p.entry.url)).rejectError(new Error('status-500'));
  await flush();
  assert.match(statusLine.textContent, /reply not accepted \(status-500\)/);
  assert.equal(sendButton.disabled, false, 'the failure leaves the composer usable');
});

test('incomplete or blank replies send nothing and name the problem', async () => {
  const app = runApp();
  app.connect();
  app.pending[0].resolveJson({ sessions: [{ sessionId: 'session-1', status: 'needs-user', hasPendingQuestion: true }] });
  await flush();

  // A question row whose data has no revision cannot be replied to.
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-9', text: 'revision missing?' });
  app.selectQuestion('question-9');
  let composer = composerOf(app);
  composer.textArea.value = 'wants to answer';
  composer.sendButton.trigger('click', {});
  await flush();
  assert.equal(replyCount(app), 0, 'no reply is sent without a revision');
  assert.match(composer.statusLine.textContent, /reply not sent: the question has no complete target/);

  // Reload with a real question; blank and whitespace-only text are rejected.
  await selectLoadedQuestion(app, 'session-1', { sessionId: 'session-1', questionId: 'question-1', revision: 1, text: 'there?' });
  app.selectQuestion('question-1');
  composer = composerOf(app);
  composer.textArea.value = '   ';
  composer.sendButton.trigger('click', {});
  await flush();
  assert.equal(replyCount(app), 0, 'no reply is sent for blank text');
  assert.match(composer.statusLine.textContent, /reply not sent: type reply text first/);
});
