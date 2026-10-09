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
 * later selection change cannot redirect an in-flight reply; each
 * composer allows at most one reply in flight (a second submit from the same
 * button makes no second request and says why), and a hung reply can never
 * refuse replies elsewhere on the page. Typed text is kept as a memory-only
 * draft bound to the exact question identity (session, question id, revision):
 * it survives selection changes and failed submits, is never copied to or
 * silently rebound onto another question or revision, and dies with the tab.
 * A 409 (stale revision or superseded question) blocks that composer until
 * the pending questions are re-read and the refreshed question is selected;
 * nothing is resent against a newer revision silently. A 202 receipt is
 * worded as acceptance for routing — accepted, explicitly not delivered —
 * never as agent acknowledgement. Each reply carries a receipt bound to the
 * exact question identity; a receipt shows 'accepted, unacknowledged' until
 * an acknowledgement matching the exact session/question/revision/receipt
 * identity arrives, and an acknowledged receipt is labelled '#acknowledged'.
 */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agentspace (local)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  /* Six colour tokens of the precision desk: one pale focal surface on a
     slate frame — no gradients, no card wall, no all-caps labelling. */
  --frame: #202D3A;
  --rail: #293B4B;
  --question-surface: #F5F7FA;
  --ink: #172638;
  --ink-secondary: #58697A;
  --action: #265CD8;
  --ok: #1e6b45;
  --warn: #8a4b00;
  /* Local system sans (SF system where available), 13/15/20/28 px scale. */
  --type-xs: 13px;
  --type-base: 15px;
  --type-lead: 20px;
  --type-display: 28px;
  --space-1: 0.375rem;
  --space-2: 0.625rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --radius: 8px;
/* Restrained motion only: every transition is under 200ms and touches no
   layout property, so reading targets never shift while an animation runs.
   Motion answers actions only — selection, panel entry and the reply-context
   reveal — and never runs on page load or as ambient progress. */
   --motion-fast: 120ms;
   --motion-panel: 160ms;
}
* { box-sizing: border-box; }
/* Author rules like #desk { display: grid } would otherwise beat the UA
   stylesheet's [hidden] { display: none } and show the app from page load,
   before any token sign-in; this explicit override keeps the attribute
   authoritative no matter which display rule targets the element. */
[hidden] { display: none !important; }
body {
  font-family: ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  font-size: var(--type-base);
  line-height: 1.55;
  margin: 0;
  background: var(--frame);
  color: var(--question-surface);
}
/* Left-aligned compact header: the frame's quiet masthead, not a hero band. */
#desk-head { padding: var(--space-3) var(--space-4) var(--space-1); }
#desk-head h1 {
  font-size: var(--type-lead);
  font-weight: 600;
  margin: 0;
  color: var(--question-surface);
}
#desk-head .desk-tag {
  display: block;
  font-size: var(--type-xs);
  color: var(--ink-secondary);
}
#signin { padding: var(--space-2) var(--space-4) 0; max-width: 24rem; }
#signin label {
  display: block;
  font-size: var(--type-xs);
  color: var(--question-surface);
  margin-bottom: var(--space-1);
}
#signin input {
  font: inherit;
  color: var(--ink);
  background: var(--question-surface);
  border: 1px solid var(--rail);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
#signin button { margin-top: var(--space-2); }
#desk {
  /* The desk is the two-column grid: the stable 220px session rail and the
     pale question workspace are #desk's direct children, so the columns
     hold exactly them. */
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: stretch;
  padding: var(--space-3) var(--space-4) var(--space-4);
}
/* Question workspace: the one memorable pale focal surface of the desk. */
#work-panel {
  min-width: 0;
  background: var(--question-surface);
  color: var(--ink);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
/* Session rail records: quiet identifiers on the deeper slate. */
#session-rail { display: flex; flex-direction: column; min-width: 0; }
#session-list { display: flex; flex-direction: column; gap: 2px; }
.row {
  transition: border-color var(--motion-fast) ease-out, background-color var(--motion-fast) ease-out;
}
/* Selection colours change instantly only where reduced motion removes the
   transition; the colors themselves never depend on animation. */
.row:focus-visible { border-color: var(--action); }
/* Subtle panel entrance tied to the current selection: content is already
   correct before the animation starts, it only fades/slides in from a small
   offset — never from, or through, another session's content. */
