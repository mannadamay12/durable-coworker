# Core durability and architecture review

Reviewed core at `35365f7`, then confirmed the same core files at refreshed snapshot `c564f70`, in the isolated `codex/demo-architecture-review` worktree on 2026-09-12. Scope: core, ledger, tool registry, fixtures, CLI and Trigger workorder task. Application source is unchanged. No external tools were called, no processes were killed, and no shared state was read or reset.

The useful product boundary is already present: model output produces a proposal, and a separate, allowlisted actor authorizes a deterministic committer. The remaining risk is distinguishing **a live attempt**, **an unknown outcome**, and **a confirmed receipt**. A fixed retry timer cannot make those states equivalent.

## Verification performed

`npm run typecheck` passes under Node v25.5.0.

Run the focused review harness with:

```sh
node --import tsx scripts/review-core.mjs
```

The harness overrides `STATE_DIR` before importing application modules, creates a fresh OS temporary directory, uses local outbox stubs, and prints the path to `report.json`. It does not load `.env`. A nonzero exit is intentional while a reviewed invariant fails. Fault injection changes registry functions only in the review process, expires timestamps in the temporary database, and writes a torn tail only in the temporary outbox. Child processes finish naturally.

Latest run: **7 checks passed; 9 checks failed**. Evidence was written to `/var/folders/tt/mwf1k94d1450skhpqsbgbkg80000gn/T/coworker-review-core-pHCMKY/report.json`.

Passing checks:

- All four irreversible tools are forced to `commit`; proposing them creates no outbox row.
- A non-approver cannot send.
- Twenty simultaneous calls create one outbox row and reuse the receipt.
- Eight independent processes sharing the same SQLite directory claim one provider action.
- An intact landed-but-unrecorded artifact reconciles without resending.
- Denial prevents a subsequent send.
- Object key order does not change an idempotency hash.

These are bounded local proofs. They do not establish Slack button delivery, provider idempotency, provider search consistency, host loss durability, or deployed workers sharing a database.

## Prioritized findings

### P1 — Invalid model step IDs can claim two actions completed after only one action ran

Locations: `src/core/index.ts:77-79`, `src/core/index.ts:115-124`, `src/core/index.ts:300-303`, `src/agent/plan.ts:41`, `src/core/db.ts:32`.

The model schema accepts unrestricted ID strings. Core accepts duplicate IDs. Every status update updates all matching steps, while the ledger permits only one row per `(wo_id, step_id)`. Two steps with the same ID, one `mail.send` and one `crm.update`, both become `committed` after only the mail proposal is sent. The harness produced `statuses=["committed","committed"]`, `ledgerRows=1`, `toolsActuallyCalled=["mail.send"]`.

A separate alias occurs with distinct IDs `1-action:child` and `1-action`: `entryFor()` uses an idempotency-key prefix, so the second step finds the first step's receipt. That repro also reports both steps committed with one ledger row.

Reject malformed/duplicate IDs at the core boundary; do not rely on the planner prompt. Bind a ledger row using exact stored `wo_id` and `step_id`, not string parsing. Repeat both tests after the fix. A stricter model schema improves output quality but does not replace runtime validation.

### P1 — A late failed attempt can overwrite a confirmed committed ledger status

Location: `src/core/index.ts:371-374`.

The no-receipt path unconditionally writes `status='outcome_unknown'`. An older attempt can still return after a newer attempt has committed. The harness held attempt A, expired its timestamp, let B commit, then released A with no receipt. Result: `ledgerStatus="outcome_unknown"`, `stepStatus="committed"`, and `hasReceipt=true`.

This breaks the separation between progress and evidence: the ledger itself contradicts its receipt. Fence updates with an attempt ID/version and make committed terminal. A stale attempt must not change a newer attempt's state. Verify both late failure and late success, preserving the first authoritative receipt and recording any additional provider receipt as an anomaly.

### P1 before real providers — An expired attempt timestamp does not prove the first send stopped

Locations: `src/core/index.ts:15-16`, `src/core/index.ts:328-339`, `src/core/index.ts:344-367`.

After 30 seconds another caller may claim an attempt while the first provider request is still running. If the first request has not yet produced a searchable artifact, both callers send. The deterministic slow-provider test produced two provider calls and two outbox rows for one key. The existing documentation acknowledges stale retry risk; the test demonstrates that it also applies to a healthy but slow provider, without any crash.

