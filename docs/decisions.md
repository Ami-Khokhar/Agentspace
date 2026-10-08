# Decisions

## 2026-10-08: Explicit events, not text guesses (issue #2)

Context: replies and state changes must be unambiguous, and a wrong guess (for
example, closing a session because a message "sounds finished") silently
corrupts state.

Decision: session states (`working`, `needs-user`, `finished`, `disconnected`)
change only through `sendEvent` with one of the four exact event types, and
replies must name the exact session id, question id and integer revision.
Anything else — unknown event types, extra fields, missing/empty text,
non-integer revisions — is rejected before any state changes, with errors
distinguished by `name`, not by parsing.

Consequence: callers must keep question coordinates (session, question,
revision) across turns. Revisions increment per session, so a superseded
question cannot be answered after a newer one is asked. Terminal states
(`finished`, `disconnected`) reject further asks and replies.
