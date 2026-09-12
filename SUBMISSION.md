# Durable Coworker — submission

**The model never holds the send button.**

Repo: https://github.com/mannadamay12/durable-coworker

---

## One-liner (≤280 chars)

A Slack coworker whose work survives process death without doing the dangerous thing
twice. Reversible steps run freely; irreversible ones stop for a named human. Kill the
worker mid-job, restart it, and it resumes without re-sending the email.

## Description

### The problem

Agents keep the plan, the progress, and the evidence in the model's context window.
When the process dies, the only recovery is to run the job again, and that is unsafe
once a step has already emailed a customer or written to a CRM.

Retries are at-least-once. Side effects are not idempotent by default. Protocol-level
recovery (a job runner restarting a task) says nothing about business-level recovery
(whether the customer already got the email).

### What it does

In a Slack thread, `@Angie take this THREAD-ACME-OUTAGE` opens a work order. The agent
reads the thread, researches, drafts the customer email and creates follow-up tasks.
Then it stops. It cannot send. It posts an approval card with the full recipient,
subject, body and the constraints it extracted ("do not promise a credit"). Only an
allowlisted approver can press Approve. One email leaves.

Kill the worker at any point. Restart it. Completed steps are not re-run, tasks are not
duplicated, and a second Approve on an already-sent email returns the existing receipt.

### How

Three guarantees, kept in three separate places:

| Guarantee | Question | Lives in |
|---|---|---|
| Progress | Where was I? | Step list on the work order (SQLite) |
| Side effect | Did the world already change? | Ledger keyed by `woId:stepId:tool:sha256(args)` |
| Decision | Did a human already say yes? | Ledger approval, written only from a Slack click by an allowlisted user ID |

- **The model never holds an irreversible tool.** Not gated, not wrapped: absent. It can
  only write a `proposed` commit with frozen arguments into the work order.
- **The classification is never trusted.** Any tool in `COMMIT_TOOLS` is forced to
  `commit` regardless of what the planner said, and the override is logged.
- **Only the committer writes a receipt.** A step marked done is not evidence a side
  effect happened. A retry of a committed key is a read that returns the receipt.
- **Reconciliation is exact.** The idempotency key is embedded in the side effect
  itself, so after a crash between "provider accepted" and "ledger written", recovery
  finds the artifact by exact marker instead of re-sending.
- **Ungroundable commits fail before proposal.** If the recipient is not a contact of the
  thread's customer, or the commit tool has no adapter, no approval card is ever shown.

A prompt injection in the thread cannot send an email because there is no code path from
model output to `mail.send`.

### What is new here

Human-in-the-loop pausing already ships in the CopilotKit Channels starter app. Our
contribution is what happens when that pause is **interrupted rather than answered**: the
worker is killed, a retry fires, an approval arrives twice, or the provider accepted a
send but the process died before recording it.

### Honest limits

- **At-least-once with a dedupe ledger, not exactly-once.** There is a real window between
  a provider accepting a send and the ledger write landing. We make recovery there exact
  (marker match) but do not close the window.
- **The mail provider is a local stub outbox.** No real email is sent.
- **Single machine.** Listener and worker share a local SQLite file. Multi-host needs
  shared storage.
- Diagnostic probes still reproduce known edge-case failures (listed below). They are not
  hidden.

### Built with

TypeScript on Node 22. CopilotKit Channels (Slack surface, native Block Kit cards),
Trigger.dev (the long job, kill and resume), an OpenAI-compatible SDK against OpenRouter
(planner and constraint extractor, structured JSON), Ambiguous over HTTP MCP (a live
work-order document), `node:sqlite` (work orders, ledger, outbox). No agent framework:
the agent is one structured model call.

---

## What is verified, and how

| Claim | Evidence | Where |
|---|---|---|
| Kill mid-run, resume at the right step, Slack bot stays alive | Live take 13:50: worker killed after step 3, run canceled with `[1,2,3]` kept, re-mention logged `RESUME (prior: 1,2,3)` and finished | Live Slack + Trigger.dev dev |
| One email and one CRM update committed; second Approve returned the same receipt | Live take 14:27, visible in the Slack thread | Live Slack (fixture flow, before PR #8/#9) |
| Mention → planner → persisted work order → Starting card | Live take 15:02 | Live Slack; worker did not pick the job up in that take |
| Kill/resume, non-approver rejected, retry reuses receipt, landed-but-unrecorded send reconciled, deny blocks | `src/core/kill.test.ts` | Offline, `npm run verify` |
| 4 customer threads grounded end to end; unsupported commit tool fails before proposal; empty thread creates nothing; kill/resume keeps 2 tasks; injection payloads leave the ledger `proposed`; `U_SAM` never approves | `src/core/scenarios.test.ts` | Offline, `npm run verify` |
| Late provider failure returns the stored receipt; planner failures are visible; mirror errors cannot fail the task or hold approval; Slack handler cards | recovery-core, recovery-planner, recovery-mirror, review-channel | Offline, `npm run verify` |
| Ambiguous document created and updated with a live key; invalid key does not reach the caller | Lane D check 14:47 | Live Ambiguous, standalone |

`npm run verify` on `014ecc8`: 11 / 11 checks pass (typecheck, kill-matcher,
core-kill-resume, dataset-scenarios, bundled-worker, planner-fixture, receipt-races,
planner-validation, mirror-isolation, slack-handlers, evidence-replay).

### Not verified live

- The hardened listener (PR #8) and dataset selectors (PR #9) have not been run through
  Slack. `DATASET_SLACK_USERS` is not yet set in the demo `.env`.
- A non-approver clicking Approve in Slack (needs a second Slack account).
- An injected thread message during a Slack run.
- The Ambiguous document on screen while the worker is killed.
- Deny from Slack.

### Known failing diagnostic probes

`scripts/review-core.mjs` (9 pass / 7 fail), `review-planner.mjs --strict` (10 / 9),
`review-mirror.mjs --strict` (3 / 6). The core failures, in plain words:

1. A provider request still in flight after its lease expires can be sent a second time.
2. Duplicate or separator-containing step ids passed directly to core (not via the
   planner, which normalises them) can alias one ledger row.
3. A quoted marker inside a different action's artifact can be mistaken for a receipt.
4. A torn last line in the JSONL outbox can hide the next artifact from reconciliation.
5. A step naming an unregistered reversible tool is recorded as done.
6. Two concurrent runners on one work order can each execute a reversible step.

## Not built

- Real mail provider (stub outbox only), real CRM.
- Reading Slack thread history. The mention must name its source explicitly
  (`take this THREAD-*` or `use fixture customer-success`).
- Durable Channels state store: an old approval card clicked after a listener restart
  is not guaranteed to dispatch; re-mention the thread instead.
- AG-UI companion viewer (a read-only local evidence viewer exists in `scripts/`).
- Checking the email body against constraints (only the recipient is validated).
- Adversarial constraint reviewer, proactive approver DM, multi-host deployment.
