# Demo runbook

Two minutes, no architecture narration. Protect the kill beat and the retry beat above
everything else.

## Before any take

1. `.env` has every key in `.env.example`, plus `DATASET_SLACK_USERS` mapping `U_MAYA` and
   `U_LEO` to two distinct real Slack user IDs (the approvers on `THREAD-ACME-OUTAGE`).
   Without it, a dataset mention is refused with a configuration message.
2. `npm run verify` passes.
3. `npm run kill:dry` lists only the Trigger.dev dev CLI and task processes, never the
   listener.
4. Screen layout: Slack thread (left), Ambiguous work-order doc (right), two terminals
   along the bottom.

## Between takes

```sh
npm run reset
```

Start a new Slack thread for every take. A work order id is bound to the conversation.

## Terminals

| Terminal | Command | Never |
|---|---|---|
| A | `npm run dev:channel` | Kill this. It owns the Slack gateway socket. |
| B | `npm run dev:worker` | — |
| C | `npm run kill` when cued, then restart B | — |

## Slack take (primary)

| Time | Beat | Action | What the viewer sees |
|---|---|---|---|
| 0:00 | Take this | `@Angie take this THREAD-ACME-OUTAGE` | Starting card with steps and constraint chips; doc appears in Ambiguous |
| 0:20 | Reversible work | Wait for steps 1–3 | Research and draft land in the doc; no email |
| 0:40 | Kill | Terminal C: `npm run kill` during step 3 or 4 | Interrupted card; Slack bot still responds |
| 0:50 | Resume | Restart B, re-mention the same thread | Resuming card; completed steps skipped; tasks not duplicated |
| 1:05 | Proposal | — | Awaiting approval card: To, Subject, full body, "do not promise a credit" |
| 1:15 | Unauthorized click | Second account (not mapped) clicks Approve | Not authorized card naming who can approve; nothing moves |
| 1:25 | Approve | Mapped approver clicks Approve | Committed card with receipt id; doc shows the receipt |
| 1:40 | Retry | Click Approve again on the same card | Already committed, same receipt, nothing sent |
| 1:50 | Close | `node --import tsx src/cli.ts outbox` | One row |

Unverified live after PR #8/#9: rehearse this once before filming. If the worker does
not pick the job up (Queued notice after 10s, as in the 15:02 take), restart terminal B
before continuing.

## CLI take (fallback, no Slack)

Every beat is built by driving the real engine, not by loading fixture rows.

```sh
npm run reset
node --import tsx src/cli.ts demo --thread THREAD-ACME-OUTAGE
```

Shows: 4 reversible steps done, proposal waiting on U_MAYA/U_LEO, `U_STRANGER` rejected,
commit with receipt, retry returns the same receipt, outbox 1.

Individual beats (each resets state first):

```sh
node --import tsx src/cli.ts load kill_before_approval
node --import tsx src/cli.ts load retry_send_already_committed
node --import tsx src/cli.ts load crash_between_provider_and_ledger
node --import tsx src/cli.ts load injection_still_proposed
node --import tsx src/cli.ts load deny_path
node --import tsx src/cli.ts show
node --import tsx src/cli.ts outbox
```

Kill/resume from the terminal (`demo` resets state first, so use `run`):

```sh
npm run reset
node --import tsx src/cli.ts run --thread THREAD-ACME-OUTAGE      # Ctrl-C during step 3
node --import tsx src/cli.ts run --thread THREAD-ACME-OUTAGE      # resumes, skips done steps
node --import tsx src/cli.ts approve --thread THREAD-ACME-OUTAGE --actor U_SAM   # rejected
node --import tsx src/cli.ts approve --thread THREAD-ACME-OUTAGE --actor U_MAYA  # receipt
node --import tsx src/cli.ts approve --thread THREAD-ACME-OUTAGE --actor U_MAYA  # already committed
node --import tsx src/cli.ts outbox
```

This sequence has not been rehearsed by hand; `src/core/scenarios.test.ts` covers the same
kill/resume path with a SIGKILL.

## Lines to say, if any

- "The model never holds the send button."
- "Human-in-the-loop pausing already exists. This is what happens when the pause is
  interrupted instead of answered."
- "At-least-once with a dedupe ledger. Not exactly-once."

Do not say: exactly-once, guaranteed, never duplicates, or any statistic.