Use provider-native idempotency where available. Otherwise, remain `outcome_unknown` until positive reconciliation or an explicit operator decision. A longer timeout alone does not close the race. A renewable lease plus fencing prevents stale ledger writes, but cannot retract an already accepted external request; do not represent that as exactly-once delivery.

### P1 before untrusted real artifacts — Reconciliation accepts quoted body text from the wrong tool

Location: `src/tools/outbox.ts:35-38`; consumption at `src/core/index.ts:344-350`.

Reconciliation searches `row.body.includes(marker)` across every outbox tool. The harness wrote a CRM artifact whose detail quoted the pending mail's marker, with its own unrelated idempotency marker. The mail commit returned the CRM receipt with `reused=true`; no mail was written.

This is a local boundary test, not a demonstrated Slack exploit in the current hardcoded draft. It shows why arbitrary artifact body text is insufficient evidence when real untrusted content is introduced. Store a structured, exact idempotency key and tool/provider namespace on the receipt. Reconcile against trusted provider metadata when available, including the intended operation and payload digest. Reject markers embedded in quoted text or identifiers that merely share a prefix.

### P2 — A torn outbox tail causes the next complete artifact to become invisible

Locations: `src/tools/outbox.ts:24-30`, `src/tools/outbox.ts:60`.

Ignoring a partial last line does not repair it. The next JSON object is appended directly to that partial line, making the whole combined line invalid. The harness injected an incomplete final object, appended a completed send, and modeled the missing ledger write. `readOutbox()` returned zero rows even though the receipt was present in the raw file; recovery sent a second artifact.

Use a transactional local outbox for the stub, or atomically repair/truncate an invalid trailing fragment before appending under a lock. Add payload/schema validation when reading receipts. This artifact is a stub of a provider, so its durability should be stated separately from SQLite durability.

### P1 — An unknown outcome disappears from approval discovery and can display as Finished

Locations: `src/core/index.ts:236-242`, `src/core/index.ts:371-376`, `src/cli.ts:53-55`, `src/channel/listener.tsx:171-181` at refreshed snapshot `c564f70`.

A missing provider receipt leaves the step `waiting_human`, the ledger `outcome_unknown`, and `pendingApproval()` undefined. Consumers rendering actions from that function lose the unresolved step. The CLI's fallback to the first commit step happens to rescue the one-commit fixture; it is not a reliable recovery path for later commit steps.

The merged listener makes this a concrete UI correctness issue: mention again after the unknown outcome, and `runReversible()` returns the unresolved workorder. The worker completes; `runJob()` sees no pending approval and checks only rejected/blocked/failed before rendering **Finished**. In addition, `onApprove()` says “It will not be retried blindly” (`src/channel/listener.tsx:201-210`), while the old Approve button can invoke the 30-second stale retry path described above. Core state was reproduced in the harness; this rendering consequence is traced statically through the refreshed listener, without a live Slack interaction.

Expose unresolved outcomes separately from approvals. The UI should say “Outcome unknown; checking provider” and offer reconciliation plus a clearly explained operator escalation. Repeating “Approve” must not suggest that a new authorization proves the first side effect failed. Verify a workflow with two commit steps where the second returns no receipt.

### P2 — Two active runners duplicate reversible work

Locations: `src/core/index.ts:201-226`; `src/trigger/workorder.ts:18-24`.

Every runner treats `status='running'` as interrupted. Two concurrent calls each executed the same research step; the tool call table recorded two executions. The lane handoff warns callers not to overlap runs, but core has no ownership check. Current stubs are safe to repeat. A future `tasks.create` adapter, presently called reversible, would need an explicit idempotency contract or could create duplicate tasks.

Allow one live workorder runner through queue concurrency or a durable run lease. Resume only after the previous run is confirmed terminal or its ownership is fenced. Keep retries of genuinely reversible reads permissible, but report replay honestly in the verification UI.

### P2 — Unsupported tools are counted as successfully completed work

Locations: `src/tools/registry.ts:57-62`, `src/core/index.ts:224-227`.

An unknown tool returns “No stub for tool ...; step recorded,” after which core marks the step `done`. The model also has an allowed `null` tool path, so missing execution semantics need a deliberate interpretation. This is safe from sending but misleading during a general-purpose demo.

