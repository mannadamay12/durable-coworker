// Isolated, offline verification of durability invariants and known failure modes.
// Run: node --import tsx scripts/review-core.mjs
// Exit 1 means a safety/correctness invariant failed; output includes repro evidence.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "coworker-review-core-"));
process.env.STUB_DELAY_MS = "0";

const core = await import("../src/core/index.ts");
const inspect = await import("../src/core/inspect.ts");
const outbox = await import("../src/tools/outbox.ts");
const registry = await import("../src/tools/registry.ts");
const { withDb } = await import("../src/core/db.ts");
const actor = "U_REVIEW_APPROVER";
const execFileAsync = promisify(execFile);
const rows = [];
const coreLog = console.log;
let serial = 0;
let details = {};

const step = (id, tool = "mail.send", kind = "commit") => ({
  id, name: id, tool, kind, status: "pending", classifiedBy: "model",
});
const create = (steps = [step("1-send")]) => core.createWorkOrder({
  id: `WO-REVIEW-${++serial}`, scenario: "review-fixture", threadRef: `review-${serial}`,
  approvers: [actor], steps,
});
async function proposed(steps) {
  const wo = create(steps);
  return core.runReversible(wo.id);
}
async function check(name, fn) {
  details = {};
  outbox.clearOutbox();
  const started = performance.now();
  console.log = () => {};
  try {
    await fn();
    rows.push({ name, status: "PASS", details, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    rows.push({ name, status: "FAIL", details, error: String(error.message), durationMs: Math.round(performance.now() - started) });
  } finally {
    console.log = coreLog;
  }
  const result = rows.at(-1);
  coreLog(`${result.status} ${name} ${JSON.stringify(result.details)}`);
}

await check("irreversible tool classifications are overridden before execution", async () => {
  for (const tool of core.COMMIT_TOOLS) {
    const wo = await proposed([step("1-action", tool, "reversible")]);
    assert.equal(wo.steps[0].kind, "commit");
    assert.equal(wo.steps[0].classifiedBy, "allowlist_override");
    assert.equal(wo.commits[0].status, "proposed");
  }
  assert.equal(outbox.readOutbox().length, 0);
  details = { toolsChecked: core.COMMIT_TOOLS.size, sends: 0 };
});

await check("unauthorized approval cannot send", async () => {
  const wo = await proposed();
  await assert.rejects(core.commit(wo.id, "1-send", "U_STRANGER"), core.NotAuthorizedError);
  assert.equal(outbox.readOutbox().length, 0);
  details = { sends: 0, status: core.getWorkOrder(wo.id).commits[0].status };
});

await check("twenty simultaneous clicks send once and repeat returns receipt", async () => {
  const wo = await proposed();
  const results = await Promise.all(Array.from({ length: 20 }, () => core.commit(wo.id, "1-send", actor)));
  const repeated = await core.commit(wo.id, "1-send", actor);
  assert.equal(outbox.readOutbox().length, 1);
  assert.equal(new Set(results.map((r) => r.externalId)).size, 1);
  assert.equal(repeated.reused, true);
  details = { clicks: results.length, sends: 1, repeatedReceiptReused: true };
});

await check("eight separate processes claim one provider action", async () => {
  const wo = await proposed();
  const code = `
    const core = await import('./src/core/index.ts');
    const registry = await import('./src/tools/registry.ts');
    const original = registry.commitTools['mail.send'];
    registry.commitTools['mail.send'] = async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return original(args);
    };
    await core.commit(process.env.REVIEW_WO, '1-send', process.env.REVIEW_ACTOR);
  `;
  await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", code], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, REVIEW_WO: wo.id, REVIEW_ACTOR: actor },
    })));
  details = { processes: 8, sends: outbox.readOutbox().length,
    ledgerStatus: core.getWorkOrder(wo.id).commits[0].status };
  assert.equal(outbox.readOutbox().length, 1);
  assert.equal(core.getWorkOrder(wo.id).commits[0].status, "committed");
});

