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
  const ids = ['signin', 'token', 'status', 'inbox', 'reload-sessions', 'session-list', 'session-detail', 'question-list', 'question-detail'];
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
    selectQuestion(id) {
      const row = elements['question-list'].children.find((child) =>
        child.children.some((line) => line.textContent.startsWith('question: ' + id + ' '))
      );
      assert.ok(row, `pending question list has a row for ${id}`);
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
  assert.equal(app.elements['session-list'].children[0].className, 'selected', 'the selected row is marked');
  assert.equal(app.elements['session-list'].children[1].className, '', 'the other row is not marked');
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

  // The selected question's context text is equally inert.
  app.pending[2].resolveJson({ questions: [{ sessionId: 'session-1', questionId: 'question-1', revision: 1, text: hostileText }] });
  await flush();
  app.selectQuestion('question-1');
  const questionDetail = app.elements['question-detail'];
  assert.match(questionDetail.textContent, new RegExp(hostileText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'question text is shown verbatim');
  questionDetail.walk((node) => {
    assert.equal(node.tagName, 'div', 'only plain div elements are created, never parsed markup');
    assert.equal(node.children.length, 0, 'lines carry no child elements');
  });
});
