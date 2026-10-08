'use strict';

/**
 * The fixed first-party content of the local page. Two literal strings, no
 * file system, no external assets, no analytics. The page takes a local token
 * into memory and then renders a read-only view of the service's own API:
 * the session list, the selected session's explicit status, its pending
 * questions and a text panel for the selected question's text. There is no
 * reply composer yet, and every untrusted value reaches the page only through
 * textContent, never HTML parsing.
 */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agentspace (local)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, sans-serif; margin: 0; }
header, main { padding: 0.5rem 1rem; }
main { display: flex; gap: 2rem; }
main > section { flex: 1 1 0; min-width: 0; }
#context { white-space: pre-wrap; }
button:focus-visible, input:focus-visible { outline: 3px solid #056; outline-offset: 2px; }
@media (max-width: 40rem) {
  main { flex-direction: column; gap: 1rem; }
}
</style>
</head>
<body>
<header>
<h1>Agentspace</h1>
<form id="signin">
  <label for="token">Local token</label>
  <input id="token" type="password" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>
<p id="status" role="status"></p>
</header>
<main>
<section aria-labelledby="sessions-h">
  <h2 id="sessions-h">Sessions</h2>
  <button id="reload" type="button">Reload sessions</button>
  <p id="sessions-state" role="status"></p>
  <ul id="sessions"></ul>
</section>
<section aria-labelledby="session-h">
  <h2 id="session-h">Selected session</h2>
  <p id="session-state" role="status"></p>
  <h3 aria-labelledby="pending-h" id="pending-h">Pending questions</h3>
  <p id="pending-state" role="status"></p>
  <ul id="pending"></ul>
  <h3 id="context-heading">Question text</h3>
  <p id="context-state"></p>
  <pre id="context"></pre>
</section>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

const PAGE_JS = `'use strict';
(function () {
  // Memory only: the token lives in this variable and in the Authorization
  // header. It is never copied into a URL, browser storage, or any logging.
  var token = '';
  var selectedSessionId = null;
  var questionTexts = {};   // exact question id -> question text
  var selectedQuestionId = null;

  function el(id) { return document.getElementById(id); }
  function setPanel(id, text) { el(id).textContent = text; }
  function clearNode(node) { node.textContent = ''; }

  function headers() { return { authorization: 'Bearer ' + token }; }

  // Read-only client: every request here is a GET. No reply path exists yet.
  function fetchJson(path) {
    return fetch(path, { headers: headers() }).then(function (response) {
      if (!response.ok) throw new Error('status-' + response.status);
      return response.json();
    });
  }

  function labelledItem(list, label) {
    var item = document.createElement('li');
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;   // inert: server data is text, not markup
    item.appendChild(button);
    list.appendChild(item);
    return button;
  }

  // Data is keyed and selected by its exact identifiers; nothing here matches
  // on label text or reuses any value that was not fetched for this selection.
  function renderSessions(data) {
    var list = el('sessions');
    clearNode(list);
    var items = data.sessions;
    if (!items || items.length === 0) {
      setPanel('sessions-state', 'No sessions yet.');
      return;
    }
    setPanel('sessions-state', 'Sessions: choose one to read it.');
    items.forEach(function (session) {
      var suffix = session.hasPendingQuestion ? ', pending question' : '';
      var button = labelledItem(list, 'Session ' + session.sessionId + ' (' + session.status + suffix + ')');
      if (session.sessionId === selectedSessionId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', function () { openSession(session.sessionId); });
    });
  }

  function reloadSessions() {
    setPanel('sessions-state', 'Loading sessions…');
    fetchJson('/sessions').then(function (data) {
      renderSessions(data);
    }, function () {
      // A failed read shows no stale or partial list of sessions, and no
      // stale session detail can keep posing as current under a list that is
      // known to be out of date.
      clearNode(el('sessions'));
      setPanel('sessions-state', 'Could not load sessions. Showing none.');
      clearNode(el('pending'));
      setPanel('pending-state', '');
      questionTexts = {};
      setPanel('context', '');
      setPanel('context-state', '');
    });
  }

  function openSession(sessionId) {
    selectedSessionId = sessionId;
    selectedQuestionId = null;
    setPanel('session-state', 'Loading session…');
    setPanel('context', '');          // old question text must not survive
    setPanel('context-state', '');
    var wants = [
      fetchJson('/sessions/' + encodeURIComponent(sessionId)),
      fetchJson('/sessions/' + encodeURIComponent(sessionId) + '/questions/pending'),
    ];
    Promise.all(wants).then(function (readings) {
      if (selectedSessionId !== sessionId) return;   // selection changed mid-read
      var state = readings[0];
      setPanel('session-state', 'Session ' + state.sessionId + ' status: ' + state.status);
      renderQuestions(state, readings[1]);
    }, function () {
      if (selectedSessionId !== sessionId) return;
      // A failed read leaves nothing acting like current state.
      clearNode(el('pending'));
      setPanel('pending-state', 'Could not load this session. Showing no questions.');
      setPanel('session-state', 'Could not load session ' + sessionId + '. Showing no state.');
      questionTexts = {};
      setPanel('context', '');
      setPanel('context-state', '');
    });
  }

  function renderQuestions(state, pending) {
    var list = el('pending');
    clearNode(list);
    questionTexts = {};
    var questions = pending.questions;
    if (!questions || questions.length === 0) {
      setPanel('pending-state', 'No pending questions in this session.');
      setPanel('context-state', '');
      setPanel('context', '');
      return;
    }
    setPanel('pending-state', 'Pending questions: choose one to read it.');
    questions.forEach(function (question) {
      questionTexts[question.questionId] = question.text;
      var button = labelledItem(list, 'Question ' + question.questionId + ' (revision ' + question.revision + ')');
      if (question.questionId === selectedQuestionId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', function () { showQuestion(question.questionId); });
    });
    if (selectedQuestionId === null || !Object.prototype.hasOwnProperty.call(questionTexts, selectedQuestionId)) {
      selectedQuestionId = questions[0].questionId;
    }
    showQuestion(selectedQuestionId);
  }

  function showQuestion(questionId) {
    selectedQuestionId = questionId;
    setPanel('context-state', 'Text of question ' + questionId + ':');
    // textContent only: the question text is inert text in a <pre>.
    el('context').textContent = Object.prototype.hasOwnProperty.call(questionTexts, questionId)
      ? questionTexts[questionId]
      : '';
  }

  var signin = el('signin');
  signin.addEventListener('submit', function (event) {
    event.preventDefault();
    token = el('token').value;
    fetchJson('/sessions').then(function (data) {
      setPanel('status', 'connected');
      renderSessions(data);
    }, function () {
      setPanel('status', 'token rejected');
    });
  });
  el('reload').addEventListener('click', reloadSessions);
})();
`;

module.exports = { PAGE_HTML, PAGE_JS };
