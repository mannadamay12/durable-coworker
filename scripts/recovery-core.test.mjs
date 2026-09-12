// Offline receipt regressions. Every provider call is mocked and state is isolated.
// Run: node --import tsx scripts/recovery-core.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "coworker-recovery-core-"));
process.env.STATE_DIR = stateDir;
process.env.STUB_DELAY_MS = "0";

const core = await import("../src/core/index.ts");
const { withDb } = await import("../src/core/db.ts");
const { commitTools } = await import("../src/tools/registry.ts");
const { readOutbox } = await import("../src/tools/outbox.ts");
const actor = "U_RECOVERY_TEST";
const toolName = "mail.send";
const originalTool = commitTools[toolName];
let serial = 0;

async function proposed() {
  const wo = core.createWorkOrder({
    id: `WO-RECEIPT-${++serial}`,
    scenario: "receipt-concurrency-test",
    threadRef: `receipt-test-${serial}`,
    approvers: [actor],
    steps: [{ id: "send", name: "Send", kind: "commit", tool: toolName,
      status: "pending", classifiedBy: "model" }],
  });
  return core.runReversible(wo.id);
}

async function lateAttempt(label, finishFirst) {
  const wo = await proposed();
  const key = wo.commits[0].idempotencyKey;
  const winnerId = `winner-${label}`;
  let calls = 0;
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  commitTools[toolName] = async () => {
    if (++calls === 1) {
      await firstReleased;
      return finishFirst();
    }
    return { id: winnerId };
  };

  const first = core.commit(wo.id, "send", actor);
  try {
    assert.equal(calls, 1, "the first provider attempt must be suspended");
    // Model a slow request outliving the current 30-second retry lease without a sleep.
    // Preventing that overlap is a separate policy change; here both replies must agree.
    withDb((db) => db.prepare("UPDATE ledger SET attempted_at = ? WHERE idempotency_key = ?")
      .run(new Date(Date.now() - 31_000).toISOString(), key));
    const winner = await core.commit(wo.id, "send", actor);
    assert.deepEqual(winner, {
      reused: false, status: "committed", externalId: winnerId, idempotencyKey: key,
    });
    const storedWinner = core.getWorkOrder(wo.id).commits[0];
    releaseFirst();
    const late = await first;
    assert.deepEqual(late, {
      reused: false, status: "committed", externalId: winnerId, idempotencyKey: key,
    }, "a late caller must return the authoritative receipt");
    const after = core.getWorkOrder(wo.id);
    assert.deepEqual(after.commits[0], storedWinner, "terminal receipt and commit time must stay unchanged");
    assert.equal(after.steps[0].status, "committed");
    assert.deepEqual(await core.commit(wo.id, "send", actor), { ...late, reused: true },
      "only the retry that does not invoke a provider can report receipt reuse");
    assert.equal(calls, 2, "receipt reuse must not invoke a third provider call");
    console.log(`PASS ${label}: both replies use ${winnerId}; retry is a read`);
  } finally {
    releaseFirst();
    await first;
    commitTools[toolName] = originalTool;
  }
}

try {
  await lateAttempt("late-throw", () => { throw new Error("mock provider timeout"); });
  await lateAttempt("late-no-id", () => ({}));
  await lateAttempt("late-different-receipt", () => ({ id: "losing-provider-receipt" }));

  const unknown = await proposed();
  commitTools[toolName] = async () => ({});
  const result = await core.commit(unknown.id, "send", actor);
  assert.deepEqual(result, {
    reused: false, status: "outcome_unknown", idempotencyKey: unknown.commits[0].idempotencyKey,
  });
  assert.equal(core.getWorkOrder(unknown.id).commits[0].status, "outcome_unknown");
  console.log("PASS missing receipt without a winning attempt remains outcome_unknown");
  assert.equal(readOutbox().length, 0, "these tests must never call a real or stub provider");
  console.log("4 recovery receipt regressions passed; no external sends");
} finally {
  commitTools[toolName] = originalTool;
  rmSync(stateDir, { recursive: true, force: true });
}
