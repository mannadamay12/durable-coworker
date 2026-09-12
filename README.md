# Durable Coworker

**The agent never holds the send button.**

An agent that runs a multi-step job from a Slack thread, pauses on anything
irreversible, and can be killed mid-flight without losing progress or double-sending
the email.

---

## The problem

Agents keep the plan, the progress, and the evidence in the model's context window.
That is RAM. When the process dies the plan dies with it, and the only recovery
available is to run it again. Running it again is exactly the thing you cannot safely
do once a step has already emailed a customer.

Retries are at-least-once. Side effects are not idempotent by default. Protocol-level
recovery says nothing about business-level recovery.

## The approach

Three guarantees, kept separate:

| Guarantee | Question | Lives in |
|---|---|---|
| Progress | Where was I? | Step list on the work order |
| Side effect | Did the world already change? | Ledger, keyed by idempotency key |
| Decision | Did a human already say yes? | Waitpoint completed by a Slack click |

The structural move: irreversible tools are never in the model's toolset. The model can
only write a `proposed` commit into the work order. A committer function with no model
in it executes after an allowlisted human approves.

That is why a prompt injection in the thread cannot send an email. There is no code
path from model output to `mail.send`.

## What this is not

This is at-least-once with a dedupe ledger, not exactly-once. There is a real window
between a provider accepting a send and the ledger write landing. Recovery there is
reconciliation, which we make exact rather than heuristic by embedding the idempotency
key inside the sent artifact.

Human-in-the-loop pausing already ships in the CopilotKit Channels starter app. The
contribution here is what happens when the pause is interrupted rather than answered.

## Running it

Install dependencies, set the required values in `.env`, then run the deterministic
checks before starting either process:

```sh
npm install
npm run typecheck
npm run test:datasets
npm run test:bundle
```

The CLI can create and inspect a grounded dataset work order without Slack:

```sh
npm run reset
node --env-file=.env --import tsx src/cli.ts demo --thread THREAD-ACME-OUTAGE
node --env-file=.env --import tsx src/cli.ts show --thread THREAD-ACME-OUTAGE
```

In Slack, source selection is explicit because the listener receives only the
mention text, not the thread history. Start a new conversation with
`@Angie take this THREAD-ACME-OUTAGE` (or another seeded `THREAD-*` ID), or use
`@Angie use fixture customer-success` for the planner-backed legacy fixture.
Dataset mentions require `DATASET_SLACK_USERS`, a JSON object mapping every
synthetic approver to a real Slack user ID. Two real humans can cover several
dataset personas across separate scenarios; two approvers on one work order must
still map to different real IDs. The requester is never added automatically.

For the full offline gate, run `npm run verify`. It records each command and a
source fingerprint under `state/verification/` and refuses to report a pass if the
source changes during the run.

## Docs

- `PRD.md` — scope, data model, build order, demo script
- `DECISIONS.md` — locked decisions and the reasoning behind them
- `CLAUDE.md` — invariants and working agreement
- `CHANGELOG.md` — build log and gate checklist
