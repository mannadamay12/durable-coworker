# Decisions

Append-only. One entry per decision, with the reasoning and what it rules out.
If a decision gets reversed, add a new entry rather than editing the old one.

---

## D1. All TypeScript, no Python

Both load-bearing pieces are TypeScript: `@copilotkit/channels` (Node 22+, long-running)
and Trigger.dev. Adding Flask would mean a second runtime, a second deploy target, and
an HTTP hop sitting exactly where the state model lives. Every process boundary is a
place the demo breaks.

The only argument for Python would be using LangGraph or CrewAI as the AG-UI agent. We
do not need a framework agent. The agent is one OpenAI call returning JSON.

Rules out: Flask, LangGraph, CrewAI, any Python script including fixture generation.

## D2. `src/core/` has zero integration dependencies

Pure functions over the work order and ledger. No imports from Slack, Trigger.dev,
Ambiguous, or OpenAI.

Two reasons. Kill and resume can be proven from `cli.ts` in the first hour, before any
integration exists. And if Channels does not come up, a terminal recording is still a
submission.

## D3. Kill the Trigger.dev worker, never the Channels listener

The listener owns the persistent Slack gateway connection. Killing it makes the bot go
silent and never return, which on video reads as a crash rather than a resume.

`npm run kill` targets only the worker. This is verified before any feature work.

## D4. Resume is re-trigger with the same work order ID

Resume works by re-triggering the task with the same `workOrderId`, reading the record,
and skipping completed steps. If Trigger.dev checkpoint and resume happens to work
locally, that is a bonus, never a dependency.

Rules out: any demo beat that depends on CRIU behaving.

## D5. SQLite is truth, the Ambiguous doc is a mirror

Truth cannot live behind an HTTP call we might not get back. If the doc were
authoritative, a network blip during filming becomes a correctness bug on video.

The doc still matters: it is what is on screen when the process dies, which is what
makes the durability visible.

## D6. The model never holds an irreversible tool

In the reversible phase the model has `search`, `draft`, `write_to_work_order`. In the
commit phase it has nothing. A separate committer function with no model in it executes
after an allowlisted human approves.

This is why a prompt injection in the thread cannot send an email. There is no code
path from model output to `mail.send`.

## D7. Model classification is never trusted

The planner tags each step `reversible` or `commit`. Any tool in `COMMIT_TOOLS` is
forced to `commit` regardless, and the override is logged with `classifiedBy:
'allowlist_override'`.

A model that labels `mail.send` as reversible must not be able to grant itself send
access. The caught override is also a demo beat.

## D8. The model's job is classification, not drafting

The structural critique of this project is that the LLM is decorative: replace it with
`sleep 600` and a hardcoded string and the video looks identical. The answer is to make
the model's output load-bearing. Step classification and constraint extraction both
feed the safety boundary. Drafting is incidental and is not pitched.

## D9. Idempotency key embedded in the side effect

There is no documented idempotency key on Ambiguous `mail.send`, which would normally
make reconciliation a fuzzy match on recipient and subject. So we write our own key
into the artifact: a marker line in the email body.

Reconciliation becomes an exact string search over sent mail. Two lines of code, and it
closes the gap most designs hand-wave.

## D10. At-least-once, stated openly

This is at-least-once with a dedupe ledger, not exactly-once. There is a real window
between the provider accepting a send and the ledger write landing.

We say this in the video and the README. A reviewer who has shipped this recognises the
claim immediately, and teams claiming exactly-once lose credibility with the same
reviewer.

## D11. Deny stops the job

A denied commit blocks the work order and posts a card naming who stopped it. No
policy-driven continuation. Simpler, and the safer default.

Timeout does the same with a different reason. It must never fall through to a send.

## D12. Stub `mail.send` first

It writes to a local outbox and returns a fake `externalId`. A visible outbox with one
row is more legible on video than a real inbox, and it removes the largest integration
risk from the critical path. Swap to Ambiguous `mail.*` only if the kill test is boring
by the time budget says so.

## D13. Mint our own Ambiguous workspace

The config on the Ambiguous docs page points at a shared workspace that resets weekly.
Using it would mean strangers' documents in the screen recording and a work order that
can vanish. `npx ambiguous auth signup` to mint a dedicated key.

## D14. `npm run reset` exists from hour one

Wipes SQLite, clears the outbox, recreates the doc. Filming takes six to ten attempts
and a second take starting with a committed ledger is a dead demo. This is the most
commonly skipped thing and it burns teams at 14:50.

