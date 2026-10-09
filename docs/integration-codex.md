# Real-agent integration path: Codex via the Codex app-server

Status: **feasible with evidence, not yet exercised at runtime.** This document
is a technical integration specification with primary-source citations. It does
not claim a working adapter exists, does not claim any live session, and ships
no adapter code (see "What this issue does not ship").

Primary sources consulted (exact URLs, versions and commits inspected
2026-10-09):

- Codex app-server protocol reference:
  https://learn.chatgpt.com/docs/app-server (fetched as `/docs/app-server.md`)
- Codex non-interactive mode (`codex exec`):
  https://developers.openai.com/codex/noninteractive (fetched as
  `/codex/noninteractive.md`)
- Codex MCP server removal notice (why MCP is *not* the path):
  https://learn.chatgpt.com/docs/mcp-server (fetched as `/docs/mcp-server.md`)
- Codex SDK positioning: https://learn.chatgpt.com/docs/codex-sdk
  (SDK is for CI jobs; app-server is the client-integration surface)
- Codex CLI source repository: https://github.com/openai/codex
  (branch `main` at commit `03b761dca9b04f47e166494232d70b3fe7c6738a`;
  latest release at inspection: `rust-v0.162.0`, published 2026-10-08)
- Herdr repository: https://github.com/herdrdev/herdr (branch `master` at
  commit `2563803dca97c040beaf3dc3acdcb5a0221b4238`; latest release
  `v0.9.3`, published 2026-09-29) and its Socket API documentation:
  https://herdr.dev/docs/socket-api/ (Herdr 0.9.3 docs)
- Licence files inspected directly: Codex `LICENSE` (Apache License 2.0,
  read from the repository above) and Herdr licence (Apache-2.0 per the
  pinned npm package `herdr` metadata at
  https://registry.npmjs.org/herdr and the repository `LICENSE` badge).
  Note the npm package `herdr@0.0.0` is only a *reserved name* (AGPL-3.0
  declared, no code); the real Herdr distribution is the standalone Rust
  binary/repository, Apache-2.0.

## 1. The supported structured transport: `codex app-server` over stdio

The Codex CLI ships a **first-party, documented JSON-RPC 2.0 service** that
powers its own rich clients (the VS Code extension) and is explicitly offered
"when you want a deep integration inside your own product: authentication,
conversation history, approvals, and streamed agent events"
(app-server doc, opening paragraph).

- Transport: default `--listen stdio://` = newline-delimited JSON (JSONL)
  over the child process's stdout/stdin. Other transports (WebSocket, Unix
  socket) exist; WebSocket is documented as *experimental and unsupported*,
  so the specification targets **stdio only**.
- Protocol: JSON-RPC 2.0 messages with the `"jsonrpc":"2.0"` header omitted
  on the wire. Requests carry `method`, `params`, `id`; responses echo `id`
  with `result` or `error`; notifications omit `id`.
- Schemas are versioned and generatable **from the binary itself**, which
  makes version drift checkable at integration time:
  `codex app-server generate-json-schema --out ./schemas` (and
  `generate-ts`). The generated artifacts match the exact Codex version run.
- Handshake: `initialize` request with `clientInfo`, then the `initialized`
  notification.

Caveat recorded verbatim from the source: "The app-server command is
experimental and isn't supported for production workloads" (mcp-server
removal page), and the app-server doc repeats this for the WebSocket
transport. **Consequence:** a first adapter should be gated behind an
explicit opt-in and labelled experimental; stdio transport itself is the
stable, documented default used by Codex's own clients.

## 2. Structured identifiers: how Agentspace "session/question/revision"
maps onto Codex primitives

app-server core primitives (app-server doc, "Core primitives"):

| Codex primitive | Structured identifier | Agentspace analogue |
| --- | --- | --- |
| Thread | `thread_id` from `thread/start` result (`thread.id`, e.g. `thr_123`; also long UUID form in `codex exec --json` sample: `0199a213-81c0-…`) | `sessionId` |
| Turn | `turnId` from `turn/start` result and `turn/started` notification (e.g. `turn_456`) | — (worker-side bookkeeping only) |
| Item | `item.id` on `item/started` / `item/completed` notifications (e.g. `item_1`) | — (the channel Conduit would display) |
| User input | `turn/start.params.input: [{ type: "text", text: … }]` | the text payload of a reply |

