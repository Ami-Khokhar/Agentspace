# Agentspace

Local-first commercial prototype (not a production release): sessions and
questions with explicit reply routing. Dependency-free Node.js core.

A real-agent integration path (Codex via the Codex app-server protocol) is
specified with primary-source evidence in
[`docs/integration-codex.md`](docs/integration-codex.md); no adapter ships
yet.

## API

`createAgentSpace()` returns an in-memory store with:

- `createSession()` → `{ sessionId, status: 'working' }`
- `ask(sessionId, text)` → `{ sessionId, questionId, revision, status: 'open' }`.
  Asking supersedes the previous open question (marks it `stale`) and sets the
  session status to `needs-user`.
- `reply({ sessionId, questionId, revision, text })` → `{ ..., status: 'answered', receiptId, receiptStatus: 'unacknowledged' }`.
  A reply must name the exact session, the exact active question and its exact
  current revision; anything else is rejected before any state changes. Each
  accepted reply gets a receipt bound to its exact question identity.
- `acknowledge({ sessionId, questionId, revision, receiptId })` →
  `{ ..., receiptStatus: 'acknowledged' }`. Only an exact match of session,
  question, revision and receipt id changes a receipt to 'acknowledged'; any
  mismatch is rejected before any state changes. Receipt states are
  'unacknowledged' (accepted for routing only, never a delivery claim) and
  'acknowledged'. Closed sessions (`finished`/`disconnected`) reject
  acknowledgements, so disconnection never implies delivery; receipt states
  stay readable in `getSessionState`.
- `expireQuestion({ sessionId, questionId, revision })` →
  `{ ..., status: 'expired' }`. Expires the active open question explicitly
  (for example while its client was disconnected). An expired question stays
  expired: it leaves the pending list, is never resurrected, and any answer
  replayed at its former coordinates (or against a newer revision) is
  rejected before any state changes. On a terminal session (`finished` or
  `disconnected`) expiry is rejected with `sessionClosed` — a closed session
  stays closed, so expiry cannot resurrect it into a live one.
- `sendEvent(sessionId, { type })` — explicit state events only: `working`,
  `needs-user`, `finished`, `disconnected`. `finished`/`disconnected` close the
  session to further asks and replies. Unknown or malformed events are rejected
  without corrupting state. Session state is never guessed from message text.

Errors are `AgentSpaceError` instances distinguished by `name`: `badEvent`,
`unknownSession`, `sessionClosed`, `unknownQuestion`, `questionNotOpen`,
`revisionMismatch`, `receiptMismatch`.

Question revisions increment per session (1, 2, 3, …), so a superseded question's
revision is stale by definition and cannot be replied to.

## Test

`npm test` runs the built-in Node test runner (`node --test`). No npm
dependencies, no native compiler, no accounts, no secrets, no network.

Executed evidence (Node v24.21.0, npm 11.19.0):

```
$ npm test
ℹ tests 50
ℹ pass 50
ℹ fail 0
```

## Design decisions

See `docs/decisions.md`.

## Local launcher

`npm start` (or `node src/launcher.js`) runs `startLauncher()` from
`src/launcher.js`. Safe local bootstrap:

- The launcher asks the operator to type a local token once. It puts the
  terminal into raw mode (readline `terminal: true`), so the OS line
  discipline never echoes the typed characters; readline's echo goes to a
  muted stream that drops everything except line breaks. Readline history is
  disabled.
- The token exists only in memory: the launcher's process, the page's
  `Authorization` header, and the browser tab. It never appears in a URL, in
  any log or terminal output, or in any stored data.
- The launcher then prints only the loopback page address (no token in it) and
  starts the service below; the page's form takes the token into memory.

## Local simulated sessions demo

`npm run demo` (or `node src/demo.js`) runs a fully local, deterministic demo
of two simulated sessions against the real service and core boundaries:

- Two scripted simulated sessions (`[simulated] pair-a`, `[simulated] pair-b`)
  are created by the core; every output line is explicitly labelled
  `[simulated]`, so none of it can be mistaken for live agent traffic.