## D15. Mobile approval is a Slack DM

A DM to the approver already pushes to their phone through the Slack app. Send the
approval card as a DM alongside the thread card. Zero infrastructure, real claim.

Rules out: building any push notification system.

## D16. No sponsor mapping table in the submission

It reads as prize farming and discounts everything around it. Sponsor fit stays in
working notes.

## D17. The runId is a hash of `thread.conversationKey`, not the Slack `thread_ts`

CopilotKit Channels does not expose Slack's `thread_ts`. `ReplyTarget` is declared
`unknown` ("opaque to the channel core"), the Slack adapter resolves
`{channel, threadTs}` internally without forwarding it, and the docs explicitly say not
to parse `conversationKey` for workspace, channel or thread ids.

`conversationKey` is documented as the stable per-conversation key and is what the SDK
itself uses to map a conversation to a durable agent thread across restarts. So the
runId is `sha256(conversationKey).slice(0, 12)`: same thread gives the same runId after
a restart, and unlike the raw key it is filesystem-safe.

Rules out: any design that needs the real Slack channel or thread id, including posting
to a thread we were not handed a `Thread` handle for.

## D18. Never use Trigger.dev `idempotencyKey` for resume

`tasks.trigger()` has no run-id option — the full option set is `idempotencyKey`,
`idempotencyKeyTTL`, `maxAttempts`, `queue`, `concurrencyKey`, `delay`, `ttl`,
`priority`, `tags`, `metadata`, `maxDuration`, `machine`, `version`,
`externalDeploymentId`, `region`, `debounce`.

`idempotencyKey` looks like the resume primitive and is a trap. Re-triggering with the
same key returns the *original* run's handle rather than starting a run. Failed runs
clear their key, but **canceled ones keep it** — and killing the dev CLI gets the run
`CANCELED` by Trigger.dev's watchdog within about a second. So a second trigger would
hand back a dead run and silently execute nothing: the demo would appear to do nothing
on the resume beat.

The logical runId therefore travels in the payload, the run is tagged `smoke:<runId>`
for lookup, and every resume is a fresh Trigger.dev run. This is D4 restated with the
mechanism pinned down. Also `ttl: 0` on every trigger: dev runs default to a 10-minute
TTL, so a resume queued more than ten minutes after the kill would expire unexecuted.

## D19. The listener posts the closing card, not the task

The Trigger.dev task has no Slack connection, and `Thread` is a live handle that cannot
be serialized across a process boundary. So the listener subscribes to the run it
triggered (`runs.subscribeToRun`) and posts the finished/interrupted card itself.

This also makes the interrupted card possible at all: the only process that can report
"the worker died" is the one that did not die. It reinforces invariant 6 rather than
working around it.

Rules out: an HTTP callback from the worker into the listener, and any design where the
job needs Slack credentials.

## D20. `npm run kill` leaves Trigger.dev's watchdog alive

Trigger.dev spawns a detached watchdog that polls the dev CLI's pid and cancels
in-flight runs when it dies, specifically to survive `SIGKILL`. Killing it too would
drop recovery onto the 30-second heartbeat with a 5-minute timeout, which is unfilmable.
So the kill script excludes it and we get `CANCELED` in about a second instead.

`devWatchdog.js` sits under `.../dist/esm/dev/`, so any matcher keyed on a bare `dev`
path segment kills it by accident. That specific case is pinned in
`scripts/kill-worker.test.mjs` along with the listener exclusion. The kill is also
scoped to the current project root so a dev worker for another repo on the same machine
survives.

## D21. The mention handler awaits the run watch

Refines D19. In managed Channels a `Thread` is only writable while its delivery is open,
and the delivery seals the moment the handler returns: any later `thread.post` rejects
with `ChannelDeliveryOperationsClosedError`. There is no public API to post to a thread
outside a delivery (the `Channel` interface says channels are runtime-driven only). So
the handler stays inside `runs.subscribeToRun` until the run is terminal, and posts the
closing card before returning.

Cost: one delivery slot held per running job. The transport allows 8 concurrent
deliveries by default and store concurrency defaults to `parallel`, which is fine for a
demo with one job at a time.

Rules out: fire-and-forget watchers, and any job that runs longer than we are willing to
hold a delivery open (a long human approval wait will need a different posting path).

## D22. OpenRouter is the model provider, not a failover

