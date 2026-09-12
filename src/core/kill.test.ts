// The kill test. One assertion script, no framework.
//   node --import tsx src/core/kill.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolated state: must be set before core is imported, STATE_DIR is read at load.
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "coworker-kill-"));
process.env.STUB_DELAY_MS = "300";

const core = await import("./index.js");
const { outboxRows, toolCalls } = await import("./inspect.js");
const { DEFAULT_STEPS } = await import("./fixtures.js");

const pass = (msg: string) => console.log(`pass  ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APPROVER = "U_APPROVER";
const WO = "WO-KILL";
const SEND = "5-send-customer-update";

core.reset();

// Invariant 2: a model that mislabels mail.send as reversible does not get send access.
const mislabeled = DEFAULT_STEPS.map((s) => (s.tool === "mail.send" ? { ...s, kind: "reversible" as const } : s));
const created = core.createWorkOrder({ id: WO, scenario: "customer-success", threadRef: "kill", approvers: [APPROVER], steps: mislabeled });
const send = created.steps.find((s) => s.id === SEND);
assert.equal(send?.kind, "commit");
assert.equal(send?.classifiedBy, "allowlist_override");
pass("mail.send labelled reversible is forced to commit (allowlist_override)");

// Kill a separate process mid-run with SIGKILL.
const root = resolve(import.meta.dirname, "../..");
const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--wo", WO], {
  cwd: root,
  env: process.env,
  stdio: "ignore",
});
const deadline = Date.now() + 30_000;
while (toolCalls(WO).length < 2) {
  assert.ok(Date.now() < deadline, "worker never finished two steps");
  await sleep(25);
}
child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));
const killed = core.getWorkOrder(WO).steps.map((s) => s.status);
assert.deepEqual(killed.slice(0, 2), ["done", "done"]);
assert.notEqual(killed[4], "waiting_human");
pass(`SIGKILL after two steps: [${killed.join(", ")}]`);

// Resume in a new process lifetime: finished steps are not re-executed.
const resumed = await core.runReversible(WO);
const calls = (id: string) => toolCalls(WO).filter((c) => c.stepId === id).length;
assert.equal(calls("1-gather-thread-context"), 1);
assert.equal(calls("2-research-outage"), 1);
assert.equal(resumed.steps.find((s) => s.id === SEND)?.status, "waiting_human");
assert.equal(core.pendingApproval(resumed)?.entry.status, "proposed");
assert.equal(outboxRows().length, 0);
pass("resume skipped steps 1-2, stopped at the send with a proposal, outbox empty");

await core.runReversible(WO);
assert.equal(outboxRows().length, 0);
pass("re-running the job never sends");

// Invariant 5: anyone can click, only an approver moves a step.
await assert.rejects(core.commit(WO, SEND, "U_STRANGER"), core.NotAuthorizedError);
assert.equal(outboxRows().length, 0);
pass("non-approver commit rejected, outbox empty");

const first = await core.commit(WO, SEND, APPROVER);
assert.equal(first.reused, false);
assert.equal(first.status, "committed");
assert.ok(first.externalId);
assert.equal(outboxRows().length, 1);
assert.ok(outboxRows()[0].body.includes(first.idempotencyKey));
pass(`approver commit sent once: ${first.externalId}, key embedded in body`);

// Invariant 4: a retry of a committed key is a read.
const second = await core.commit(WO, SEND, APPROVER);
assert.equal(second.reused, true);
assert.equal(second.externalId, first.externalId);
assert.equal(outboxRows().length, 1);
pass("retry returns the same receipt, outbox still 1");

// Crash window: the send landed, the ledger write did not. Reconcile, do not resend.
const R = "WO-RECON";
core.createWorkOrder({ id: R, scenario: "customer-success", threadRef: "recon", approvers: [APPROVER] });
const waiting = core.pendingApproval(await core.runReversible(R));
assert.ok(waiting);
await core.getTool(waiting.entry.tool)({ ...(waiting.entry.args as object), idempotencyKey: waiting.entry.idempotencyKey });
assert.equal(outboxRows().length, 2);
const recon = await core.commit(R, waiting.step.id, APPROVER);
assert.equal(recon.reused, true);
assert.equal(outboxRows().length, 2);
pass(`landed-but-unrecorded send reconciled by key: ${recon.externalId}, not resent`);

// Deny blocks and stays blocked.
const D = "WO-DENY";
core.createWorkOrder({ id: D, scenario: "customer-success", threadRef: "deny", approvers: [APPROVER] });
await core.runReversible(D);
assert.throws(() => core.deny(D, SEND, "U_STRANGER"), core.NotAuthorizedError);
const denied = core.deny(D, SEND, APPROVER);
assert.equal(denied.steps.find((s) => s.id === SEND)?.status, "rejected");
await assert.rejects(core.commit(D, SEND, APPROVER), core.NotApprovedError);
await core.runReversible(D);
assert.equal(outboxRows().length, 2);
pass("deny by approver blocks the step; commit and re-run cannot send");

console.log("\nall pass");