A first adapter would store, per Agentspace session: the `codex` child
process handle and its `threadId`. Turns begin either directly from the
agent (worker-visible as the agent working) or from a routed reply.

`turn/steer` appends user input to an in-flight turn without creating a new
turn; `turn/interrupt` cancels the in-flight turn and the server emits
`turn/completed` with `status: "interrupted"`. `thread/resume` reopens an
existing thread by id so later turns append to it. These give a supported,
documented mechanism for "operator answers while the agent works" and for
"operator stops the agent" *without* scraping terminal text.

## 3. Reply semantics and stale answers

- A reply that targets a thread whose turn has already finished is a **new
  `thread/start`→`turn/start`** on the resumed thread
  (`thread/resume` + `turn/start`), which the app-server doc documents as
  appending to the existing conversation.
- A reply that arrives mid-turn maps to `turn/steer`; the accepted
  `turnId` is returned by the request response, so the adapter has an
  explicit server acknowledgement of delivery.
- Agentspace rejections (`revisionMismatch`, `questionNotOpen`,
  `sessionClosed`) happen *before* any app-server call is made, so a stale
  reply (old revision) is rejected core-side and never reaches the agent.
  This is unchanged core behavior (see `README.md` API section).
- `mcpServer/elicitation/request` exists for MCP-server-initiated form
  input, but that is *downstream-Mserver→client*, not the Codex-agent→user
  channel; do not overload it.

## 4. Approval semantics (the part terminal scraping cannot provide)

This is the central finding: Codex app-server sends approval decisions as
**structured server-initiated JSON-RPC requests**, not as terminal text to
parse. From the "Approvals" section of the app-server doc:

- `item/commandExecution/requestApproval` — includes `itemId`, `threadId`,
  `turnId`, optional `reason`, `command`, `cwd`, `commandActions`,
  `proposedExecpolicyAmendment`, `networkApprovalContext`, and
  `availableDecisions`. `networkApprovalContext` means a managed-network
  *destination* prompt (renders `host`/`protocol`); Codex groups concurrent
  network prompts by destination (host, protocol, port).
- `item/fileChange/requestApproval` — includes `itemId`, `threadId`,
  `turnId`, optional `reason`, optional `grantRoot`.
- `item/permissions/requestApproval` — a subset of network/filesystem
  permissions requested by the built-in `request_permissions` tool.
- The client "responds with one of the command execution / file change
  approval decisions above" — i.e. an enumerated decision payload per
  request id, exactly the shape Agentspace can route as a pending question
  whose answer is structured, not free text.

