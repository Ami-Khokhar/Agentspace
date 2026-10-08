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

## 2026-10-08: Loopback-only service, bearer secret, acceptance-only receipts (issue #3)

Context: the core must be reachable by a first-party local browser client
without becoming reachable by other sites, remote hosts or a compromised
launcher's logs.

Decision: `src/server.js` wraps the core in a small Node HTTP service that
binds to `127.0.0.1` only (no host option), requires a per-launch random
bearer secret on every read and write, rejects non-loopback `Host` headers
(DNS-rebinding) and non-loopback `Origin` headers, and sends no CORS headers.
Bodies are JSON objects capped at 64 KiB; malformed identifiers get 400
before any core call. A successful reply returns `202 { accepted: true, note }`
where `note` states that no agent has received or acknowledged the input —
acceptance-for-routing only, because no agent adapter exists yet.

Consequence: the launcher passes `secret` to the first-party client out of
band (it must never appear in a URL, a command line or a log). Until a real
agent adapter exists, callers may only treat a receipt as "the local service
has the input", never as agent acknowledgement.

## 2026-10-08: Read-only page selects by explicit identifiers and renders inert text (issue #12)

Context: the local page must display sessions and pending questions without
turning untrusted server text into markup, and without letting a failed read
leave old results posing as current state.

Decision: the page selects sessions and questions by their exact identifiers
(fetched `GET /sessions/:id` and `/…/questions/pending`, never by text
matching or reuse of unrelated data), places every server-provided value into
the DOM only through `textContent`, and exposes loading, empty and read-error
states only: a failed read empties the failing area and says so. No reply
composer exists yet, so the client issues GET requests only.

Consequence: question ids are server-generated strings (not ordinal
positions), so a client may never assume `revision`-style short labels are
identities. Any future composer must be added behind the same identifier rule
and will need explicit review of the untrusted-text rule first.
