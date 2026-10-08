# Agentspace

Local-first commercial prototype (not a production release): sessions and
questions with explicit reply routing. Dependency-free Node.js core.

## API

`createAgentSpace()` returns an in-memory store with:

- `createSession()` → `{ sessionId, status: 'working' }`
- `ask(sessionId, text)` → `{ sessionId, questionId, revision, status: 'open' }`.
  Asking supersedes the previous open question (marks it `stale`) and sets the
  session status to `needs-user`.
- `reply({ sessionId, questionId, revision, text })` → `{ ... status: 'answered' }`.
  A reply must name the exact session, the exact active question and its exact
  current revision; anything else is rejected before any state changes.
- `sendEvent(sessionId, { type })` — explicit state events only: `working`,
  `needs-user`, `finished`, `disconnected`. `finished`/`disconnected` close the
  session to further asks and replies. Unknown or malformed events are rejected
  without corrupting state. Session state is never guessed from message text.

Errors are `AgentSpaceError` instances distinguished by `name`: `badEvent`,
`unknownSession`, `sessionClosed`, `unknownQuestion`, `questionNotOpen`,
`revisionMismatch`.

Question revisions increment per session (1, 2, 3, …), so a superseded question's
revision is stale by definition and cannot be replied to.

## Test

`npm test` runs the built-in Node test runner (`node --test`). No npm
dependencies, no native compiler, no accounts, no secrets, no network.

Executed evidence (Node v24.21.0, npm 11.19.0):

```
$ npm test
ℹ tests 7
ℹ pass 7
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

## Local page inbox (read-only)

After a successful token sign-in, the page's `app.js` shows a read-only inbox:

- The session list (`GET /sessions`) with each session's explicit status from
  the API, plus a "Reload sessions" button. Nothing is shown for a session
  until it is selected.
- Clicking a session selects it and reads its state (`GET
  /sessions/:sessionId`). Switching clears the detail panel synchronously, and
  each selection carries a generation counter: a read response from an earlier
  selection that arrives late is discarded, so it can never paint a previous
  session's content over the current selection.
- After the selected session's state loads, the page reads that session's own
  pending questions (`GET /sessions/:sessionId/questions/pending`) under the
  same generation guard, and lists them. An empty list shows an explicit
  "has no pending questions" line; the previous session's questions are
  cleared and never reused. Each read carries its own failure handling: a
  failing pending-questions read clears and labels only the pending panel,
  leaving the already rendered session state untouched.
- Pending question rows are selectable: a selected question shows its exact
  identity — question id, its own session id, revision, and text. Switching
  sessions clears the question panel and makes rows of earlier pending lists
  inert, so a stale control can never display another session's question.
- All session and question content is rendered with `textContent` into new
  elements; script/markup-like session or question text stays inert text and
  is never parsed as markup.
- There are no reply controls: the page is read-only over the API.

The page uses no external assets, storage or network beyond its own loopback
service, and the token stays in memory and in the `Authorization` header only.

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