.entering { animation: panel-enter var(--motion-panel) ease-out; }
@keyframes panel-enter {
  from { opacity: 0.4; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
/* Honest feedback states on the reply status line, distinct in text (the
   wording stays exact) and additionally signalled with colour. */
.reply-status.pending { color: var(--warn); }
.reply-status.accepted { color: var(--ok); }
.reply-status.refused { color: var(--warn); }
@media (prefers-reduced-motion: reduce) {
  .row { transition: none; }
  .entering { animation: none; }
}
/* Rail rows sit directly on the rail surface — list records, not cards. */
#session-list .row {
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--question-surface);
}
#session-list .row:hover { border-color: var(--ink-secondary); }
#session-list .row.selected {
  border-color: var(--action);
  background: rgba(38, 92, 216, 0.3);
  color: var(--question-surface);
}
h2 {
  font-size: var(--type-xs);
  font-weight: 600;
  color: var(--ink-secondary);
  margin: var(--space-3) 0 var(--space-2);
}
#question-detail, #session-detail, #question-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* The real question text leads the pale surface, in display type; body copy
   in it reads at most 72 characters. */
.question-text {
  font-size: var(--type-display);
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--ink);
  max-width: 72ch;
}
/* Monospace only for actual identifiers (question id, revision), never prose. */
.identity {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--type-xs);
}
#question-detail > div:not(.reply-status):not(.question-text), #session-detail > div, #question-list > div {
  font-size: var(--type-xs);
  color: var(--ink-secondary);
  max-width: 72ch;
}
/* Pending-question rows are quiet records on the pale surface, not cards. */
#work-panel .row {
  padding: var(--space-2);
  border: 1px solid #DCE3EB;
  border-radius: var(--radius);
  color: var(--ink);
}
#work-panel .row > div { color: var(--ink-secondary); }
#work-panel .row:hover { border-color: var(--ink-secondary); }
#work-panel .row.selected {
  border-color: var(--action);
  background: rgba(38, 92, 216, 0.08);
  color: var(--ink);
}
textarea {
  font: inherit;
  color: var(--ink);
  background: #ffffff;
  border: 1px solid #DCE3EB;
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  min-height: 6rem;
  resize: vertical;
  width: 100%;
  max-width: 72ch;
}
button {
  font: inherit;
  font-size: var(--type-xs);
  color: var(--question-surface);
  background: var(--rail);
  border: 1px solid var(--rail);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  min-height: 44px;
  cursor: pointer;
}
/* Sentence-case action labels; the single primary action uses --action blue. */
button[type="submit"], #question-detail button[type="button"] {
  background: var(--action);
  border-color: var(--action);
  color: var(--question-surface);
  font-weight: 600;
}
button:disabled { opacity: 0.55; cursor: default; }
:focus-visible { outline: 3px solid var(--action); outline-offset: 2px; }
#retry-reads { margin: var(--space-2) 0; }
/* Narrow screens to 390 px: the rail stacks above the pale workspace and
   touch targets grow; the pale surface keeps its readable measure. */
@media (max-width: 700px) {
  #desk {
    grid-template-columns: minmax(0, 1fr);
  }
  #session-rail, #work-panel { min-height: 0; }
  .row, button, #question-detail textarea { min-height: 44px; }
}
</style>
</head>
<body>
<header id="desk-head">
  <h1>Agentspace</h1>
  <span class="desk-tag">questions desk</span>
</header>
<form id="signin">
  <label for="token">Local token</label>

  <input id="token" type="password" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>
