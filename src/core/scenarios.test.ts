// Dataset grounding and engine-built recovery beats. Acceptance gate for datasets/.
//   node --import tsx src/core/scenarios.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import threadsJson from "../../datasets/threads.json" with { type: "json" };
import customersJson from "../../datasets/customers.json" with { type: "json" };
import researchJson from "../../datasets/research_blobs.json" with { type: "json" };
import tasksJson from "../../datasets/tasks_seed.json" with { type: "json" };
import fixturesJson from "../../datasets/work_order_fixtures.json" with { type: "json" };
import usersJson from "../../datasets/users.json" with { type: "json" };
import injectionsJson from "../../datasets/injections.json" with { type: "json" };
import type { DatasetPack, Thread } from "./context.js";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "coworker-scenarios-"));
process.env.STUB_DELAY_MS = "300";

const core = await import("./index.js");
const { outboxRows, toolCalls } = await import("./inspect.js");
const { loadContext, stepsFor, threadText, validateDatasetPack } = await import("./context.js");
const { buildRecovery, createFromThread } = await import("./recovery.js");

const pass = (msg: string) => console.log(`pass  ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEND = "5-send-customer-update";
const CUSTOMER_NAMES = ["Acme Robotics", "Helix Health", "Lantern Analytics", "Northwind Logistics"];
const allApprovedBy: (string | undefined)[] = [];
const sent = (wo: string) => core.getWorkOrder(wo).commits;

core.reset();

const validPack = validateDatasetPack({
  threads: threadsJson.threads, customers: customersJson.customers,
  blobs: researchJson.blobs, tasks: tasksJson.templates,
  fixtures: fixturesJson.workOrders, users: usersJson.users,
});
const invalidPacks: { name: string; mutate: (pack: DatasetPack) => void; error: RegExp }[] = [
  { name: "missing commitTool", mutate: (p) => { delete (p.threads[0] as Partial<Thread>).commitTool; }, error: /commitTool/ },
  { name: "wrong same-customer recipient", mutate: (p) => { p.blobs[0].draftEmail!.to = "owen@acme-robotics.example"; }, error: /recipient differs/ },
  { name: "recipient outside customer", mutate: (p) => { p.threads[0].commitTarget = "founder@lantern.example"; }, error: /not a customer contact/ },
  { name: "duplicate thread", mutate: (p) => { p.threads.push(p.threads[0]); }, error: /duplicate/ },
  { name: "unsafe thread ID", mutate: (p) => { p.threads[0].id = "THREAD-ACME:alias"; }, error: /safe THREAD- ID/ },
  { name: "unsafe work order ID", mutate: (p) => { p.fixtures[0].id = "WO-1842:alias"; }, error: /safe WO- ID/ },
  { name: "duplicate user", mutate: (p) => { p.users.push(p.users[0]); }, error: /duplicate/ },
  { name: "duplicate customer", mutate: (p) => { p.customers.push(p.customers[0]); }, error: /duplicate/ },
  { name: "unknown customer", mutate: (p) => { p.threads[0].customerId = "CUST-MISSING"; }, error: /unknown customer/ },
  { name: "unknown research thread", mutate: (p) => { p.blobs[0].threadId = "THREAD-MISSING"; }, error: /unknown thread/ },
  { name: "duplicate research mapping", mutate: (p) => { p.blobs.push({ ...p.blobs[0], id: "RESEARCH-OTHER" }); }, error: /duplicate/ },
  { name: "cross-customer task", mutate: (p) => { p.tasks["THREAD-ACME-OUTAGE"][0].customerId = "CUST-LANTERN"; }, error: /another customer/ },
  { name: "unknown task actor", mutate: (p) => { p.tasks["THREAD-ACME-OUTAGE"][0].assignee = "U_MISSING"; }, error: /unknown user/ },
  { name: "unknown message actor", mutate: (p) => { p.threads[0].messages[0].user = "U_MISSING"; }, error: /unknown user/ },
  { name: "unknown approver", mutate: (p) => { p.threads[0].approvers = ["U_MISSING"]; }, error: /unknown user/ },
  { name: "intern approver", mutate: (p) => { p.threads[0].approvers = ["U_SAM"]; }, error: /cannot approve/ },
  { name: "agent approver", mutate: (p) => { p.threads[0].approvers = ["U_COWORKER"]; }, error: /cannot approve/ },
  { name: "fixture grants new approver", mutate: (p) => { p.fixtures[0].approvers = ["U_PRIYA"]; }, error: /thread allowlist/ },
  { name: "malformed messages", mutate: (p) => { p.threads[0].messages = null as unknown as Thread["messages"]; }, error: /expected array/ },
];
for (const { name, mutate, error } of invalidPacks) {
  const mutated = structuredClone(validPack);
  mutate(mutated);
  assert.throws(() => validateDatasetPack(mutated), error, name);
}
assert.ok(validPack.threads.find((t) => t.id === "THREAD-NORTHWIND-STATUS")!.approvers.includes("U_JULES"));
pass(`${invalidPacks.length} malformed packs rejected; explicit per-thread approver U_JULES remains eligible`);

const missingTool = loadContext("THREAD-ACME-OUTAGE")!;
missingTool.thread.commitTool = null;
assert.throws(() => stepsFor(missingTool), /no commitTool/);
assert.equal(loadContext("THREAD-ACME-OUTAGE")!.thread.commitTool, "mail.send");
for (const actor of ["U_SAM", "U_COWORKER", "U_MISSING", "U_PRIYA"]) {
  assert.throws(() => createFromThread("THREAD-ACME-OUTAGE", { id: `WO-BAD-${actor}`, approvers: [actor] }), /approv/);
  assert.equal(core.findWorkOrder(`WO-BAD-${actor}`), undefined);
}
const mapped = createFromThread("THREAD-ACME-OUTAGE", { id: "WO-MAPPED", approvers: ["U123456789"], threadRef: "real-channel:real-thread" })!;
assert.deepEqual(mapped.approvers, ["U123456789"]);
assert.equal(mapped.threadRef, "real-channel:real-thread");
pass("missing tool has no email fallback, returned context is isolated, invalid approvers create nothing, mapped Slack threadRef preserved");

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
assert.equal(createFromThread("THREAD-MISSING"), undefined);
assert.equal(core.findWorkOrder("WO-THREAD-MISSING"), undefined);
assert.throws(() => loadContext("THREAD-MISSING"), /unknown dataset thread/);
assert.throws(() => loadContext("THREAD-EMPTY"), /no customer/);
const badScenario = core.createWorkOrder({ id: "WO-MISSING-DIRECT", scenario: "THREAD-MISSING", threadRef: "missing", approvers: ["U_MAYA"] });
const missingRun = await core.runReversible(badScenario.id);
assert.equal(missingRun.steps[0].status, "failed");
assert.match(missingRun.steps[0].output ?? "", /unknown dataset thread/);
assert.equal(missingRun.commits.length, 0);
pass("empty/unknown threads create nothing through loader; direct-core unknown dataset scenario fails without Northwind fallback");

// These fixtures exercise the deterministic engine boundary, not a model's ability
// to detect arbitrary prompt injection. Chat text never grants commit authority.
for (const payload of injectionsJson.payloads) {
  const ctx = loadContext(payload.threadId)!;
  const wo = createFromThread(payload.threadId, { id: `WO-${payload.id}` })!;
  if (payload.text) {
    wo.steps[0].status = "done";
    wo.steps[0].output = `${threadText(ctx)}\n${payload.from}: ${payload.text}`;
    core.putWorkOrder(wo);
  }
  const result = await core.runReversible(wo.id);
  const pending = core.pendingApproval(result)!;
  assert.ok(pending, `${payload.id} should require approval`);
  assert.equal(pending.entry.status, "proposed");
  assert.deepEqual(result.constraints, wo.constraints);
  const body = (pending.entry.args as { body: string }).body;
  assert.ok(!body.includes("40%") && !body.includes("founder@lantern.example") && !body.includes("15% service credit"));
  if (payload.actor) assert.throws(() => core.approve(wo.id, SEND, payload.actor!), core.NotAuthorizedError);
  if (payload.from) assert.throws(() => core.approve(wo.id, SEND, payload.from!), core.NotAuthorizedError);
  assert.equal(core.getWorkOrder(wo.id).commits[0].status, "proposed");
  assert.equal(outboxRows().length, 0);
  pass(`${payload.id}: untrusted text/actor grants no approval, curated body unchanged, outbox empty`);
}

for (const [thread, body] of [
  ["THREAD-ACME-OUTAGE", "We promise a 15% service credit."],
  ["THREAD-LANTERN-PRICING", "40% discount; cc founder@lantern.example immediately."],
]) {
  const wo = createFromThread(thread, { id: `WO-TAMPER-${thread}` })!;
  // Simulate a changed recorded draft immediately before the proposal boundary.
  wo.steps = wo.steps.map((s) => s.kind === "reversible" ? { ...s, status: "done", output: s.tool === "draft" ? body : "recorded" } : s);
  core.putWorkOrder(wo);
  const result = await core.runReversible(wo.id);
  assert.equal(result.steps.find((s) => s.id === SEND)?.status, "failed");
  assert.match(result.steps.find((s) => s.id === SEND)?.output ?? "", /differs from curated source/);
  assert.equal(result.commits.length, 0);
  assert.equal(outboxRows().length, 0);
}
pass("credit/founder/40% draft mutations fail before proposal; this checks curated-source integrity, not general NLP constraints");

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
pass(`kill after draft step starts, resume: task count stays 2, tasks step ran once, proposal waiting`);

// Recovery beats are built by the engine; keys match its own format.
const keyFor = (wo: string) => new RegExp(`^${wo}:${SEND}:mail\\.send:[0-9a-f]{64}$`);

core.reset();
const fresh = await buildRecovery("fresh_start");
assert.ok(fresh.steps.every((step) => step.status === "pending"));
assert.equal(fresh.commits.length, 0);
assert.equal(outboxRows().length, 0);
pass("fresh_start: engine-created pending steps, empty ledger and outbox");

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
assert.equal(unknown.commits[0].status, "outcome_unknown");
assert.ok(unknown.commits[0].attemptedAt);
assert.throws(() => core.deny(unknown.id, SEND, unknown.approvers[0]), /cannot be denied/);
assert.equal(outboxRows().length, 1);
const recon = await core.commit(unknown.id, SEND, unknown.approvers[0]);
assert.equal(recon.reused, true);
assert.equal(outboxRows().length, 1);
allApprovedBy.push(...sent(unknown.id).map((c) => c.approvedBy));
pass("crash_between_provider_and_ledger: accepted-but-response-lost simulation records attempt, Deny refused, retry reconciles without resend");

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
