# Decisions

## 2026-10-08: Session-scoped pending questions with question identity (issue #19)

Context: after selecting a session, the operator needs that session's pending
questions and the exact identity of a chosen question, without any reply path
and without another session's text ever appearing as current.

Decision: when a session selection's state read succeeds, `src/page.js` also
reads `GET /sessions/:sessionId/questions/pending` under the same
selection-generation guard and renders the list; an empty list shows an
explicit "has no pending questions" line, never a reused previous session's
rows. Clicking a question shows its exact identity (question id, session id,
revision, text). A per-render question generation makes rows of earlier
pending lists inert: a stale row can never display another session's
question. Everything stays `textContent`-rendered, and the page remains
read-only (no reply or reply-context requests exist).

Each read also handles its own failure: the pending-questions read carries its
own catch, so a failure there clears and labels only the pending panel, and
can never erase or misreport the session state that already rendered
successfully. The session state read's catch affects only the session panel.

Consequence: delayed reads of either kind, clicked in any order, and failures
of either read can only affect their own selection and their own panel. The
composer stays a later issue.

## 2026-10-08: Read-only inbox with selection generation (issue #18)

Context: the local page must show sessions without retaining unrelated content
when the operator switches, without rendering session text as markup, and
still provide no reply path yet.

Decision: `src/page.js` (after sign-in) lists sessions with their explicit API
statuses, and selection is explicit — clicking a session row reads
`GET /sessions/:sessionId`. Clicking clears the detail panel synchronously and
bumps a selection-generation counter; each read response is tagged with the
generation it was issued under, and any response from an older generation (a
slower read of a previously selected session) is discarded instead of
rendered. All dynamic content is inserted via `textContent` into new elements,
so session/question labels are inert text, never parsed markup.

Consequence: a delayed response can never replace current selection content,
regardless of response ordering. The page stays read-only: the core's reply
and event endpoints remain server-side-only until a later issue builds the
questions panel and composer.

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

## 2026-10-08: Honest read states and labelled keyboard rows on the read-only page (issue #20)

Context: the read-only page needed loading/read-error states, basic
accessibility and narrow-screen layout without expanding scope or privacy.

Decision: every read (sessions list, session state, pending questions) starts
from a cleared panel with an explicit loading line; a failure clears and
labels only the read's own panel ("could not load …", "pending questions
unavailable"), never reuses content from another session or an earlier state,
and recovery is by reselect or the "Retry latest read" button. Session and
question rows are `role="button"` controls with an explicit `aria-label`,
`tabindex="0"` and Enter/Space activation; focus visibility and narrow-screen
sizes live in the page's own stylesheet. The README separates `npm test`
evidence from browser checks that were not performed.

Consequence: the page stays in-memory and first-party (no storage, no remote
assets, no analytics); future panels on the page must follow the same
per-read clearing/label/retry pattern instead of caching content.

## 2026-10-08: A failed sessions-list read keeps its label across unrelated re-renders (issue #20)

Context: a failed `GET /sessions` read empties the `sessions` array and paints
a label into the Sessions panel; any later successful read (a session
selection or its "Retry latest read") re-rendered the panel from that empty
array, wiping the label and leaving a blank, unlabelled panel.

Decision: the page tracks the latest list failure explicitly. Re-rendering the
Sessions panel while a list failure is outstanding redraws the same "could not
load sessions (…)" label instead of the empty array; only a successful
"Reload sessions" clears it.

Consequence: each panel's paired failure label and in-memory state move
together; a recovery action recovers exactly its own panel's read.

## 2026-10-08: Reply submission captures an immutable target; acceptance is not delivery (issue #13)

Context: the read-only page needed a reply composer without a selection
change redirecting an in-flight reply, without duplicate submissions, and
without a 202 receipt implying the agent received anything.

Decision: on submit, `src/page.js` snapshots the selected question's
sessionId/questionId/revision and the typed text in one synchronous step and
builds the request path and body from that snapshot only, so later selection
changes cannot redirect or rewrite an in-flight reply. Only one reply may be
in flight: while pending the button is disabled and further submits make no
second request. Invalid input (incomplete target, missing revision, blank
text) is rejected before any fetch with an explicit "reply not sent (…)"
status line. A `202` is reported as "reply accepted for routing"; the page
never claims delivery or agent acknowledgement, matching the server's
receipt decision. Failures are labelled and the button is restored.

Consequence: the composer stays minimal — reply text is submitted as typed
(trimmed), and there is no draft preservation, stale-revision re-targeting or
retry beyond a fresh manual submit; those come in later issues.
