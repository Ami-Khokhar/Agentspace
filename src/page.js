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
 * identity and text, and offers a reply composer. Submitting captures the
 * question's session/question/revision and the typed text in one moment, so a
 * later selection change cannot redirect an in-flight reply; only one reply
 * may be in flight, and a 202 receipt is worded as acceptance for routing,
 * never as agent acknowledgement.
 */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agentspace (local)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, sans-serif; margin: 1rem; max-width: 60rem; }
#session-list > div, #question-list > div { padding: 0.4rem 0.5rem; }
.row { border: 1px solid #bbb; border-radius: 4px; margin: 0.25rem 0; cursor: pointer; }
:focus-visible { outline: 3px solid #0a66c2; outline-offset: 2px; }
.row.selected { border-color: #0a66c2; background: #eef5fc; }
#retry-reads { margin: 0.25rem 0 0.75rem; }
label { display: block; margin-bottom: 0.25rem; }
button { font: inherit; padding: 0.35rem 0.8rem; min-height: 44px; }
@media (max-width: 600px) {
  body { margin: 0.5rem; }
  #session-list > div, #question-list > div { padding: 0.75rem 0.5rem; }
}
</style>
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
  <button id="retry-reads" type="button">Retry latest read</button>
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
  // The question object whose composer is on screen; null after a session
  // switch. Submission snapshots it, so in-flight replies keep their target.
  var selectedQuestion = null;
  // While a reply fetch is in flight further submits do nothing.
  var replyPending = false;
  // The latest sessions-list failure, or null. A failure clears the list to
  // sessions = [], and no later successful read of something else (a session
  // selection) may re-render that empty array and wipe the honest label.
  var listError = null;

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
    // Label the wait and hold the reload control while the read is in
    // flight; only honest states, never leftover list content.
    el('reload-sessions').disabled = true;
    var list = el('session-list');
    list.textContent = '';
    line(list, 'loading sessions…');
    return fetch('/sessions', authHeaders())
      .then(function (response) {
        if (!response.ok) throw new Error('status-' + response.status);
        return response.json();
      })
      .then(function (body) {
        if (!body || !Array.isArray(body.sessions)) throw new Error('unexpected response');
        sessions = body.sessions;
        listError = null;
        el('status').textContent = 'connected';
        renderSessionList();
      })
      .catch(function (err) {
        sessions = [];
        listError = 'could not load sessions (' + err.message + ')';
        el('status').textContent = listError;
        list.textContent = '';
        line(list, 'could not load sessions (' + err.message + ')');
      })
      .then(function () { el('reload-sessions').disabled = false; });
  }

  function renderSessionList() {
    var list = el('session-list');
    list.textContent = '';
    // With a failed list read outstanding, sessions is empty: re-rendering
    // that array would paint a blank, unlabelled panel. Keep the failure
    // label; "Reload sessions" is the recovery path for the list itself.
    if (listError) {
      line(list, listError);
      return;
    }
    sessions.forEach(function (session) {
      var row = document.createElement('div');
      row.className = 'row' + (selectedSessionId === session.sessionId ? ' selected' : '');
      // The id and the explicit status from the API are inert text here.
      line(row, session.sessionId + ' — status: ' + session.status);
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Open session ' + session.sessionId + ', status ' + session.status);
      // Keyboard access matches pointer access (activation via click).
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectSession(session.sessionId);
        }
      });
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
      row.className = 'row' + (selectedQuestionId === question.questionId ? ' selected' : '');
      line(row, 'question: ' + question.questionId + ' — revision ' + question.revision);
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Open question ' + question.questionId + ' of session ' + question.sessionId);
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectQuestion(listGeneration, question);
        }
      });
      row.addEventListener('click', function () { selectQuestion(listGeneration, question); });
      list.appendChild(row);
    });
  }

  /**
   * Show one question's exact identity: session, question id, revision and
   * text — plain textContent only — plus a reply composer for exactly this
   * question.
   */
  function selectQuestion(listGeneration, question) {
    // A row from an abandoned list (session switched since, or a later list
    // rendered) is inert: it can never display another session's question.
    if (listGeneration !== questionGeneration || question.sessionId !== selectedSessionId) return;
    selectedQuestionId = question.questionId;
    selectedQuestion = question;
    var detail = el('question-detail');
    detail.textContent = '';
    line(detail, 'question: ' + question.questionId);
    line(detail, 'session: ' + question.sessionId);
    line(detail, 'revision: ' + question.revision);
    line(detail, 'text: ' + question.text);
    replyComposer(detail, question);
  }

  function replyComposer(detail, question) {
    line(detail, 'reply to this question:');
    var textArea = document.createElement('textarea');
    textArea.setAttribute('aria-label', 'Reply text for question ' + question.questionId);
    detail.appendChild(textArea);
    var sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.textContent = 'Send reply';
    var statusLine = document.createElement('div');
    statusLine.setAttribute('role', 'status');
    detail.appendChild(sendButton);
    detail.appendChild(statusLine);
    sendButton.addEventListener('click', function () {
      submitReply(question, textArea, sendButton, statusLine);
    });
  }

  /**
   * Submit one reply. Everything the request needs — target and text — is
   * captured here, before any await, so selection changes while the request
   * is in flight cannot change where it goes or what it says.
   */
  function submitReply(question, textArea, sendButton, statusLine) {
    var text = typeof textArea.value === 'string' ? textArea.value.trim() : '';
    // Reject before any request: an incomplete target or empty text must not
    // reach the service.
    if (!question || !question.sessionId || !question.questionId || question.revision === undefined) {
      statusLine.textContent = 'reply not sent: the question has no complete target (session, question, revision)';
      return;
    }
    if (text === '') {
      statusLine.textContent = 'reply not sent: type reply text first';
      return;
    }
    if (replyPending) return; // a second pending click makes no second request
    replyPending = true;
    sendButton.disabled = true;
    var revision = question.revision;
    var url = '/sessions/' + encodeURIComponent(question.sessionId) +
      '/questions/' + encodeURIComponent(question.questionId) + '/reply';
    statusLine.textContent = 'sending reply…';
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: revision, text: text }),
    })
      .then(function (response) {
        // Only 202 is acceptance. It never claims delivery or agent
        // acknowledgement: no agent receives input in this build.
        if (response.status !== 202) throw new Error('status-' + response.status);
        statusLine.textContent = 'reply accepted for routing';
      })
      .catch(function (err) {
        statusLine.textContent = 'reply not accepted (' + err.message + ')';
      })
      .then(function () {
        replyPending = false;
        sendButton.disabled = false;
      });
  }

  /**
   * Retry the reads of the current view (the selected session's state and
   * pending questions, or the session list): recovery from a failed read
   * without inventing content.
   */
  function retryReads() {
    if (selectedSessionId) selectSession(selectedSessionId);
    else loadSessions();
  }

  function selectSession(sessionId) {
    selectionGeneration += 1;
    questionGeneration += 1; // stale question rows become inert immediately
    var gen = selectionGeneration;
    selectedSessionId = sessionId;
    selectedQuestionId = null;
    selectedQuestion = null;
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
        line(detail, 'use "Retry latest read" to retry');
        // The pending-questions read depends on this one: keep its panel
        // labelled as unavailable rather than showing stale content.
        var questionsList = el('question-list');
        questionsList.textContent = '';
        line(questionsList, 'pending questions unavailable: the session read failed');
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
    el('reload-sessions').addEventListener('click', function () { loadSessions(); });
    el('retry-reads').addEventListener('click', function () { retryReads(); });
    loadSessions();
  }

  el('signin').addEventListener('submit', connect);
})();
`;

module.exports = { PAGE_HTML, PAGE_JS };