PRD section 9 lists "OpenRouter failover" on the cut list. Reversed: there is no OpenAI
API key available, so OpenRouter is the primary and only path. Codex credits are a
subscription for their coding agent and cannot authenticate an API call.

It is OpenAI-API-compatible, so this costs one `baseURL` override on the client we
already installed. Two non-obvious requirements come with it: `provider:
{ require_parameters: true }`, because the same model is served by many endpoints and
only some honour strict structured outputs, and a JSON-parse retry, because enforcement
is per-endpoint rather than platform-wide. Model pinned to `google/gemini-3.8-flash`,
whose endpoints all support structured outputs.

Rules out nothing we wanted. The risk it adds is one more provider between us and a
classification, which is why the planner keeps a deterministic fallback and the
COMMIT_TOOLS override stays model-free.

## D23. Provider-native email idempotency supersedes D9's discovery premise

The 2026-09-12 review authenticated to the configured Ambiguous MCP server using only
`initialize` and `tools/list`. Its advertised `send_email` schema includes
`Idempotency-Key` and `idempotency_key` (maximum 255 characters), same-payload receipt
reuse and a conflict for a different payload. The public API contract agrees. D9's
statement that there is no documented native key is therefore superseded; its
requirement for reconciliation evidence remains useful.

Any real mail adapter should map our internal `mail.send` explicitly to this provider
operation and use the native key contract, retaining reconciliation for unknown
outcomes. A marker in arbitrary body text is insufficient as the sole identity proof.
This rules out promoting the current substring-only stub reconciliation to a real
provider guarantee. Discovery is not a send test; scope, retention, duplicate and
conflicting-payload behavior still require controlled provider acceptance tests.

Evidence and source references: `notes/review-ambiguous-capabilities.json` and
`notes/review-datasets-integrations.md`. No provider tool was executed in this review.

## D24. Review observation has no execution authority

The review's companion viewer reads an explicit state directory and replays captured
core checkpoints. It exposes no approval, reset, model invocation or send endpoint.
This makes inspection and browser reconnection safe to repeat while the main build
continues. Its local stub replay and separate live-model probes are labeled distinctly.

An eventual AG-UI observer should preserve this separation: stream projections of
durable facts, and send authenticated human commands through the existing backend
authorization boundary. UI state patches or replayed events do not grant commit
authority. The review prototype is not a deployed AG-UI implementation.

## D25. `node:sqlite`, not `better-sqlite3`

The ledger and work orders live in `state/durable.db` through Node's built-in
`node:sqlite`. No native build, which already cost time today with a wrong-platform
`node_modules`, and Trigger.dev's bundler keeps it external. `better-sqlite3` stays in
`package.json` unused.

The database is opened per call, never held. `npm run reset` deletes `state/`, and a
long-lived handle in the listener would keep writing to the deleted file.

Rules out: deploying on Node older than 22.13. Prints one ExperimentalWarning per process.

## D26. An approver's `commit()` on a proposed entry is the approval

The Approve click calls `commit(woId, stepId, actor)` directly. For an allowlisted actor on
a `proposed` entry, core records the approval and sends in one transaction, after the
authorization check. There is one proposal per commit step and its args are frozen at
proposal time, so the approver approves exactly what is sent.

Rules out: a separate `approve()` round trip from Slack, and editing commit args after the
card is posted. Callers must not `putWorkOrder` after creation: it is last-write-wins on
the whole record.

## D27. Planner falls back to a deterministic stub; the override is always real

When OpenRouter fails or `PLANNER_MODE=stub`, `plan()` returns the scenario fixture and
logs `Classifier stubbed, override real.` `enforceCommitTools` runs on every output from
either path, and core enforces `COMMIT_TOOLS` again on create, put and run.

`classifiedBy: "allowlist_override"` is set on every `COMMIT_TOOLS` step, including when
the model already said `commit`. The planner schema's `tool` is an enum, so a near-miss
like `mail_send` cannot slip past the exact-match check.

Rules out: describing constraints or classification as model-extracted for any run that
logged the stub line, and using `classifiedBy` as a "model was wrong" badge (the
`[planner] OVERRIDE` log line is that signal).

## D28. The mentioning user is an approver, and planning uses the fixture thread

Channels passes the mention's own text, not the thread history. The listener plans from
`scenarios/customer-success.json` `threadText` unless the mention is over 80 characters.
Approvers are the mentioning user plus `APPROVERS` from the environment.

Rules out: claiming the planner read the live Slack thread, and presenting the demo as
separation of duties (the requester can approve their own send).