Because approvals arrive as named JSON-RPC requests with ids and typed
params, an adapter can (a) render the exact command/file diff/destination,
(b) surface it as an Agentspace pending question, (c) send back an exact
decision, and (d) still reject stale/duplicate decisions core-side. **No
terminal output scraping is involved or required.** The findings in the
workorder ("do not assume terminal output scraping provides a reliable
approval protocol") are satisfied by design, not by interpretation.

## 5. Disconnect behavior

- The agent runs as a **child process of the adapter process**. If the
  adapter dies, the child's stdio pipes close and the app-server
  terminates (documented stdio transport semantics; no reconnect-on-stdio
  is offered anywhere in the docs). This is the failure mode to design
  for: Agentspace marks the session `disconnected` via explicit
  `sendEvent`, matching the core's existing rule that states change only
  through explicit events, never from text.
- Threads survive the process: `thread/resume` reopens by id. So
  "adapter restarted" is recoverable if the adapter persists `threadId`
  and relaunches `codex app-server` with the same `CODEX_HOME` — but
  **this resume path is documented behavior of the protocol, not
  something any runtime here has proven.** `thread/closed` is also
  emitted when a thread is unloaded after a no-subscriber inactivity
  grace period (`thread/unsubscribe` semantics), which the adapter
  should treat as "the conversation ended server-side".

## 6. Permissions: would a spawned agent inherit Agentspace's privileges?

No. The adapter spawns `codex` as a *separate user-level process*:

- Codex reads its own configuration/auth from `$CODEX_HOME` (config.toml,
  credentials). `codex exec --ignore-user-config` exists precisely because
  that loading is *Codex's* behavior, not inherited from a parent process.
- Agentspace's loopback HTTP bearer secret (`src/server.js`) is never
  placed in the child's environment by any proposed code. The child holds
  only a pipe pair; it has no Agentspace credential, and Agentspace holds
  nothing of the child's beyond its stdio and `threadId`.
- Sandbox/approval policy is set per-run via explicit app-server
  `turn/start` `sandboxPolicy`/`approvalPolicy` params or Codex config
  (`approvalPolicy: "never" | "unlessTrusted" | …` appears in the doc's
  examples) — an explicit, documented, per-turnsetting, not an ambient
  inheritance from Agentspace.

**Authentication stays external to Agentspace by design:** users'
existing `codex` login (ChatGPT account or API key) lives in their own
Codex home directory, is never read, stored, proxied or displayed by
Agentspace, and never leaves their machine through Agentspace's
loopback-only service. Agentspace only transports conversation JSON.

## 7. Licence and distribution constraints (inspected, not legal advice)

- Codex CLI is **Apache-2.0** (licence file read directly from
  github.com/openai/codex). Spawning its permissively licensed binary as a
  subprocess places **no Agentspace-side obligations** (it is not linked,
  bundled or modified by Agentspace). If Agentspace ever *ships* a copy of
  the Codex binary or source-derived artifacts instead of running the
  user's installed one, Apache-2.0 §4 requires retaining the licence file,
  attribution NOTICE contents and marked changed files — that decision has
  **not** been made and no legal clearance is claimed here.
- Herdr (repository Apache-2.0; the npm name `herdr` itself is a reserved
  AGPL-3.0 placeholder with no code) is likewise subprocess/integration
  rather than dependency. Its socket *protocol* is callable without
  embedding herdr code. The AGPL marker applies only to that unused empty
  npm package; herdr-defined AGPL obligations therefore do not attach
  through this integration. If herdr were ever vendored, the Apache-2.0
  binary (not the npm stub) is the thing to vendor and its NOTICE/attribution
  requirements would then apply. No clearance is claimed.
- Dependency-report hygiene (factory standard): Agentspace's npm package
  has **no new dependencies** as part of this issue and must not gain any
  for the first adapter; the child binary `codex` is a user-supplied
  runtime tool like git, not an npm dependency.

## 8. Herdr evaluation

Herdr is a terminal workspace multiplexer for coding agents ("the runtime
your coding agents live on", README). Evidence on whether it is useful for
this integration:

**What it offers structurally.** Herdr exposes a documented local socket
API with a per-install **JSON Schema** (`herdr api schema --json`) covering
requests, responses, events and subscriptions (Socket API doc, "Schema").
It has structured agent-state reporting:
`pane.report_agent` with `state: "working" | "blocked" | …` semantic values,
native session references via `pane.report_agent_session` (`source:
"herdr:codex"`, `agent_session_id`), and a server-owned, event-driven
`agent.wait` that "pins the resolved pane occupant so a replacement cannot
satisfy the wait". Session restore can re-attach supported agents after a
server restart via a structured `resume_argv` (length/charset-validated).
The app-server doc cross-links this surface as the place to enhance
third-party agent integrations.

**What it does not offer for this integration.** Herdr's control surface
for third-party agents is deliberately **terminal-scoped**: `pane.send_text`,
`agent.send_keys`, `agent.prompt` submit into the pane's terminal, and
reading agent state (`agent.read`, `pane.read`) is reading rendered
terminal content. There is **no structured approval request/response
method**: an approval prompt Codex prints in its terminal is no more
machine-readable inside Herdr than outside it. So an adapter built on
Herdr would reintroduce exactly the ambiguity the workorder forbids
assuming ("Do not assume terminal output scraping provides a reliable
approval protocol"). Herdr also cannot deliver the app-server's typed
approval payloads — that surface is stdio, not a terminal.

**Conclusion on Herdr.** Useful as an *optional human-view layer* (its
`pane.report_agent` state mapping could be republished from the adapter's
own state, giving operators pane roll-ups without any scraping *by this
adapter*), and as session-restoration glue if a future issue wants pane
restoration. But it is **not the integration transport** and does not
solve approvals. First adapter: stdio app-server, no Herdr dependency.

## 9. Safety boundaries (explicit requirements for any future adapter)

The following are **requirements** for the first real-agent adapter, and
this issue's acceptance condition is that they are written down, not that
runtime code enforces them yet (no adapter code ships in this issue):

- **No permission bypass.** The adapter must never set
  `approvalPolicy: "never"`, `--sandbox danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox`, or any equivalent
  documented bypass flag, must never auto-approve, and must map every
  app-server approval request onto an explicit Agentspace pending question
  requiring an operator decision — or reject the turn by declining the
  approval. It must never modify the user's `CODEX_HOME` config.
- **No automatic dangerous-action approval.** Approvals are surfaced, not
  implied. An empty pending-question queue is never an implicit "yes".
- **No credential collection.** The adapter never reads, stores or
  transmits OpenAI/Codex credentials, tokens, or `CODEX_HOME` contents.
- **No control of factory workers outside guarded tools.** The adapter is
  Plumbing between Agentspace core state and a specific agent's protocol;
  it must not spawn arbitrary other processes, must not invoke factory
  infrastructure (`pr-gatekeeper`, git remotes, CI) and must not reach the
  network itself beyond the child Codex process on the user's behalf.

## 10. Live acceptance test: to be defined exactly, then exercised

**Not yet exercised. Required but not yet available: a host with the Codex
CLI installed and an authenticated Codex account (ChatGPT sign-in or API
key) at `$CODEX_HOME`; no such host access or credential exists in this
working environment, so no real session was started for this issue.**

Reproducible procedure, once credentials are available (all commands are
documented in the sources cited above):

1. **Two real sessions.** Start two adapters, each spawning its own
   `codex app-server` child (isolated `$CODEX_HOME` per user). Create
   a `thread/start` per Agentspace session and record
   `(sessionId, threadId)` pairs.
2. **Structured question.** Send a task via `turn/start` with an
   input item that asks Codex a question the operator must answer
   (for example, a task whose environment prompts an approval). Verify the
   adapter receives `item/started`/`item/completed` notifications carrying
   structured `item.id` values, and that a pending Agentspace question
   appears with the exact `threadId`/`turnId`/`itemId` recorded.
3. **Routed response.** On the Agentspace web page, submit an answer
   (an approval decision or reply text). Verify the exact JSON-RPC
   response/request id reaches the correct `threadId`, that Codex's
   subsequent `turn/completed` reflects it, and that the Agentspace
   receipt goes `unacknowledged` → `acknowledged` only via the exact
   `acknowledge` coordinates.
4. **Stale reply.** Between steps 2 and 3, ask a *new* question so the old
   Agentspace revision is superseded; then submit an answer for the old
   revision and verify the core rejects it (`revisionMismatch`) and that
   **no app-server call is made** (assertable by the adapter logging zero
   writes to the child's stdin for that reply).
5. **Disconnect.** Kill one `codex app-server` child mid-turn; verify the
   adapter emits `sendEvent(sessionId, { type: "disconnected" })`, the core
   rejects further asks/replies on that session (`sessionClosed`), and
   pending receipt states on the closed session remain readable via
   `getSessionState`.
6. Record the inspected `codex --version` output and the
   `codex app-server generate-json-schema` artifact hash alongside results.

Every step above either maps Userspace core semantics to documented
app-server behavior (steps 2–4) or to the documented process model required
by code the adapter will own (step 5). Nothing in it requires terminal
scraping, credentials embedded in Agentspace, or changes to any factory
worker.

## 11. What this issue does not ship

- No adapter code, no terminal scraping, no subprocess control of agents
  from Agentspace.
- No added npm dependencies; `npm test` passes unchanged.
- No real-agent credentials, hosts, accounts or availability assumptions —
  step 6 above records that the live procedure has not been run here.
- No claim that the app-server protocol is stable for production workloads:
  the documented caveat is retained and the adapter decision (if and when
  one is specified for implementation) must carry the opt-in and
  experimental label this document requires.