Separate explicit internal notes from executable tools. Unsupported execution should fail or block with a visible reason. Surface `executionMode: stub` beside all stub receipts. Do not describe the hardcoded `search`, `draft`, or `tasks.create` output as a completed real integration.

## Additional architecture and demo risks from inspection

- **Reset ignores the configured state directory.** `package.json:13` deletes relative `state/`; `src/core/state.ts:16` may point elsewhere. A reset in a worktree can appear successful while the listener retains prior receipts in an absolute directory. Route reset through one explicit state target and display it. Do not test resets against live demo state. `core.reset()` also issues separate deletes (`src/core/index.ts:391-395`) and should run only with work quiesced.
- **State has one-host semantics.** SQLite and JSONL are paths on a filesystem (`src/core/db.ts:8`, `src/tools/outbox.ts:9`). Independent deployed listener/worker hosts do not share state simply because `STATE_DIR` strings match. Keep the demo on one host or move the source of truth to a shared transactional store before distributed deployment.
- **Every status read opens a database and runs schema/PRAGMA operations.** `src/core/db.ts:48-56` blocks the Node event loop; its busy timeout may block for five seconds. Each reversible step has multiple opens and full workorder JSON rewrites. This is acceptable for the small fixture but creates an avoidable bottleneck as polling and concurrent workflows grow.
- **Reconciliation is a global linear scan.** `src/tools/outbox.ts:21-38` rereads/parses the whole file for each attempt, so accumulated send history increases latency and total work grows quadratically across a long sequence of appends. Index structured receipts by `(provider, idempotency_key)`.
- **Inspection scales with global history.** `tool_calls` has no index on `wo_id` (`src/core/db.ts:34-40`; `src/core/inspect.ts:11`). Add the index when history becomes nontrivial; avoid using polling of a full snapshot as the only live verification mechanism.
- **Whole-object writes are an unsafe public mutation surface.** `putWorkOrder()` is documented last-write-wins (`src/core/index.ts:143-145`). It can regress progress or change approvers after a proposal. There are no current app callers outside core tests, so this is a future integration risk, not a demonstrated external authorization bypass. Replace it with versioned, narrow state transitions as integrations are added.
- **Constraint extraction is advisory.** Constraints are stored and shown, while `commitArgs()` hardcodes the customer and draft behavior (`src/core/fixtures.ts:26-36`). A real dataset demo needs structured recipient and payload grounding plus deterministic checks for enforceable constraints. An approval should be bound to the exact payload digest shown on the card.

## Verification flow that makes the product visible

Use a single workorder correlation ID throughout Slack, model requests, worker runs, ledger events and provider receipts. Distinguish “model call completed” from “business action confirmed.” Route events from committed state transitions rather than reconstructing truth from log strings.

For each workorder, expose three adjacent views:

1. **Intent:** source record/thread, extracted constraints, planned steps, executable tool registry and whether each adapter is simulated.
2. **Authority:** frozen proposal payload, payload digest, authorized approvers, approval actor/time, denial, current attempt owner and age.
3. **Evidence:** irreversible tool call count, ledger key/status, provider receipt, reconciliation result and all retry decisions.

A useful staged demo is: create proposal → unauthorized click rejected → authorized click → duplicate click returns same receipt → hold a provider response → show explicit uncertainty → reconcile the persisted receipt. Keep reversible replay counts visible when restarting a worker. The slow-provider case is a powerful diagnostic demonstration once the policy is fixed; today it is a reproducible failure, not a passed guarantee.

For scale, preserve the current structural separation while adding a shared transactional store, append-only domain events written in the same transaction as state transitions, a queue with workorder ownership, and tool adapters with explicit idempotency/reconciliation capabilities. A UI protocol can stream these events; it does not replace the ledger or establish provider safety.

## Suggested patch order

1. Validate unique step IDs and use exact ledger identity; preserve terminal committed state with attempt fencing.
2. Make reconciliation evidence structured and tool-specific; define safe unknown-outcome policy before real providers.
3. Add a recovery surface and an active-run ownership rule; distinguish simulated or unsupported operations.
4. Unify reset targeting and preflight checks; prove the final demo on the actual listener/worker deployment topology.
5. Add shared storage and event projections only when moving beyond the single-host demo; rerun the isolated harness after each change.

The script is one bounded assertion harness rather than a general test framework. Nine failures remain deliberately visible for review. The parent review owns `DECISIONS.md` and `CHANGELOG.md` updates to avoid parallel document edits.
