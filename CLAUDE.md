# CLAUDE.md

Working agreement for this repo. Read this before writing any code.

This is a hackathon build with a hard stop. Submission is due at 15:30 local.
Optimise for a working demo, not for coverage.

---

## What this project is

A coworker whose work survives process death without doing the dangerous thing twice.

An agent runs a multi-step job triggered from a Slack thread. Reversible steps run
freely. Irreversible steps stop and wait for a named human. The process can be killed
at any point and resumed without replaying a side effect.

One sentence for any reviewer: **the model never holds the send button.**

---

## Invariants

These are not preferences. Breaking one of these breaks the project.

1. **The model never holds an irreversible tool.** Not gated, not wrapped, not present
   in its toolset. It can only write a `proposed` commit into the work order.
2. **Any tool in `COMMIT_TOOLS` is forced to `kind: 'commit'`** regardless of what the
   model classified it as. Log every override. A model that mislabels `mail.send` as
   reversible must not be able to grant itself send access.
3. **Only the committer writes `externalId`.** A step marked `done` is not evidence a
   side effect happened. An approval is not evidence a side effect happened.
4. **A retry of a committed key is a read.** It returns the existing receipt.
5. **Approval requires an allowlisted Slack user ID.** Anyone can click. Only an
   approver on the work order moves a step.
6. **Kill the Trigger.dev worker, never the Channels listener.** The listener owns the
   persistent Slack gateway connection. Killing it makes the bot go silent and the
   demo reads as a crash instead of a resume.
7. **`src/core/` imports nothing from Slack, Trigger.dev, Ambiguous, or OpenAI.** It is
   pure functions over the work order and the ledger, runnable from `cli.ts`.
8. **`npm run reset` must work from the first hour.** We will film this six to ten
   times. A second take that starts with a committed ledger is a dead demo.

---

## Architecture

```
src/
  core/        workorder, ledger, committer, tool registry, step machine
  agent/       openai calls: planner, constraint extractor
  tools/       ambiguous mcp client + stubbed outbox
  jobs/        trigger.dev task definitions
  channel/     copilotkit channels listener (long-running, Node 22+)
  cli.ts       run a work order end to end from the terminal, no Slack
scenarios/     synth fixtures
state/         sqlite + outbox (gitignored)
```

Two processes at runtime. Terminal A runs the Channels listener. Terminal B runs the
Trigger.dev dev worker. `npm run kill` kills only B.

`cli.ts` is not a nicety. It is the fallback demo. If Channels does not come up, a
terminal recording of kill and resume with the Ambiguous doc on screen is still a
valid submission.

---

## Stack

All TypeScript. Node 22 or later (the Channels managed launcher needs the global
WebSocket). No Python anywhere, including scripts.

- `@copilotkit/channels`, `@copilotkit/runtime` — Slack surface, native Block Kit
- `trigger.dev` — the long job, waitpoints, retries
- `openai` — planner and constraint extractor, structured outputs, temperature 0
- Ambiguous via HTTP MCP at `https://app.ambiguous.ai/mcp`, bearer token
- `better-sqlite3` — the ledger

Do not add LangGraph, CrewAI, or any agent framework. The agent is one OpenAI call
that returns JSON.

---

## How Claude should work in this repo

- Build `core/` first and prove kill and resume from `cli.ts` before touching Slack.
- Stub every external tool. `mail.send` writes to a local outbox and returns a fake
  `externalId`. Swap to real Ambiguous `mail.*` only when the kill test is boring.
- Do not refactor for elegance. There is no time and no second commit.
- Keep `DECISIONS.md` and `CHANGELOG.md` current. See "End of session" below.
- Do not write tests beyond one assertion script for the kill test. That one matters.
- If something is taking longer than its time box in `PRD.md`, say so and propose the
  cut rather than pushing through.

## End of session

Before ending any working session, update `DECISIONS.md` and `CHANGELOG.md`. This is
not optional and does not need to be asked for.

**`DECISIONS.md`** gets an entry for every decision made during the session that
constrains future work: a technical choice, a scope cut, a policy call, a reversal. One
entry per decision, with the reasoning and what it rules out. Append only. If a
decision reverses an earlier one, add a new entry referencing the old number rather
than editing it.

Do not record: implementation details that are visible in the code, things considered
and not chosen, or restatements of decisions already in the file.

**`CHANGELOG.md`** gets a line for each milestone reached or cut made, newest at the
top, in the format `HH:MM — what changed — what it unblocks or what it cost`. Tick any
gate that now passes. Add cuts to the cuts section as they happen, not from memory
later.

Report what was written in one or two lines. Be factual about state: if a gate was
attempted and failed, record the failure rather than leaving it unticked without
explanation. A changelog that only contains successes is useless at 15:00 when the
submission description has to describe what actually works.

## Honesty rules for anything written about this project

- Never claim exactly-once. It is at-least-once with a dedupe ledger. There is a real
  window between the provider accepting and the ledger write landing.
- Do not cite statistics we cannot source. State the problem as engineering fact:
  retries are at-least-once, side effects are not idempotent by default, protocol
  recovery says nothing about business recovery.
- Human-in-the-loop pausing is already in the Channels starter app. Our contribution
  is what happens when the pause is interrupted rather than answered. Say so plainly.
