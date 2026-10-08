'use strict';

/**
 * The fixed first-party content of the local page. Literal strings, no
 * file system, no external assets, no analytics. The page exists only for
 * bootstrap: it takes a local token into memory and uses it on the service's
 * own API. It then shows a read-only inbox: the session list with explicit
 * statuses, and selecting a session shows its state. Everything on the page
 * is rendered with textContent, so session/question text can never become
 * markup. There are no reply controls and no questions panel.
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

  function selectSession(sessionId) {
    selectionGeneration += 1;
    var gen = selectionGeneration;
    selectedSessionId = sessionId;
    var detail = el('session-detail');
    // Clear immediately and synchronously: switching away must never leave
    // the previous session's content on screen, even before the replacement
    // read arrives.
    detail.textContent = '';
    line(detail, 'loading ' + sessionId + '…');
    fetch('/sessions/' + encodeURIComponent(sessionId), authHeaders())
      .then(function (response) {
        if (!response.ok) throw new Error('status-' + response.status);
        return response.json();
      })
      .then(function (state) {
        if (gen !== selectionGeneration || selectedSessionId !== sessionId) return;
        renderSession(state);
        renderSessionList();
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