await check("landed but unrecorded artifact reconciles without another send", async () => {
  const wo = await proposed();
  const entry = wo.commits[0];
  const sent = await core.getTool(entry.tool)({ ...entry.args, idempotencyKey: entry.idempotencyKey });
  const result = await core.commit(wo.id, "1-send", actor);
  assert.equal(result.reused, true);
  assert.equal(result.externalId, sent.id);
  assert.equal(outbox.readOutbox().length, 1);
  details = { reconciled: true, sends: 1 };
});

await check("denial blocks a proposed side effect", async () => {
  const wo = await proposed();
  core.deny(wo.id, "1-send", actor);
  await assert.rejects(core.commit(wo.id, "1-send", actor), core.NotApprovedError);
  await core.runReversible(wo.id);
  assert.equal(outbox.readOutbox().length, 0);
  assert.equal(core.getWorkOrder(wo.id).steps[0].status, "rejected");
  details = { sends: 0, rejected: true };
});

await check("canonical args preserve idempotency hash", async () => {
  assert.equal(core.idempotencyKey("wo", "step", "mail.send", { b: 2, a: 1 }),
    core.idempotencyKey("wo", "step", "mail.send", { a: 1, b: 2 }));
  details = { canonical: true };
});

await check("an active provider request must not be duplicated after lease expiry", async () => {
  const wo = await proposed();
  const original = registry.commitTools["mail.send"];
  let releaseFirst;
  let calls = 0;
  registry.commitTools["mail.send"] = async (args) => {
    calls++;
    if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return original(args);
  };
  try {
    const first = core.commit(wo.id, "1-send", actor);
    // Deterministically model a provider request still running after 31 seconds.
    withDb((db) => db.prepare("UPDATE ledger SET attempted_at = ? WHERE wo_id = ?")
      .run(new Date(Date.now() - 31_000).toISOString(), wo.id));
    await core.commit(wo.id, "1-send", actor);
    releaseFirst();
    await first;
    details = { providerCalls: calls, outboxRows: outbox.readOutbox().length };
    assert.equal(calls, 1, "a live request was sent again after only its timestamp expired");
  } finally {
    releaseFirst?.();
    registry.commitTools["mail.send"] = original;
  }
});

await check("a late failure must not demote a committed ledger entry", async () => {
  const wo = await proposed();
  const original = registry.commitTools["mail.send"];
  let releaseFirst;
  let calls = 0;
  registry.commitTools["mail.send"] = async (args) => {
    if (++calls === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
      return {}; // first provider attempt timed out without a receipt
    }
    return original(args);
  };
  try {
    const first = core.commit(wo.id, "1-send", actor);
    withDb((db) => db.prepare("UPDATE ledger SET attempted_at = ? WHERE wo_id = ?")
      .run(new Date(Date.now() - 31_000).toISOString(), wo.id));
    await core.commit(wo.id, "1-send", actor);
    releaseFirst();
    await first;
    const after = core.getWorkOrder(wo.id);
    details = { ledgerStatus: after.commits[0].status, stepStatus: after.steps[0].status,
      hasReceipt: Boolean(after.commits[0].externalId) };
    assert.equal(after.commits[0].status, "committed", "late failure overwrote committed status");
  } finally {
    releaseFirst?.();
    registry.commitTools["mail.send"] = original;
  }
});

await check("duplicate model step ids must not silently skip a second action", async () => {
  let wo;
  try {
    wo = await proposed([step("1-action", "mail.send"), step("1-action", "crm.update")]);
  } catch {
    details = { rejectedInvalidPlan: true };
    return;
  }
  await core.commit(wo.id, "1-action", actor);
  const after = await core.runReversible(wo.id);
  details = { statuses: after.steps.map((s) => s.status), ledgerRows: after.commits.length,
    toolsActuallyCalled: outbox.readOutbox().map((r) => r.tool) };
  assert.equal(after.commits.length, 2, "two actions report committed with only one ledger row");
});

