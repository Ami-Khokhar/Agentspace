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