<div id="status" role="status"></div>
<section id="desk" hidden>
  <nav id="session-rail" aria-label="Sessions">
    <h2>Sessions</h2>
    <button id="reload-sessions" type="button">Reload sessions</button>
    <div id="session-list"></div>
  </nav>
  <main id="work-panel">
    <h2>Question</h2>
    <div id="question-detail"></div>
    <h2>Selected session</h2>
    <div id="session-detail"></div>
    <button id="retry-reads" type="button">Retry latest read</button>
    <h2>Pending questions</h2>
    <div id="question-list"></div>
  </main>
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
  // Each composer guards its own submission; there is no page-global pending
  // flag, so a reply that never settles can never refuse every later reply
  // elsewhere on the page.
  // Memory-only drafts, keyed by the exact question identity including its
  // revision: sessionId/questionId/revision -> { revision, text }. A draft
  // never outlives the tab and is never copied onto another question or
  // silently rebound to a newer revision.
  var drafts = {};
  var listError = null;

  function el(id) { return document.getElementById(id); }

  // All dynamic content is added as a new node whose textContent is set:
  // labels from the service are inert data, never markup. An optional class
  // attaches the styling (e.g. monospaced identifiers) to that exact node.
  function line(parent, text, className) {
    var node = document.createElement('div');
    if (className) node.className = className;
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
      // Names its own session so a selection can mark the rendered rows in
      // place instead of rebuilding them (see markSelectedRow).
      row.setAttribute('data-session-id', session.sessionId);
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
   * Selection marks the already-rendered rail rows in place, so the
   * selected-state colours transition on the same element (a full re-render
   * would create fresh rows and skip the transition). Rows without a
   * data-session-id (a failure label line) are left untouched. A session id
   * that is not on the rail leaves every row unmarked, as a re-render would.
   */
  function markSelectedRow(sessionId) {
    var rows = el('session-list').children;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var rowId = typeof row.getAttribute === 'function' ? row.getAttribute('data-session-id') : null;
      if (rowId === null) continue;
      row.className = 'row' + (rowId === sessionId ? ' selected' : '');
    }
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
    // The entrance animation is keyed to this render via the class; with
    // prefers-reduced-motion the class animates nothing and the same lines
    // appear instantly — no state depends on the animation finishing.
    // The exact wording of every line is unchanged; only emphasis classes
    // (display-type question text, monospaced identifiers) are new.
    detail.className = 'entering';
    line(detail, 'text: ' + question.text).className = 'question-text';
    line(detail, 'question: ' + question.questionId, 'identity');
    line(detail, 'session: ' + question.sessionId);
    line(detail, 'revision: ' + question.revision, 'identity');
    replyComposer(detail, question);
  }

  function replyComposer(detail, question) {
    // A draft is bound to the exact revision it was typed against; the
    // question row object itself carries a stale flag from an earlier
    // rejected reply.
    var draftKey = question.sessionId + '/' + question.questionId + '/' + question.revision;
    line(detail, 'reply to this question:');
    var textArea = document.createElement('textarea');
    textArea.setAttribute('aria-label', 'Reply text for question ' + question.questionId);
    var draft = drafts[draftKey];
    if (draft && draft.revision === question.revision) {
      textArea.value = draft.text;
      line(detail, 'kept draft restored (in memory only, for this exact question)');
    }
    textArea.addEventListener('input', function () {
      drafts[draftKey] = { revision: question.revision, text: textArea.value };
    });
    detail.appendChild(textArea);
    var sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.textContent = 'Send reply';
    var statusLine = document.createElement('div');
    statusLine.setAttribute('role', 'status');
    statusLine.className = 'reply-status';
    detail.appendChild(sendButton);
    detail.appendChild(statusLine);
    if (question.stale) {
      // A question the server already rejected once stays unreplyable here:
      // refreshing means re-reading the pending questions and selecting the
      // refreshed question, never resending against a silently new revision.
      line(detail, 'stale: the server rejected this question (it changed afterwards).');
      line(detail, 'The draft below stays for this exact question. Reload the pending questions (select the session again), then select the refreshed question to reply.');
      sendButton.disabled = true;
      sendButton.addEventListener('click', function () {
        statusLine.textContent = 'reply blocked: this question is stale. Reload the pending questions (select the session again), then select the refreshed question';
      });
      return;
    }
    // Submitting is per composer: at most one in flight from this button, so
    // a second submit makes no second request. Other composers elsewhere are
    // never blocked by this one.
    var replyBusy = false;
    sendButton.addEventListener('click', function () {
      if (question.stale) {
        statusLine.textContent = 'reply blocked: this question is stale. Reload the pending questions (select the session again), then select the refreshed question';
        return;
      }
      if (replyBusy) {
        statusLine.textContent = 'a reply is already being sent for this question';
        return;
      }
      replyBusy = true;
      // Everything the request needs — target and text — is captured here,
      // before any await, so selection changes while the request is in
      // flight cannot change where it goes or what it says.
      sendReply(question, textArea, sendButton, statusLine).then(function () {
        replyBusy = false;
      });
    });
  }

  /**
   * Submit one reply. Validation runs before any request and names the
   * problem; the returned promise always settles, so the composer can never
   * stay locked. A hung fetch may keep this one composer busy, but nothing
   * else on the page is refused.
   */
  function sendReply(question, textArea, sendButton, statusLine) {
    var settle;
    var settled = new Promise(function (resolve) { settle = resolve; });
    var text = typeof textArea.value === 'string' ? textArea.value.trim() : '';
    // Reject before any request: an incomplete target or empty text must not
    // reach the service.
    if (!question || !question.sessionId || !question.questionId || question.revision === undefined) {
      statusLine.textContent = 'reply not sent: the question has no complete target (session, question, revision)';
      settle();
      return settled;
    }
    if (text === '') {
      statusLine.textContent = 'reply not sent: type reply text first';
      settle();
      return settled;
    }
    // Whatever happens next, the exact text typed for this exact question is
    // kept as a memory-only draft, so a failed or lost reply is not lost with it.
    drafts[question.sessionId + '/' + question.questionId + '/' + question.revision] =
      { revision: question.revision, text: text };
    sendButton.disabled = true;
    var blocked = false;
    var revision = question.revision;
    var url = '/sessions/' + encodeURIComponent(question.sessionId) +
      '/questions/' + encodeURIComponent(question.questionId) + '/reply';
    statusLine.textContent = 'sending reply…';
    statusLine.className = 'reply-status pending';
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: revision, text: text }),
    })
      .then(function (response) {
        // Only 202 is acceptance, and it never claims delivery or agent
        // acknowledgement: no agent receives input in this build.
        if (response.status !== 202) throw new Error('status-' + response.status);
        statusLine.textContent = 'reply accepted for routing; no agent has received it yet';
        statusLine.className = 'reply-status accepted';
        settle();
      })
      .catch(function (err) {
        if (err.message === 'status-409') {
          // Stale: the server refused the question or its revision. Mark the
          // question object so re-opening it cannot silently resend against a
          // newer revision; the draft stays bound to its exact old revision.
          question.stale = true;
          blocked = true;
          statusLine.textContent = 'reply not accepted: the question is no longer current (revision ' + revision + ' was refused). The draft is kept for this exact question. Reload the pending questions (select the session again), then select the refreshed question';
          statusLine.className = 'reply-status refused';
          sendButton.disabled = true;
          settle();
          return;
        }
        if (err.message && err.message.indexOf('status-') === 0) {
          statusLine.textContent = 'reply not accepted (' + err.message + ')';
          statusLine.className = 'reply-status refused';
        } else {
          statusLine.textContent = 'network error: the reply was not sent (' + err.message + ')';
          statusLine.className = 'reply-status refused';
        }
      })
      .then(function () {
        if (!blocked) sendButton.disabled = false;
        settle();
      });
    return settled;
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
        markSelectedRow(sessionId);
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

  /**
   * The receipts are the session's reply context: complete in the DOM but
   * collapsed behind an explicit labelled toggle, expanded in place. The
   * reveal is bounded (the shared ≤160ms entrance, or nothing under reduced
   * motion) and nothing depends on it: the lines are already present when the
   * hidden flag flips, and collapse is instant. The per-receipt wording stays
   * exactly as before — accepted is never delivered.
   */
  function renderSession(state) {
    var detail = el('session-detail');
    detail.textContent = '';
    line(detail, 'session: ' + state.sessionId);
    line(detail, 'status: ' + state.status);
    line(detail, state.activeQuestion
      ? 'open question: ' + state.activeQuestion.text + ' (revision ' + state.activeQuestion.revision + ')'
      : 'no open question');
    var receipts = state.receipts || [];
    if (receipts.length === 0) return;
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Show reply context (' + receipts.length + ')';
    toggle.setAttribute('aria-expanded', 'false');
    var context = document.createElement('div');
    context.hidden = true;
    function setExpanded(open) {
      context.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = (open ? 'Hide' : 'Show') + ' reply context (' + receipts.length + ')';
      context.className = open ? 'reply-context entering' : 'reply-context';
    }
    toggle.addEventListener('click', function () { setExpanded(context.hidden); });
    detail.appendChild(toggle);
    detail.appendChild(context);
    receipts.forEach(function (receipt) {
      line(context, 'receipt ' + receipt.receiptId + ' — question ' + receipt.questionId + ' revision ' + receipt.revision
        + ' — ' + (receipt.status === 'acknowledged' ? 'acknowledged' : 'accepted, unacknowledged (no agent acknowledgement)'));
    });
  }

  function connect(event) {
    event.preventDefault();
    token = el('token').value;
    el('desk').hidden = false;
    el('reload-sessions').addEventListener('click', function () { loadSessions(); });
    el('retry-reads').addEventListener('click', function () { retryReads(); });
    loadSessions();
  }

  el('signin').addEventListener('submit', connect);
})();
`;

module.exports = { PAGE_HTML, PAGE_JS };
