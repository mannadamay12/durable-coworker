# Recovery hardening handoff

This branch starts at `9a3fff8` and closes the immediate correctness gaps found while
reviewing the merged Slack, planner, core and mirror changes. No provider, Slack, or
Ambiguous calls are made by the regression suites.

The core committer now re-reads the authoritative ledger after a provider response. A
late throw, missing receipt, or different late receipt returns the stored winning receipt
without replacing its terminal timestamp. A caller that actually invoked the provider
reports `reused: false`; a later read-only retry reports `reused: true`.

The planner has an explicit mode boundary. `PLANNER_MODE=stub` is the only way to select
the deterministic Northwind demo fixture. Default/model mode requires a configured model,
validates the parsed plan and constraints locally, assigns application-owned step IDs, and
fails visibly without creating a work order when the provider is unavailable or malformed.

The Slack card now hides Deny after an attempt may have happened, labels reconciliation as
such, preserves uncertainty in error cards, and coalesces concurrent continuation watches
inside one listener process. Reused receipts advance to the next proposal or reversible
phase only after the actor is re-authorized. This is process-local coalescing; it is not a
distributed execution lock.

Mirror polling catches the full read-and-project callback. Local Markdown snapshots are
written immediately and remote document projection remains best effort, so a slow provider
cannot hold an approval card or crash the worker. Remote projection is still process-local
and may be interrupted with the worker; it is not a durable outbox or cross-process lock.

## Verification

Passed on Node 25.5.0 with isolated temporary state:

- `npm run typecheck`
- `npm run test:kill` (13 matcher cases)
- `node --import tsx src/core/kill.test.ts`
- `PLANNER_MODE=stub node src/agent/plan.test.mjs`
- `node --import tsx scripts/recovery-core.test.mjs` (4 receipt races)
- `node --import tsx scripts/recovery-planner.test.mjs` (34 planner boundary checks)
- `node --import tsx scripts/recovery-mirror.test.mjs` (7 task/mirror isolation checks)
- `node --import tsx scripts/review-channel.mjs` (16 handler/protocol checks)
- `node scripts/review-demo.mjs` (six-checkpoint local replay)

The diagnostic probes remain useful and intentionally report unresolved behavior. At this
revision, `review-core.mjs` reports 9 pass / 7 fail, `review-planner.mjs --strict` reports
10 pass / 9 fail, and `review-mirror.mjs --strict` reports 3 pass / 6 fail. The remaining
failures cover expired-lease duplicate sends, direct-core separator/duplicate IDs, global
outbox reconciliation, unsupported tools, concurrent reversible runners, provider endpoint
and protocol handling, and cross-process document uniqueness. They are not hidden by this
branch.

