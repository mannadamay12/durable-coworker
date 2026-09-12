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
