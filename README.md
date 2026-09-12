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

_TBD_

## Docs

- `PRD.md` — scope, data model, build order, demo script
- `DECISIONS.md` — locked decisions and the reasoning behind them
- `CLAUDE.md` — invariants and working agreement
- `CHANGELOG.md` — build log and gate checklist
