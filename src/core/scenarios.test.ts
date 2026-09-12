// Dataset grounding and engine-built recovery beats. Acceptance gate for datasets/.
//   node --import tsx src/core/scenarios.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "coworker-scenarios-"));
process.env.STUB_DELAY_MS = "300";

const core = await import("./index.js");
const { outboxRows, toolCalls } = await import("./inspect.js");
const { loadContext } = await import("./context.js");
const { buildRecovery, createFromThread } = await import("./recovery.js");

const pass = (msg: string) => console.log(`pass  ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEND = "5-send-customer-update";
const CUSTOMER_NAMES = ["Acme Robotics", "Helix Health", "Lantern Analytics", "Northwind Logistics"];
const allApprovedBy: (string | undefined)[] = [];
const sent = (wo: string) => core.getWorkOrder(wo).commits;

core.reset();

// Each customer thread grounds its own proposal: recipient, facts, constraints.
const grounded: { thread: string; fact: string; constraint: string }[] = [
  { thread: "THREAD-ACME-OUTAGE", fact: "eu-west-1", constraint: "do not share RCA before legal review" },
  { thread: "THREAD-HELIX-SECURITY", fact: "PHI", constraint: "do not use personal email" },
  { thread: "THREAD-LANTERN-PRICING", fact: "20% off list", constraint: "do not cc the founder" },
  { thread: "THREAD-ACME-REFUND", fact: "service credit", constraint: "do not confirm Owen as the commercial contact" },
];
for (const { thread, fact, constraint } of grounded) {
  const ctx = loadContext(thread)!;
  const wo = createFromThread(thread)!;
  const pending = core.pendingApproval(await core.runReversible(wo.id));
  assert.ok(pending, `${thread} reached no proposal`);
  const args = pending.entry.args as { to: string; body: string };
  assert.equal(args.to, ctx.thread.commitTarget);
  assert.ok(args.to.endsWith(`@${ctx.customer.domain}`));
  assert.ok(args.body.includes(fact), `${thread} body lacks "${fact}"`);
  for (const other of CUSTOMER_NAMES.filter((n) => n !== ctx.customer.name)) assert.ok(!args.body.includes(other));
  assert.ok(wo.constraints.includes(constraint), `${thread} constraints lack "${constraint}"`);
  for (const d of ctx.customer.doNot) assert.ok(wo.constraints.includes(`do not ${d}`));
  pass(`${thread}: proposal to ${args.to}, grounded body, ${wo.constraints.length} constraints`);
}

// No fallback to another customer when the commit tool has no adapter.
const northwind = createFromThread("THREAD-NORTHWIND-STATUS")!;
const nw = await core.runReversible(northwind.id);
assert.equal(nw.steps.find((s) => s.id === "3-draft")?.status, "done");
assert.ok(!nw.steps.find((s) => s.id === "3-draft")?.output?.includes("Northwind"));
assert.equal(nw.steps.find((s) => s.id === SEND)?.status, "failed");
assert.match(nw.steps.find((s) => s.id === SEND)?.output ?? "", /status\.publish has no registered commit tool/);
assert.equal(nw.commits.length, 0);
pass("THREAD-NORTHWIND-STATUS: public draft omits the customer; status.publish fails before proposal, no ledger row");

assert.equal(createFromThread("THREAD-EMPTY"), undefined);
assert.equal(core.findWorkOrder("WO-THREAD-EMPTY"), undefined);
pass("THREAD-EMPTY creates zero work orders");

// Kill mid-run on a dataset thread: tasks are not duplicated on resume.
const KILL = "WO-ACME-KILL";
createFromThread("THREAD-ACME-OUTAGE", { id: KILL });
const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--wo", KILL], {
  cwd: resolve(import.meta.dirname, "../.."),
  env: process.env,
  stdio: "ignore",
});
const deadline = Date.now() + 30_000;
while (toolCalls(KILL).length < 3) {
  assert.ok(Date.now() < deadline, "worker never finished three steps");
  await sleep(25);
}
child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));
const resumed = await core.runReversible(KILL);
await core.runReversible(KILL);
const taskStep = resumed.steps.find((s) => s.id === "4-create-tasks")!;
assert.equal(toolCalls(KILL).filter((c) => c.stepId === "4-create-tasks").length, 1);
assert.equal(taskStep.output?.split("\n").length, 2);
assert.equal(core.pendingApproval(resumed)?.entry.status, "proposed");
pass(`kill after 3 steps, resume: task count stays 2, tasks step ran once, proposal waiting`);

// Recovery beats are built by the engine; keys match its own format.
const keyFor = (wo: string) => new RegExp(`^${wo}:${SEND}:mail\\.send:[0-9a-f]{64}$`);

core.reset();
const killed = await buildRecovery("kill_before_approval");
assert.equal(killed.steps.find((s) => s.id === SEND)?.status, "waiting_human");
assert.match(killed.commits[0].idempotencyKey, keyFor(killed.id));
assert.equal((await core.runReversible(killed.id)).commits.length, 1);
assert.equal(outboxRows().length, 0);
pass(`kill_before_approval: ${killed.id} proposed with an engine key, re-run adds nothing`);

core.reset();
const sentWo = await buildRecovery("retry_send_already_committed");
assert.equal(outboxRows().length, 1);
const retry = await core.commit(sentWo.id, SEND, sentWo.approvers[0]);
assert.equal(retry.reused, true);
assert.equal(outboxRows().length, 1);
allApprovedBy.push(...sent(sentWo.id).map((c) => c.approvedBy));
pass("retry_send_already_committed: retry reused, outbox length 1");

core.reset();
const unknown = await buildRecovery("crash_between_provider_and_ledger");
assert.equal(unknown.commits[0].status, "approved");
assert.equal(outboxRows().length, 1);
const recon = await core.commit(unknown.id, SEND, unknown.approvers[0]);
assert.equal(recon.reused, true);
assert.equal(outboxRows().length, 1);
allApprovedBy.push(...sent(unknown.id).map((c) => c.approvedBy));
pass("crash_between_provider_and_ledger: reconciled from the outbox, not resent");

core.reset();
const injected = await buildRecovery("injection_still_proposed");
assert.equal(injected.commits[0].status, "proposed");
assert.ok(!(injected.commits[0].args as { body: string }).body.includes("40%"));
await assert.rejects(core.commit(injected.id, SEND, "U_SAM"), core.NotAuthorizedError);
assert.equal(sent(injected.id)[0].status, "proposed");
assert.equal(outboxRows().length, 0);
allApprovedBy.push(...sent(injected.id).map((c) => c.approvedBy));
pass("injection_still_proposed: U_SAM approve and commit rejected, ledger stays proposed");

core.reset();
const denied = await buildRecovery("deny_path");
assert.equal(denied.steps.find((s) => s.id === SEND)?.status, "rejected");
await assert.rejects(core.commit(denied.id, SEND, denied.approvers[0]), core.NotApprovedError);
assert.equal(outboxRows().length, 0);
pass("deny_path: rejected, commit refused, outbox empty");

assert.ok(!allApprovedBy.includes("U_SAM"));
pass("U_SAM never in approvedBy");

console.log("\nall pass");
