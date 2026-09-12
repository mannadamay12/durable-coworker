# Verification and evidence viewer

Run from `/Users/ad12/Documents/Develop/durable-coworker-review` on branch `codex/demo-architecture-review`. The review scripts create their own state and do not load the main worktree's `.env` unless the explicitly live planner command is selected. `npm ci` was completed in this worktree. Review runtime was Node 25.5.0; also validate the pinned Trigger Node 22 runtime before recording a new build.

## Open the completed experiment

The viewer is running at [http://127.0.0.1:4318](http://127.0.0.1:4318). It displays real stored checkpoint snapshots plus the separate live-model probe records. It cannot approve or send.

To recreate the experiment:

```sh
cd /Users/ad12/Documents/Develop/durable-coworker-review
node scripts/review-demo.mjs
```

This creates a unique directory under this worktree's ignored `state/`, prints it, and prints the exact observer command. The only killed process is the CLI child this script creates. Its six checkpoints are persisted work order, killed worker, resumed proposal, unauthorized refusal, committed receipt, and reused receipt.

For the experiment captured during this review:

```sh
node scripts/review-observe.mjs \
  --state-dir /Users/ad12/Documents/Develop/durable-coworker-review/state/review-demo-ZfjoQU \
  --port 4318
```

The observer binds only `127.0.0.1`, rejects HTTP mutations, opens SQLite read-only, and has no model or provider client. Use another port if an observer is already running. It can inspect any explicit compatible state directory. It polls SQLite and JSONL separately, so concurrent cross-store transitions can appear temporarily inconsistent; this is not an atomic audit stream or a production-scale dashboard.

## Run the local checks

Run each independently; intentional failures should not prevent later checks from running.

```sh
npm run typecheck
npm run test:kill
node --import tsx src/core/kill.test.ts
PLANNER_MODE=stub node src/agent/plan.test.mjs
node --import tsx scripts/review-core.mjs
node scripts/review-planner.mjs --strict
node --import tsx scripts/review-channel.mjs
node scripts/review-mirror.mjs --strict
```

Expected against `c564f70`, with the same core/planner/listener at final reviewed source `54afa04`:

| Command | Expected result |
|---|---|
| Typecheck, kill matcher, original core kill test, stub planner | Exit 0 |
| `review-core.mjs` | Exit 1: 7 pass / 9 failures, with exact evidence; prints isolated JSON report location |
| `review-planner.mjs --strict` | Exit 1: 3 pass / 16 failed desired-behavior checks; overwrites offline evidence JSON under `notes/` |
| `review-channel.mjs` | Exit 0 when eight characterization/protocol probes reproduce expected behavior, including bugs; it is not a clean bill of health |
| `review-mirror.mjs --strict` | Exit 1: 1 pass / 8 failed desired-behavior checks and documented limitations; real provider transport is mocked |

The channel harness compiles the actual listener handler source and injects local stand-ins for runtime boundaries. It proves handler branches and installed SDK behavior, not live managed delivery, Slack rendering, Trigger operation or cross-process connectivity. Its fixture assertions must be revised as the underlying defects are fixed.

The `54afa04` mirror addition is a separate component, currently unwired. Do not assume `MIRROR_MODE=file` makes `src/mirror/mirror.check.ts` offline: its invalid-key test deliberately removes that mode and contacts the provider. Use the review's mocked-fetch mirror probes for isolated verification instead. The lane-D handoff records its own prior live document test; that is separate from this review's no-provider-write policy.

The core harness mutates only its isolated test database and in-process stub tool functions. Slow-provider tests advance the claim timestamp deterministically rather than sleeping for 30 seconds. Seven passing checks and nine failing checks describe the current code, including limits acknowledged by its at-least-once design.

## Optional bounded real model check

The existing report already contains four successful live responses. This command makes at most four HTTP model requests including retries, sends only the public/synthetic fixture prompts, and does not approve a commit:

```sh
node scripts/review-planner.mjs --live \
  --config /Users/ad12/Documents/Develop/durable-coworker/.env
```

Only the OpenRouter key, model and base URL are read from that file; main state is not used. Each request has a 45-second timeout. The report records actual responses versus fixture fallback, usage, generation IDs and content checks. Default report mode exits successfully even when review checks fail; append `--strict` to use those checks as a gate. A funded key plus HTTP 200 is not enough: verify source/recipient/timeline correctness.

Dataset provenance, pinned commit, source SHA-256, license and wrapper distinctions are in [the scenario pack](../scenarios/review/README.md). Six BANKING77 records are retained, not the full corpus. The pack is used by review scripts; it does not silently replace Slack's runtime fixture.

## Live Slack acceptance flow after fixes

Use an explicitly designated demo channel, approvers, isolated state directory, and matching dev environment. The review did not start a second listener on the user's current channel or send messages to other people.

1. Confirm listener and worker read the same absolute state directory. Verify their revision/runtime. Confirm the listener is online, the worker is connected, planner provenance is visible, and adapter mode is declared. Do not copy an absolute main `STATE_DIR` into an isolated setup unintentionally.
2. Send a brief with a unique customer and constraint in the actual provided context. Test a short brief as well. Verify the plan, exact recipient, subject, body and constraint against source; a hidden fixture substitution is a failure.
3. At a persisted reversible checkpoint, use the owning worktree's `npm run kill:dry` to verify the target. Kill only the designated demo worker. Verify listener remains online, completed outputs persist, and resume creates a new attempt for the same work order.
4. Inspect the proposal before approval: no side effect, immutable payload/key, correct allowlist. Try an unauthorized real user; no state change. The current requester-auto-approver policy must be explicit or replaced first.
5. Approve once. Verify the particular tool's receipt and payload. Duplicate/re-deliver the approval and compare key/receipt/artifact count. For a two-commit plan, verify the next card and count each tool separately.
6. Deny a separate work order; it remains blocked on re-mention. Test configured deadline expiry once a deadline mechanism exists; current code has no approval timeout implementation.
7. In a separate controlled run, lose the connection after provider acceptance but before ledger completion. The surface must say unknown until evidence resolves it. A re-mention must not say Finished. A late response must not downgrade a committed receipt.
8. Cause the continuation Trigger call or Slack post to fail after a successful commit. The previous receipt remains visible and the notification must not say “Nothing was sent.” Repeating the old action must advance remaining work without repeating the committed effect.
9. Restart a dedicated test listener after posting an approval; the original button must recover its callback from durable storage. Separately reload the evidence view and ensure no new planner/send executes.
10. Verify a long proposal is fully inspectable before approving. Never hide material terms in a truncated Slack section.

Do not interpret the current `npm run reset` as a universal state reset: it deletes relative `state/`, whereas the runtime may use an absolute `STATE_DIR` elsewhere. Prefer a new explicit directory for each take. Preserve evidence from failed takes.

## Provider adapter acceptance

Read-only Ambiguous discovery has passed and advertised native email idempotency. Before a real-send demo, test with a designated test sender/recipient: same key and payload, same key with different payload (expected conflict), timeout after acceptance, delayed lookup, native key scope/retention, payload size/key-length boundaries, and provider unavailable. No real provider sends were part of this review.

Use exact internal-to-provider mapping (`mail.send` → advertised `send_email`) with local schema/risk validation. Credentials stay in the provider adapter. A missing tool or schema mismatch blocks visibly. Mirror/document failures do not alter ledger truth. External task/document creation requires its own duplication and approval policy even if the result can later be deleted.

## Evidence to retain for a recording

Commit SHA, runtime and adapter mode; source fixture ID/hash; model purposes/IDs/provenance; stable work-order and per-attempt IDs; completed outputs; frozen proposal digest; approval actor/time; receipt and reconciliation outcome; per-tool artifact counts; assertion results. Keep credentials and unrelated customer content out of the evidence bundle.

This branch's viewer received HTTP and browser checks for six checkpoints, live state, a 375px layout and no browser errors. First browser launch failed because the bundled Playwright expected an uninstalled browser revision; rerunning with an existing compatible cached Chromium executable succeeded. No browser package or app dependency was changed.