- Questions are asked through the core's `ask`; each session's owning
  simulator reads only that session's own pending list
  (`GET /sessions/:id/questions/pending`) over the real HTTP service and
  posts its reply to the service's reply route. A simulator cannot see or
  answer another session's question.
- Reply receipts are acceptance-only at the moment of submission
  (`acceptance for routing by the local service; no agent has received or
  acknowledged this input`): nothing here claims delivery. Each accepted
  reply carries a receipt bound to the exact question identity, which the
  owning simulator then acknowledges (exactly matching session,
  question/revision/receipt id) through the service's acknowledgement route,
  so the demo distinguishes accepted, unacknowledged and acknowledged
  states.
- Simulated reconnect/replay safety: after each accepted reply, each session's
  own simulator replays the disconnect path once — it re-posts the same reply
  coordinates and re-acknowledges the same receipt identity. The service
  rejects the duplicate reply with `409 questionNotOpen` (one logical reply,
  one receipt, at most one consumption) and treats the duplicate
  acknowledgement as the same, already-acknowledged receipt (no new receipt,
  no regression to unacknowledged). Simulator functions
  `reconnectSimulatedSession` and `reconnectExpiredSimulatedSession` do the
  same across a full disconnect: replay is rejected both before and after a
  reconnect, and a question expired during the disconnect (`expireQuestion`)
  stays expired — no resurrection in the pending list, no stale answer at the
  old coordinates, none at a newer revision either.
- Simulator limitations: everything is scripted and local — no real agent,
  network, storage, clock or queueing exists. Reconnection is modelled as a
  plain HTTP redial inside one running process: the session-level
  `disconnected` event is terminal, so a simulated session that sends it
  cannot reconnect at all. Expiry is an explicit local call, not a timer, and
  acknowledged receipts are never re-acknowledged into a different state.
- Each session is closed with an explicit `finished` event through the
  events route; the service is then closed and the demo exits. All local,
  loopback only, no network, no credentials, no command execution.

## Local page inbox (read-only)

After a successful token sign-in, the page's `app.js` shows a read-only inbox:

- The session list (`GET /sessions`) starts with an explicit "loading sessions…"
  line and a held "Reload sessions" button; a failing read replaces the list with
  a "could not load sessions (…)" line (the status line repeats it), and the
  button is re-enabled so the read can be retried. That failure label stays
  in place even when a later successful read (e.g. a session selection or its
  "Retry latest read") re-renders the page: the list's own recovery is a
  successful "Reload sessions". Nothing is shown for a session until it is
  selected.
- Clicking a session selects it and reads its state (`GET
  /sessions/:sessionId`). Switching clears the detail panel synchronously, and
  each selection carries a generation counter: a read response from an earlier
  selection that arrives late is discarded, so it can never paint a previous
  session's content over the current selection.
- A failing session-state read (or a pending-questions read) is labelled
  explicitly where it happened: "could not load <id> (…)" in the detail panel
  and "pending questions unavailable" in the questions panel — never stale
  content from another session presented as current. A "Retry latest read"
  button re-runs the reads of the current selection or view; every read carries
  its own failure handling, so a failing pending read leaves the already
  rendered session state untouched.
- After the selected session's state loads, the page reads that session's own
  pending questions (`GET /sessions/:sessionId/questions/pending`) under the
  same generation guard, and lists them. An empty list shows an explicit
  "has no pending questions" line; the previous session's questions are
  cleared and never reused. Each read carries its own failure handling: a
  failing pending-questions read clears and labels only the pending panel,
  leaving the already rendered session state untouched.
- Pending question rows are selectable: a selected question shows its exact
  identity — question id, its own session id, revision, and text — together
  with a reply composer (a labelled text field, a "Send reply" button and a
  status line). Switching
  sessions clears the question panel and makes rows of earlier pending lists
  inert, so a stale control can never display another session's question.
- All session and question content is rendered with `textContent` into new
  elements; script/markup-like session or question text stays inert text and
  is never parsed as markup — including reply composer text.
