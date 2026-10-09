# Decisions

## 2026-10-09: Codex integration via documented app-server stdio protocol, not terminal scraping (issue #6)

Context: a first real coding-agent adapter needs structured identifiers,
reply routing, an approval channel and disconnect semantics from a supported
primary source, while existing user auth must stay external to Agentspace.

Decision: the integration target is OpenAI Codex's own client-integration
surface, `codex app-server` over the documented newline-delimited JSON-RPC
2.0 stdio transport (https://learn.chatgpt.com/docs/app-server), with
schemas generated per Codex version via `codex app-server
generate-json-schema`. Threads map to sessions, turns/items carry
structured ids, `turn/steer` routes mid-turn replies, and command/file
approvals arrive as typed server-initiated JSON-RPC requests — so approvals
are surfaced as pending questions, never inferred from terminal text. Herdr
is evaluated as optional human-view/restore glue, not the transport: its
agent surface is terminal-scoped and offers no structured approval path.
Safety rules are recorded in `docs/integration-codex.md` §9 (no permission
bypass, no auto-approval, no credential collection, no worker control
outside guarded tools), and the live acceptance procedure and its
not-yet-exercised credential/host requirement are in its §10.

Consequence: no adapter or npm dependency ships yet; the app-server command
is documented as experimental (stdio is its stable default transport), so a
future adapter must be opt-in and labelled. Existing Codex auth stays in
the user's `CODEX_HOME`, never read or stored by Agentspace.

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
changes cannot redirect or rewrite an in-flight reply. Submitting is
per composer: while pending that composer's button is disabled and further
submits from it make no second request (a blocked click names itself); there
is no page-global pending flag, so a hung or pending reply can never refuse
replies elsewhere on the page. Invalid input (incomplete target, missing
revision, blank
text) is rejected before any fetch with an explicit "reply not sent (…)"
status line. A `202` is reported as "reply accepted for routing"; the page
never claims delivery or agent acknowledgement, matching the server's
receipt decision. Failures are labelled and the button is restored.

Consequence: the composer stays minimal — reply text is submitted as typed
(trimmed), and there is no draft preservation, stale-revision re-targeting or
retry beyond a fresh manual submit; those come in later issues.

## 2026-10-08: Exact-question memory drafts, stale 409 blocking, accepted-not-delivered wording (issue #14)

Context: replies typed into the composer were lost on any selection change or
failed submit; a 409 (stale revision / superseded question) gave no
recovery path and invited a blind resend against a newer revision; the 202
wording could imply the input had reached something.

Decision: `src/page.js` keeps drafts as plain in-memory objects keyed by the
full question identity including the revision
(`sessionId/questionId/revision`). A draft is saved while typing (`input`
event) and again at submission, survives selection changes and failed or
network-lost sends, and is restored only for the identical
session/question/revision — never copied to another question and never
silently rebound to a newer revision. A `409` marks the client-side question
object stale and disables that composer permanently: further clicks make no
request, the status line says the question is no longer current and names the
recovery (re-select the session to reload pending questions, then select the
refreshed question). A `202` is worded "reply accepted for routing; no agent
has received it yet" (accepted-not-delivered); non-409 statuses are
"reply not accepted (status-…)", network failures
"network error: the reply was not sent (…)".

Consequence: no new storage, privacy or control surface — drafts live and
die with the tab like the token; sending remains a single explicit POST per
submission and only the server can make a question current again.

## 2026-10-09: Two scripted simulated sessions over the real boundaries, no acknowledgement (issue #30)

Context: simulated sessions were needed for local exercise of the reply
routing without inventing delivery semantics, a new framework or a generic
agent adapter.

Decision: `src/simulate.js` is a compact local simulator bound to the
boundaries that already exist. Questions are asked through the core's `ask`;
each simulated session's own simulator reads only that session's
`GET /sessions/:id/questions/pending`, posts its reply to the service's reply
route, and closes the session with an explicit `finished` event through the
events route. Every printed line is labelled `[simulated]`. `src/demo.js`
(`npm run demo`) runs two labelled sessions with fixed scripts and a
deterministic shutdown: both scripts finish, sessions close, the service
closes, the process exits. Receipts remain acceptance-only
(RECEIPT_NOTE); no acknowledgement, delivery claim or reconnect mechanism is
introduced here.

Consequence: a later real agent adapter must reuse the same boundaries and
may only replace "simulated" labelling where a real, authenticated agent
actually exists; acceptance wording is fixed and tests enforce that no
`delivered`/`acknowledged` state appears.

## 2026-10-09: Explicit matching acknowledgements bound to receipt identity (issue #31)

Context: accepted replies still said nothing about delivery; a disconnect
could not be distinguished from a delivered-but-unacknowledged input.

Decision: every accepted reply in `src/agentspace.js` mints a receipt
(`receipt-N`) on the answered question with status 'unacknowledged', and
`src/server.js` exposes an acknowledgement route
(`POST /sessions/:id/questions/:qid/acknowledge`, body `{ revision,
receiptId }`). Delivery is recorded only by an acknowledgement that exactly
matches the session, question, revision and existing receipt id; any other
combination (wrong receipt id, mismatched question/revision, unknown or
closed session) is rejected with `receiptMismatch`/`unknownQuestion`/
`revisionMismatch`/`sessionClosed` before any state changes, and unrelated
receipts are never touched. `getSessionState` now lists receipts with their
status, and the page renders 'acknowledged' vs 'accepted, unacknowledged'
per receipt. The simulated sessions in `src/simulate.js` acknowledge their
own accepted receipts exactly once, with the exact receipt identity from the
202. Terminal sessions reject acknowledgements, so a `finished` or
`disconnected` simulator can never rewrite history; an accepted reply there
stays 'unacknowledged'.

Consequence: acceptance, unacknowledged and acknowledged states are now
explicitly distinguishable through the service and the page, and
disconnection never implies delivery. Reconnect/replay remains out of scope:
there is no retry, queueing or replay mechanism yet, and no agent exists to
acknowledge anything, so the acknowledgement state only reflects what local
callers explicitly sent.

## 2026-10-09: Simulated reconnect safety: no repeated consumption, no resurrected expiration (issue #32)

Context: reconnect/replay was still out of scope, so a redelivered reply or an
acknowledgement replayed after a dropped connection had no defined behavior,
and no question could ever be expired while its client was away.

Decision: `src/agentspace.js` gains `expireQuestion` (active open question
with an exact revision only) and `src/server.js` exposes it as
`POST /sessions/:id/questions/:qid/expire`. An expired question keeps its
identity but can never be answered again; expiry does not mint or touch
receipts. `src/simulate.js` models the reconnect path explicitly:
`reconnectSimulatedSession` replays the exact reply coordinates and receipt
identity of what was sent before the disconnect — the duplicate reply is
rejected (`questionNotOpen`) so one logical reply is consumed at most once,
and the re-acknowledgement of the same identity is idempotent-equivalent (the
same single receipt stays 'acknowledged'; nothing regresses to
unacknowledged). `reconnectExpiredSimulatedSession` proves a question expired
during disconnection is not resurrected and its stale answer is rejected at
both the old coordinates and a newer revision. The HTTP-boundary tests replay
replies, acknowledgements and events directly against the service. A
session-level `disconnected` event stays terminal: reconnect is an HTTP
redial, not a state resurrection.

Consequence: duplicate replay can never double-consume or mint receipts,
expiry cannot be undone by a reconnect, and the demo remains local,
scripted and labelled. Real agents, timers, queues and persistence are still
out of scope; a real agent adapter would reuse the same boundaries.
