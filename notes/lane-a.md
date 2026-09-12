# Lane A: core, committer, tools, trigger task, CLI

## What other lanes call

- Trigger task id **`workorder`**, payload **`{ woId }`**. Trigger with `ttl: 0` and no
  `idempotencyKey` (D18). Output: `{ woId, steps: [{id, status}], pendingStepId }`.
  Resume is re-trigger with the same `woId`.
- `createWorkOrder` without `id` uses `WO-<threadRef>`, so one work order per Slack thread.
  Without `steps` it uses the default customer-success list (`src/core/fixtures.ts`);
  lane C's `plan()` output can be passed as `steps` and `constraints`.
- **Approve click = `commit(woId, stepId, actor)`.** `commit` treats an approver's call on a
  `proposed` entry as the approval, so lane B does not need to call `approve` first.
  Non-approver throws `NotAuthorizedError`. Rejected entry throws `NotApprovedError`.
- `commit` can return `{ reused: false, status: "approved" }` when a concurrent click
  already holds the attempt (under 30s). Render as "sending", not as an error.
- `commit` never runs later steps. If a step follows the send, re-trigger `workorder`.

## Decisions that constrain others (for DECISIONS.md)

- **D23 candidate: `node:sqlite`, not `better-sqlite3`** (D22 is taken by OpenRouter). The
  lane A brief says `better-sqlite3`; overridden by the team lead. Built into Node 22+, no
  native build (the wrong-platform `node_modules` already cost time today), no package.json
  change. `better-sqlite3` stays installed but unused. DB: `state/durable.db`. Bundles
  fine under Trigger.dev 4.5.16 (esbuild 0.23.1 keeps `node:sqlite` external). Deploy
  risk: needs Node >= 22.13 in the deploy image; dev is unaffected.
- **Open the database per call, never hold a handle.** `npm run reset` deletes `state/`;
  a long-lived handle in the listener would keep writing to the deleted file.
- **The ledger is the only writer of commits.** `putWorkOrder` ignores `wo.commits`, so no
  caller can set `externalId` (invariant 3). `COMMIT_TOOLS` is enforced again in core on
  create, put, and run, not only in the planner (invariant 2).
- **One proposal per commit step** (`UNIQUE (wo_id, step_id)`). Args are frozen at
  proposal time, so the approver approves exactly what is sent.
- **Reconcile by key in the side effect (D9).** `mail.send` appends one JSON line to
  `state/outbox.jsonl` with `X-Idempotency-Key: <key>` in the body; `commit` searches the
  outbox for that exact string before sending. `npm run reset` and `reset()` both clear it.
- At-least-once, not exactly-once: an attempt older than 30s with no outbox match may be
  resent. Stated plainly per CLAUDE.md honesty rules.

## Contradictions between briefs (resolve at merge)

- The lane A brief orders the committer as "entry not `approved` -> throw
  `NotApprovedError`". The lane B brief calls `commit()` directly on the Approve click,
  never `approve()`. Implemented: an allowlisted actor calling `commit` on a `proposed`
  entry approves it in the same transaction, after the authorization check. All other
  checks keep the brief's order: committed receipt first, then authorization, then
  rejected/failed -> `NotApprovedError`, then reconcile, then the tool, then
  `outcome_unknown` when no id comes back.
- Brief file names are used: `src/tools/outbox.ts`, `src/tools/registry.ts`.

## Not done / for the merge

- `src/trigger/workorder.ts` does not call lane D's `mirror()`: that module is not on
  this branch. At merge, call `mirror(wo)` (not awaited on the commit path) after
  `runReversible` returns, and in the listener after `commit`/`deny`.
- Stub steps pause `STUB_DELAY_MS` (default 1500ms) so a kill lands mid-run on camera.
- `node:sqlite` prints one ExperimentalWarning per process. Harmless.

## Verify

    npm run typecheck
    node --import tsx src/core/kill.test.ts
    node --env-file=.env --import tsx src/cli.ts demo