- A reply is submitted through the composer (`POST
  /sessions/:sessionId/questions/:questionId/reply`): the exact target
  (session, question, revision) and the typed text are captured at submission,
  so changing the selection while the request is in flight cannot redirect or
  rewrite it. While a reply is pending the button is disabled — a second
  submit makes no second request and names itself ("a reply is already being
  sent for this question"). Submitting is per composer, not page-global: a
  hung or still-pending reply never refuses replies from other questions.
  An incomplete target, a missing revision or
  blank text sends nothing and says so; a `202` receipt is reported as
  "reply accepted for routing" only — no delivery or agent acknowledgement
  is ever claimed, because no agent exists yet. A failure is labelled and
  re-submitting is restored.
- Accessibility basics: session and pending-question rows are labelled
  controls (`role="button"`, an `aria-label` naming the session/question and
  status, focusable with `tabindex="0"`) that respond to Enter and Space as
  well as click; the sign-in token field has a real `<label>`; the session
  rail is a labelled `<nav>`; the stylesheet gives every control a visible
  `:focus-visible` outline and the text/token colors are chosen for contrast
  on the charcoal surfaces; below 600 px the workspace stacks into a single
  column and rows and buttons grow to ≥44 px so the page stays usable on
  narrow screens.
- There is no reply editing beyond one submission at a time: the composer is
  sent as-is by the button. Draft preservation, stale-revision blocking and
  honest failure wording are described below.
- Drafts are memory-only and exact: whatever is typed for a question is kept
  under that question's full identity (session id, question id, revision) in
  the browser tab's memory and nowhere else. It survives switching sessions
  or questions and a failed or network-lost submit, is restored when the exact
  same question identity is selected again ("kept draft restored"), and is
  never copied to another question or silently rebound onto a newer revision:
  a pending row at a newer revision of the same question starts with an empty
  composer, and only its own submission targets the new revision.
- When the server rejects a submission with `409` (stale revision or
  superseded question), the composer is blocked permanently for that
  question: further clicks make no request and the status line says the
  question is no longer current, the draft is kept for that exact question,
  and the recovery is to reload the pending questions (select the session
  again) and select the refreshed question. Nothing is ever resent against a
  newer revision without that explicit refresh-and-reselect step.
- Failure wording is honest and specific:
  - accepted: `202` → "reply accepted for routing; no agent has received it
    yet" — accepted-not-delivered, never agent acknowledgement;
  - server refusal (non-409 statuses, e.g. `500`) → "reply not accepted
    (status-…)" with the composer unlocked for a deliberate retry;
  - network failure → "network error: the reply was not sent (…)";
  - stale `409` → explicit blocked state as above.

## Manual browser checks (not automated evidence)

The `npm test` run above exercises the served script against controlled
responses, but it does **not** perform the following browser checks — none of
them were executed by automated tooling, and no claim below is a test result:

0. Before signing in: only the sign-in form and the status line are visible —
   no Sessions, Question or Pending questions region, and no activated
   "Reload sessions" or "Retry latest read" button (the workspace `<section>`
   stays hidden until `connect()` succeeds; the stylesheet's `[hidden]`
   override keeps the attribute authoritative).
1. `npm start`, open the printed loopback address, type the local token and
   press Enter. Expected: the sign-in form has a visible text label, and after
   connecting the session list loads.
2. Keyboard: from a fresh page, press `Tab` repeatedly. Expected: a clearly
   visible outline moves through Token, Connect, Reload sessions, session rows
   (one per listed session), Retry latest read and any question rows. Press
   Enter on a session row — its state loads, exactly as if it had been clicked.
3. Loading, failure and recovery: while the session list is loading, a
   "loading sessions…" placeholder is visible. Submit a deliberately wrong
   token once: expected is a "could not load sessions (…)" error line and no
   sessions shown. Reconnect with the right token and press "Reload sessions":
   the list recovers. Each session read is independent, so a failing read
   never shows another session's content — it is labelled and can be retied
   with "Retry latest read" or by selecting the row again.
4. Mobile width: in the browser's responsive mode, narrow the window below
   600 px. Expected: the two-column workspace (session rail beside the
   question/session panels) stacks into one column, rows and buttons grow
   taller (≥44 px touch targets), and the layout stays single-column with no
   horizontal scrolling.
5. Drafts and stale handling (requires a second ask in a session, e.g. via the
   events/question endpoints from a second local terminal): type a reply for a
   question, switch to another session and back — the draft text is restored
   for that exact question only; the other question's composer was empty.
   Restart the tab — the draft is gone (memory only). Submit a reply after the
   question was superseded server-side: expected is the "no longer current"
   block with no resend until you reselect the session (refreshing the
   pending questions) and pick the refreshed question.

6. Motion (workspace transitions, restrained by design): select a session and
   a question. Expected: the selection highlight and hover/focus border
   change over a short (≤200 ms) transition; the question panel fades in from
   a 4 px offset over ~160 ms while showing only the currently selected
   question's lines — no old session's content is ever displayed, and text
   positions of reading targets do not shift. With the browser's
   "emulate prefers-reduced-motion: reduce" setting enabled: expected is the
   same content with no transition or entrance animation — every state change
   (selection colours, loading lines, reply status wording) applies instantly
   with no functional dependency on animation.
7. Reply feedback: submit a reply. Expected: the status line reads
   "sending reply…" (pending), then "reply accepted for routing; no agent has
   received it yet" (accepted, explicitly not delivered, never agent
   acknowledgement); on a stale or failed submission it reads the exact
   refusal text. No spinner, shimmer, scroll-dependent control or fake
   progress appears at any point; waits are named in text only.