await check("step ids containing separators must bind to their own ledger row", async () => {
  let wo;
  try {
    wo = await proposed([step("1-action:child"), step("1-action", "crm.update")]);
  } catch {
    details = { rejectedInvalidPlan: true };
    return;
  }
  await core.commit(wo.id, "1-action:child", actor);
  const after = await core.runReversible(wo.id);
  details = { statuses: after.steps.map((s) => s.status), ledgerRows: after.commits.length,
    toolsActuallyCalled: outbox.readOutbox().map((r) => r.tool) };
  assert.notEqual(after.steps[1].status, "committed", "prefix lookup reused another step's receipt");
});

await check("a quoted marker in a different action must not count as a receipt", async () => {
  const wo = await proposed();
  const entry = wo.commits[0];
  await core.getTool("crm.update")({
    detail: `The user quoted X-Idempotency-Key: ${entry.idempotencyKey}`,
    idempotencyKey: "unrelated-crm-action",
  });
  const result = await core.commit(wo.id, "1-send", actor);
  details = { reused: result.reused, receipt: result.externalId,
    toolsActuallyCalled: outbox.readOutbox().map((r) => r.tool) };
  assert.equal(result.reused, false, "quoted body text falsely reconciled an unrelated CRM receipt");
});

await check("a torn JSONL tail must not hide the next completed artifact", async () => {
  const wo = await proposed();
  const entry = wo.commits[0];
  writeFileSync(outbox.OUTBOX_PATH, '{"id":"interrupted');
  const landed = await core.getTool(entry.tool)({ ...entry.args, idempotencyKey: entry.idempotencyKey });
  const visibleBefore = outbox.readOutbox().length;
  const result = await core.commit(wo.id, "1-send", actor);
  details = { visibleBefore, firstReceipt: landed.id, secondReceipt: result.externalId,
    reused: result.reused, firstReceiptStillInRawFile: readFileSync(outbox.OUTBOX_PATH, "utf8").includes(landed.id) };
  assert.equal(result.reused, true, "valid append was concatenated with torn tail, then resent");
});

await check("an unknown tool cannot be reported as completed work", async () => {
  const wo = await proposed([step("1-do-work", "unsupported.provider.action", "reversible")]);
  details = { status: wo.steps[0].status, output: wo.steps[0].output };
  assert.notEqual(wo.steps[0].status, "done", "unsupported tool marked done despite no execution");
});

await check("concurrent workorder runs execute each reversible step once", async () => {
  const wo = create([step("1-research", "search", "reversible")]);
  await Promise.all([core.runReversible(wo.id), core.runReversible(wo.id)]);
  const count = inspect.toolCalls(wo.id).length;
  details = { runnerCount: 2, toolCalls: count };
  assert.equal(count, 1, "both runners treated running as abandoned without a run ownership check");
});

await check("unknown outcome retains an operator recovery action", async () => {
  const wo = await proposed();
  const original = registry.commitTools["mail.send"];
  registry.commitTools["mail.send"] = async () => ({});
  try {
    await core.commit(wo.id, "1-send", actor);
    const after = core.getWorkOrder(wo.id);
    details = { ledgerStatus: after.commits[0].status, stepStatus: after.steps[0].status,
      pendingApproval: Boolean(core.pendingApproval(after)) };
    assert.ok(core.pendingApproval(after), "outcome_unknown disappears from pendingApproval without a recovery API");
  } finally {
    registry.commitTools["mail.send"] = original;
  }
});

const report = { stateDir: process.env.STATE_DIR, passed: rows.filter((r) => r.status === "PASS").length,
  failed: rows.filter((r) => r.status === "FAIL").length, checks: rows };
writeFileSync(join(process.env.STATE_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
coreLog(`\n${report.passed} passed; ${report.failed} failed. Evidence: ${join(process.env.STATE_DIR, "report.json")}`);
process.exitCode = report.failed ? 1 : 0;
