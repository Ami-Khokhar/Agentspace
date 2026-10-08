'use strict';

/**
 * The fixed first-party content of the local page. Literal strings, no
 * file system, no external assets, no analytics. The page exists only for
 * bootstrap: it takes a local token into memory and uses it on the service's
 * own API. It then shows a read-only inbox: the session list with explicit
 * statuses, and selecting a session shows its state. Everything on the page
 * is rendered with textContent, so session/question text can never become
 * markup. Selecting a session also lists that session's pending questions
 * (never another session's), and selecting a question shows its exact
 * identity and text. There are no reply controls.
 */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agentspace (local)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>Agentspace</h1>
<form id="signin">
  <label for="token">Local token</label>
  <input id="token" type="password" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>
<p id="status" role="status"></p>
<section id="inbox" hidden>
  <h2>Sessions</h2>
  <button id="reload-sessions" type="button">Reload sessions</button>
  <div id="session-list"></div>
  <h2>Selected session</h2>
  <div id="session-detail"></div>
  <h2>Pending questions</h2>
  <div id="question-list"></div>
  <h2>Selected question</h2>
  <div id="question-detail"></div>
</section>
<script src="/app.js"></script>
</body>
</html>
`;

const PAGE_JS = `'use strict';
(function () {
  // Memory only: the token lives in this variable and in the Authorization
  // header. It is never copied into a URL, browser storage, or any logging.
  var token = '';
  var sessions = [];
  var selectedSessionId = null;
  // Each selection bumps this counter. Any read response from an earlier
  // selection (a late or reordered fetch) carries a stale counter and is
  // discarded, so it can never replace the currently selected content.
  var selectionGeneration = 0;
  var selectedQuestionId = null;
  // The same isolation for question rows: switching sessions bumps this, so
  // controls from a previous pending list can never act on the new state.
  var questionGeneration = 0;

  function el(id) { return document.getElementById(id); }

  // All dynamic content is added as a new node whose textContent is set:
  // labels from the service are inert data, never markup.
  function line(parent, text) {
    var node = document.createElement('div');
    node.textContent = String(text);
    parent.appendChild(node);
    return node;
  }

  function authHeaders() {
    return { headers: { authorization: 'Bearer ' + token } };
  }

  function loadSessions() {
    return fetch('/sessions', authHeaders())
      .then(function (response) {
        if (!response.ok) throw new Error('status-' + response.status);
        return response.json();
      })
      .then(function (body) {
        sessions = body.sessions;
        el('status').textContent = 'connected';
        renderSessionList();
      });
  }

  function renderSessionList() {
    var list = el('session-list');
    list.textContent = '';
    sessions.forEach(function (session) {
      var row = document.createElement('div');
      row.className = selectedSessionId === session.sessionId ? 'selected' : '';
      // The id and the explicit status from the API are inert text here.
      line(row, session.sessionId + ' — status: ' + session.status);
      row.addEventListener('click', function () { selectSession(session.sessionId); });
      list.appendChild(row);
    });
  }

  function renderQuestionList(questions) {
    var list = el('question-list');
    list.textContent = '';
    // Empty pending lists are explicit, and never reuse the previous
    // session's questions (clearing above already guarantees that).
    if (questions.length === 0) {
      line(list, selectedSessionId + ' has no pending questions');
      return;
    }
    var listGeneration = questionGeneration;
    questions.forEach(function (question) {
      var row = document.createElement('div');
      row.className = selectedQuestionId === question.questionId ? 'selected' : '';
      line(row, 'question: ' + question.questionId + ' — revision ' + question.revision);
      row.addEventListener('click', function () { selectQuestion(listGeneration, question); });
      list.appendChild(row);
    });
  }

  /**
   * Show one question's exact identity: session, question id, revision and
   * text — plain textContent only, no reply control.
   */
  function selectQuestion(listGeneration, question) {
    // A row from an abandoned list (session switched since, or a later list
    // rendered) is inert: it can never display another session's question.
    if (listGeneration !== questionGeneration || question.sessionId !== selectedSessionId) return;
    selectedQuestionId = question.questionId;
    var detail = el('question-detail');
    detail.textContent = '';
    line(detail, 'question: ' + question.questionId);
    line(detail, 'session: ' + question.sessionId);
    line(detail, 'revision: ' + question.revision);
    line(detail, 'text: ' + question.text);
  }

  function selectSession(sessionId) {
    selectionGeneration += 1;
    questionGeneration += 1; // stale question rows become inert immediately
    var gen = selectionGeneration;
    selectedSessionId = sessionId;
    selectedQuestionId = null;
    var detail = el('session-detail');
    // Clear immediately and synchronously: switching away must never leave
    // the previous session's content on screen, even before the replacement
    // read arrives.
    detail.textContent = '';
    line(detail, 'loading ' + sessionId + '…');
    var questionsList = el('question-list');
    questionsList.textContent = '';
    line(questionsList, 'loading pending questions…');
    el('question-detail').textContent = '';
    fetch('/sessions/' + encodeURIComponent(sessionId), authHeaders())
      .then(function (response) {
        if (!response.ok) throw new Error('status-' + response.status);
        return response.json();
      })
      .then(function (state) {
        if (gen !== selectionGeneration || selectedSessionId !== sessionId) return;
        renderSession(state);
        renderSessionList();
        // Pending questions are read under the same generation, so any
        // response for an earlier selection is discarded, not rendered.
        return fetch('/sessions/' + encodeURIComponent(sessionId) + '/questions/pending', authHeaders())
          .then(function (response) {
            if (!response.ok) throw new Error('status-' + response.status);
            return response.json();
          })
          .then(function (pending) {
            if (gen !== selectionGeneration || selectedSessionId !== sessionId) return;
            renderQuestionList(pending.questions);
          })
          .catch(function (err) {
            // Only the pending read's own panel is affected: a failure here
            // must not erase or mislabel the session state, which may have
            // rendered correctly already.
            if (gen !== selectionGeneration || selectedSessionId !== sessionId) return;
            questionsList.textContent = '';
            line(questionsList, 'could not load pending questions (' + err.message + ')');
          });
      })
      .catch(function (err) {
        if (gen !== selectionGeneration || selectedSessionId !== sessionId) return;
        detail.textContent = '';
        line(detail, 'could not load ' + sessionId + ' (' + err.message + ')');
      });
  }

  function renderSession(state) {
    var detail = el('session-detail');
    detail.textContent = '';
    line(detail, 'session: ' + state.sessionId);
    line(detail, 'status: ' + state.status);
    line(detail, state.activeQuestion
      ? 'open question: ' + state.activeQuestion.text + ' (revision ' + state.activeQuestion.revision + ')'
      : 'no open question');
  }

  function connect(event) {
    event.preventDefault();
    token = el('token').value;
    el('inbox').hidden = false;
    el('reload-sessions').addEventListener('click', function () {
      loadSessions().catch(function () { el('status').textContent = 'could not reload sessions'; });
    });
    loadSessions().catch(function () { el('status').textContent = 'token rejected'; });
  }

  el('signin').addEventListener('submit', connect);
})();
`;

module.exports = { PAGE_HTML, PAGE_JS };