## D29. The mirror always writes `state/workorder.md`

`mirror(wo)` writes the rendered work order to `state/workorder.md` on every call, and also
upserts an Ambiguous doc when `AMBIGUOUS_API_KEY` is set and `MIRROR_MODE` is not `file`.
Doc ids live in `state/mirror-docs.json`, not SQLite, so core stays free of Ambiguous
(invariant 7) and `npm run reset` gives each take a fresh doc. Commit paths call
`mirrorSoon(wo)`, never an awaited `mirror()` (D5).

Rules out: a demo that depends on Ambiguous being reachable. A kill between doc creation
and the id write leaves an orphan doc.

## D30. Planner step ids are rewritten to `N-slug`

`plan()` ignores the model's id beyond its slug and assigns `${position}-${slug}` with only
`[a-z0-9-]`. Ledger lookups match on the `${woId}:${stepId}:` prefix, so a colon, a duplicate,
or an empty id from the model could alias another step's receipt.

Rules out: model-chosen step ids reaching the ledger verbatim.

## D31. `outcome_unknown` stays pending for a human, never auto-resolved

`pendingApproval` includes `outcome_unknown` entries, so the approval card is re-posted with an
"Outcome unknown" header. Approving again after the 30s stale window reconciles against the
outbox before any resend. The `outcome_unknown` write can never overwrite `committed`.

Rules out: a work order reporting "Finished" while a send is unconfirmed.

## D32. The Trigger.dev task mirrors every 1s while running; listener mirrors after commit and deny

Core cannot import the mirror (invariant 7), so the callers drive it. Stub customer data is
aligned to `scenarios/customer-success.json` (Northwind Logistics, Dana Okafor, INC-4471).

Rules out: the Ambiguous doc lagging a kill by more than about a second.

## D33. AG-UI companion viewer cut

Not built. 15:18 with submission at 15:30; the mirror doc is the only live view of persisted state.

## D34. Verification follows the captured source, including uncommitted changes

While main is being edited in parallel, a commit SHA alone does not identify the tested
implementation. Review evidence records source hashes and whether a check asserts a
desired invariant or intentionally reproduces an existing defect. A fixed defect can
therefore break an old characterization assertion without being a regression.

Rules out: applying earlier passing results to later edits, treating imported recovery
JSON as tested engine state, or calling a characterization suite a correctness gate
without updating its expectations. This is a verification policy; it introduces no
application behavior or new runtime architecture.

## D35. A dataset thread id in `WorkOrder.scenario` is the grounding key

`contract.ts` stays frozen. When `scenario` names a thread in `datasets/threads.json`,
research, draft, tasks, constraints and the frozen proposal all come from that thread and
its customer (`src/core/context.ts`). Any other scenario (`customer-success`) keeps the
Northwind stub unchanged, so the kill test and listener behave as before.

Rules out: a new customer field on the work order, and the executor inventing content
for a dataset thread.

## D36. No cross-customer fallback; ungroundable commits fail before proposal

If a dataset thread has no source draft, its recipient is not a contact of its customer,
or its commit tool is not in `COMMIT_TOOLS`, the commit step is marked `failed` and no
ledger row is written. `THREAD-NORTHWIND-STATUS` (`status.publish`) fails this way on
purpose. Threads with no customer or no approver (`THREAD-EMPTY`) create no work order.
`THREAD-ACME-REFUND` has no source draft in the pack, so it uses a decline template
built only from the thread and customer fields.

Rules out: substituting another customer's draft or recipient to reach an approval card.

## D37. Recovery beats are built by driving the engine, not by loading fixture rows

`buildRecovery(beat)` uses only the thread id, work order id and approvers from
`work_order_fixtures.json`, then runs the real `runReversible` / `approve` / `commit` /
`deny` path (the crash window replays the tool call without the ledger write, as the kill
test does). The fixtures' hand-written ledger keys and statuses are ignored.

Rules out: ledger keys that do not match `idempotencyKey()`, such as the imported
`WO-1842-KILL` row keyed `WO-1842:...:sha256:acme-dana-v1`.

## D38. Second assertion script: `src/core/scenarios.test.ts`

This relaxes the single assertion script rule for one script. It is the acceptance gate
for dataset grounding and the README "assertions the tests should lock". It uses the kill
test's pattern: isolated `STATE_DIR`, plain `assert`, no framework.

Rules out: adding further test files without a similar gate-level reason.
