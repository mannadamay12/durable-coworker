// Generate an evidence replay using real core operations and only a local stub outbox.
// Kills only the CLI child it creates. Never loads .env or touches existing state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "tsx/esm/api";
import { snapshot } from "./review-snapshot.mjs";

register();
const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "state"), { recursive: true });
const stateDir = mkdtempSync(resolve(root, "state/review-demo-"));
process.env.STATE_DIR = stateDir;
process.env.STUB_DELAY_MS = "300";
const core = await import("../src/core/index.ts");
const { toolCalls, outboxRows } = await import("../src/core/inspect.ts");
const frames = [];
const record = (label, detail) => frames.push({ label, detail, snapshot: snapshot(stateDir) });
const woId = "WO-REVIEW-DEMO";
const actor = "U_REVIEW_APPROVER";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let child;
try {
  core.createWorkOrder({ id: woId, scenario: "customer-success", threadRef: "review-only", approvers: [actor] });
  record("Work order persisted", "Fixture scenario. Planner and external providers are not invoked in this replay.");
  child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--wo", woId], { cwd: root, env: process.env, stdio: "ignore" });
  const exited = once(child, "exit");
  const deadline = Date.now() + 10000;
  // The execution log is written before step completion in a separate transaction.
  // Observe the durable completion checkpoint, not just the tool-call count.
  while (!core.getWorkOrder(woId).steps.slice(0, 2).every(step => step.status === "done")) {
    assert.ok(Date.now() < deadline && child.exitCode === null, "CLI child did not reach checkpoint");
    await sleep(25);
  }
  child.kill("SIGKILL");
  await exited;
  record("Worker killed", "SIGKILL applied only to this review's CLI child. The first two completed steps remain in SQLite.");
  assert.equal(toolCalls(woId).length, 2);
  await core.runReversible(woId);
  record("Resumed; approval required", "Completed work was skipped. The exact proposed recipient and body are in the ledger. Outbox is empty.");
  assert.equal(outboxRows().length, 0);
  for (const step of core.getWorkOrder(woId).steps.filter(s => s.kind === "reversible")) {
    assert.equal(toolCalls(woId).filter(c => c.stepId === step.id).length, 1);
  }
  const pending = core.pendingApproval(core.getWorkOrder(woId));
  assert.ok(pending);
  await assert.rejects(core.commit(woId, pending.step.id, "U_STRANGER"), core.NotAuthorizedError);
  assert.equal(outboxRows().length, 0);
  assert.equal(core.pendingApproval(core.getWorkOrder(woId))?.entry.status, "proposed");
  record("Unauthorized approval refused", "U_STRANGER was rejected by core authorization. No side effect was written.");
  const first = await core.commit(woId, pending.step.id, actor);
  assert.equal(first.status, "committed"); assert.ok(first.externalId); assert.equal(outboxRows().length, 1);
  record("Approved; one receipt", "The allowlisted actor committed the frozen proposal to the local stub outbox.");
  const second = await core.commit(woId, pending.step.id, actor);
  assert.equal(second.reused, true); assert.equal(second.externalId, first.externalId); assert.equal(outboxRows().length, 1);
  record("Retried; same receipt", "The second commit returned the existing external ID. The outbox still contains one artifact.");
  const replay = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: "isolated-core-with-stub-tools", stateDir, frames };
  writeFileSync(resolve(stateDir, "review-replay.json"), JSON.stringify(replay, null, 2) + "\n");
  console.log(`\nReplay captured: ${stateDir}\nnode scripts/review-observe.mjs --state-dir '${stateDir}'`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