8. Mobile width (motion included): in the browser's responsive mode, narrow
   the window below 600 px. Expected: the stacked single-column layout with
   ≥44 px touch targets behaves as on desktop — the same restrained
   transitions, the same panel entrance scoped to the new selection, and
   reduced-motion still removes all animation.

The page uses no external assets, storage or network beyond its own loopback
service, and the token stays in memory and in the `Authorization` header only.

The automated `npm test` run above **does** verify against the actual
implementation: the entrance class is applied to the question panel render
with the panel's lines and live composer present immediately (state is never
waited on animation, the reduced-motion path renders identically), and reply
statuses move through `pending`/`accepted`/`refused` feedback classes with
exact wording unchanged. It does **not** execute the browser checks 1–8
above; none of them were performed by automated tooling and no claim in them
is a test result.

## Local HTTP service

`createServer({ space, port, secret })` (from `src/server.js`) exposes the core
over HTTP for a first-party local browser client or CLI:

- Binds to `127.0.0.1` only, on an ephemeral port. There is no host/interface
  option and no way to bind publicly.
- A random per-launch bearer secret is generated (or passed by the local
  launcher) and required as `Authorization: Bearer <secret>` on every read and
  write. It is returned once to the caller for the client's bootstrap; the
  service never writes it to any log, URL or response.
- Requests with a non-loopback peer address, a `Host` other than
  `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` (DNS-rebinding
  guard), or an `Origin` other than the loopback origin of the same port are
  rejected. No `Access-Control-Allow-*` headers are ever sent: no cross-origin
  use is supported. A first-party page must be served from (or opened at) the
  loopback origin itself; browsers consider `http://127.0.0.1:<port>` and the
  service both first-party local, so fetches from a page opened directly on
  that origin carry a matching `Origin` and are accepted.
- JSON request bodies are capped at 64 KiB and must be JSON objects; invalid
  JSON, oversized payloads and malformed path identifiers get 400/413 without
  leaking stack traces or changing state.
- Only GET and POST are routed; there is no shell endpoint, file access,
  external call, or telemetry.

Routes:

- `GET /sessions` → `{ sessions: [{ sessionId, status, hasPendingQuestion }] }`
- `GET /sessions/:sessionId` → the core's session state
- `GET /questions/pending` → all open questions
- `GET /sessions/:sessionId/questions/pending` → open questions of one session
- `POST /sessions/:sessionId/questions/:questionId/reply`
  with `{ revision, text }` → `202 { accepted: true, note }` or an error:
  `400 badReply`/`badIdentifier`, `404 unknownSession`/`unknownQuestion`,
  `409 questionNotOpen`/`revisionMismatch`/`sessionClosed`.
- `POST /sessions/:sessionId/events` with `{ type }` → core event

The 202 receipt says the input was accepted for routing by the local service.
No agent adapter exists yet, so the receipt never claims any real agent
received or acknowledged the input; the `note` field says so explicitly and
the response has no agent-acknowledgement field.
