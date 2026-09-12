// Offline review probe for the actual listener handlers. No listener or network is started.
// Dataset cases drive the real core against an automatically removed temporary database.
// Run: node --import tsx scripts/review-channel.mjs
// Recovery regressions assert desired behavior; remaining limitations are labeled separately.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as ui from "@copilotkit/channels/ui";
import * as jsxRuntime from "@copilotkit/channels/jsx-runtime";
import { renderSlackMessage } from "@copilotkit/channels/slack/render";
import { EventSchemas } from "@ag-ui/core";
import { ActionRegistry } from "../node_modules/@copilotkit/channels-core/dist/action-registry.js";
import { MemoryStore } from "../node_modules/@copilotkit/channels-core/dist/state/memory-store.js";
import { kvActionStore } from "../node_modules/@copilotkit/channels-core/dist/state/kv-action-store.js";

const stateDir = mkdtempSync(join(tmpdir(), "durable-channel-review-"));
process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));
process.env.STATE_DIR = stateDir;
process.env.STUB_DELAY_MS = "0";
const core = await import("../src/core/index.ts");
const { NotApprovedError, NotAuthorizedError, pendingApproval } = core;
const { createFromThread } = await import("../src/core/recovery.ts");
const { datasetSlackApprovers, mentionSelection, SELECTION_HELP, SourceSelectionError } = await import("../src/channel/datasets.ts");
const { runIdFromThreadKey } = await import("../src/core/state.ts");
const { readOutbox } = await import("../src/tools/outbox.ts");

const sourceUrl = new URL("../src/channel/listener.tsx", import.meta.url);
const raw = readFileSync(sourceUrl, "utf8");
assert.ok(raw.includes("const intelligence ="), "Update harness if listener bootstrap changes");
const handlerSource = raw.slice(0, raw.indexOf("const intelligence =")).replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));
const parsed = ts.createSourceFile("listener.tsx", handlerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const noImports = ts.factory.updateSourceFile(parsed, parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)));
const runnable = ts.transpileModule(ts.createPrinter().printFile(noImports), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "@copilotkit/channels" },
}).outputText;

function baseWorkOrder() {
  return {
    id: "WO-review-thread", threadRef: "review-thread", scenario: "review", constraints: ["Do not promise a credit"], approvers: ["U_OWNER"],
    steps: [{ id: "1-send", name: "Send customer update", tool: "mail.send", kind: "commit", status: "waiting_human", classifiedBy: "allowlist_override" }, { id: "2-followup", name: "Follow up", tool: "search", kind: "reversible", status: "pending", classifiedBy: "model" }],
    commits: [{ idempotencyKey: "WO-review-thread:1-send:mail.send:hash", tool: "mail.send", args: { to: "ops@example.test", subject: "Reviewed incident", body: "Reviewed update" }, status: "proposed" }],
  };
}

function harness(options = {}) {
  const state = { wo: options.wo ?? baseWorkOrder(), posted: [], triggers: [], commits: [], mirrors: [], planned: [], created: [], mention: undefined, channelOptions: undefined };
  const threadFor = conversationKey => ({ conversationKey, post: async (tree) => { state.posted.push(renderSlackMessage(ui.renderToIR(tree))); return { id: `mock-message-${state.posted.length}` }; } });
  const thread = threadFor(options.conversationKey ?? "review-thread");
  const env = { CHANNEL_CODE: "offline-review", TRIGGER_SECRET_KEY: "inert-mocked-key", APPROVERS: "UOWNER001", ...options.env };
  const context = vm.createContext({
    ...ui, URL, readFileSync, setTimeout, clearTimeout, exports: {}, console: { log() {}, warn() {} },
    process: { env },
    require(name) { assert.equal(name, "@copilotkit/channels/jsx-runtime"); return jsxRuntime; },
    createChannel(config) { state.channelOptions = config; return { onMention(handler) { state.mention = handler; } }; },
    NotApprovedError, NotAuthorizedError, pendingApproval, mentionSelection, SELECTION_HELP, SourceSelectionError,
    datasetSlackApprovers(id) { return datasetSlackApprovers(id, env.DATASET_SLACK_USERS ?? ""); },
    createFromThread(id, opts) { assert.ok(options.realEngine); const wo = createFromThread(id, opts); if (wo) { state.created.push(wo); state.wo = wo; } return wo; },
    getWorkOrder(id) { return options.realEngine ? core.getWorkOrder(id) : state.wo; },
    findWorkOrder(id) { return options.realEngine ? core.findWorkOrder(id) : options.newWorkOrder ? undefined : state.wo; },
    createWorkOrder(args) { state.created.push(args); state.wo = options.realEngine ? core.createWorkOrder(args) : { ...args, commits: [] }; return state.wo; },
    plan: async (text) => { state.planned.push(text); if (options.planGate) await options.planGate; if (options.planError) throw options.planError; return { steps: [], constraints: [] }; },
    commit: async (...args) => {
      state.commits.push(args);
      if (options.realEngine) return core.commit(...args);
      if (options.commitError) throw options.commitError;
      const result = options.commitResult ?? { reused: false, status: "committed", externalId: "receipt-review", idempotencyKey: "review-key" };
      if (result.status === "committed") {
        state.wo.steps.find(s => s.id === args[1]).status = "committed";
        Object.assign(state.wo.commits[0], { status: "committed", externalId: result.externalId });
      }
      return result;
    },
    deny(...args) { if (options.realEngine) return core.deny(...args); if (options.denyError) throw options.denyError; return state.wo; },
    mirrorSoon(wo) { state.mirrors.push(wo.id); },
    STATE_DIR: stateDir, runIdFromThreadKey(key) { return options.realEngine ? runIdFromThreadKey(key) : "review-thread"; },
    tasks: { trigger: async (...args) => { state.triggers.push(args); if (options.triggerError) throw options.triggerError; if (options.realEngine) state.wo = await core.runReversible(args[1].woId); return { id: "run-review" }; } },
    runs: { async *subscribeToRun() { if (options.runGate) await options.runGate; options.onRunComplete?.(state.wo); yield { status: "COMPLETED" }; } },
  });
  vm.runInContext(`${runnable}\nglobalThis.handlers = { onApprove, onDeny, runJob, ApprovalCard };`, context);
  return { ...context.handlers, state, thread, threadFor, text: () => JSON.stringify(state.posted) };
}

const reports = [];
function record(name, facts) { reports.push({ name, ...facts }); }

{
  const h = harness({ triggerError: new Error("mock follow-on Trigger unavailable") });
  await h.onApprove(h.thread, "U_OWNER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.ok(h.text().includes("Committed"));
  assert.ok(h.text().includes("Something went wrong"));
  assert.ok(!h.text().includes("Nothing was sent"));
  assert.ok(h.text().includes("1 receipt on WO-review-thread"));
  record("commit-success-follow-on-failure-preserves-receipt", { passed: true });
}
{
  const h = harness({ commitResult: { reused: true, status: "committed", externalId: "receipt-review" } });
  await h.onApprove(h.thread, "U_OWNER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.equal(h.state.triggers.length, 1);
  record("reconciled-or-reused-receipt-resumes-followup", { passed: true, followupTriggers: h.state.triggers.length });
}
{
  const h = harness({ newWorkOrder: true });
  const text = "Review Acme's outage. Do not email anyone.";
  await h.state.mention({ thread: h.thread, message: { text, actor: { id: "U_REQUESTER", kind: "human" } } });
  assert.equal(h.state.planned.length, 0);
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.triggers.length, 0);
  assert.ok(h.text().includes("Choose a source thread"));
  assert.ok(h.text().includes("THREAD-ACME-OUTAGE"));
  record("custom-request-without-explicit-source-is-refused", { passed: true });
}
{
  const wo = baseWorkOrder();
  wo.commits[0].status = "outcome_unknown";
  wo.commits[0].attemptedAt = new Date().toISOString();
  const h = harness({ wo });
  await h.runJob(h.thread, wo.id);
  assert.ok(!h.text().includes("Finished"));
  assert.ok(h.text().includes("Outcome unknown"));
  assert.ok(h.text().includes("Reconcile / retry"));
  assert.ok(!h.text().includes('"text":"Deny"'));
  assert.equal(wo.steps[0].status, "waiting_human");
  record("unknown-outcome-recovery-card-has-no-deny", { passed: true });
}
{
  const h = harness({ commitError: new NotAuthorizedError("U_STRANGER", ["U_OWNER"]) });
  await h.onApprove(h.thread, "U_STRANGER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.ok(h.text().includes("Not authorized"));
  assert.equal(h.state.triggers.length, 0);
  record("unauthorized-core-result-rendered", { passed: true });
}
{
  const h = harness({ commitResult: { reused: false, status: "outcome_unknown" } });
  const store = new MemoryStore();
  function registry(backend) { const r = new ActionRegistry({ store: kvActionStore(backend) }); r.registerComponent("ApprovalCard", h.ApprovalCard); return r; }
  const first = registry(store);
  const tree = await first.bindTree("ApprovalCard", { woId: h.state.wo.id, stepId: "1-send" }, "review-thread");
  function findAction(nodes) { for (const n of nodes) { if (n.props?.onClick?.id) return n.props.onClick.id; const found = findAction(n.props?.children ?? []); if (found) return found; } }
  const id = findAction(tree);
  assert.ok(id, "Actual ApprovalCard action must bind");
  const ctx = { thread: h.thread, actor: { id: "U_OWNER", kind: "human" }, platform: "slack", action: { id }, values: {}, user: null, message: { ref: { id: "mock-message" }, text: "", actor: { id: "U_OWNER", kind: "human" }, user: null, platform: "slack" } };
  await registry(store).dispatch(id, ctx);
  assert.equal(h.state.commits.length, 1);
  await assert.rejects(() => registry(new MemoryStore()).dispatch(id, ctx), { code: "channel_action_expired" });
  record("registered-component-memory-store-cold-recovery", { knownLimitation: true, passedWithRetainedStore: true, freshMemoryStoreError: "channel_action_expired" });
}
{
  const h = harness();
  h.state.wo.commits[0].args.body = "X".repeat(15000);
  await h.thread.post(jsxRuntime.jsx(h.ApprovalCard, { woId: h.state.wo.id, stepId: "1-send" }));
  const maxSection = Math.max(...h.state.posted[0].blocks.filter((b) => b.type === "section").map((b) => b.text?.text?.length ?? 0));
  assert.equal(maxSection, 3000);
  record("actual-approval-card-long-body-truncated", { knownLimitation: true, inputLength: 15000, renderedSectionLength: maxSection, hasFullDraftLink: h.text().includes('"url":') });
}
{
  const wo = baseWorkOrder();
  wo.commits[0].status = "approved";
  wo.commits[0].attemptedAt = new Date().toISOString();
  const h = harness({ wo });
  await h.thread.post(jsxRuntime.jsx(h.ApprovalCard, { woId: wo.id, stepId: "1-send" }));
  assert.ok(!h.text().includes('"text":"Deny"'));
  assert.ok(h.text().includes("Reconcile / retry"));
  record("in-flight-approved-action-has-no-deny", { passed: true });
}
{
  const h = harness({ denyError: new Error("already committed or being sent; it cannot be denied") });
  await h.onDeny(h.thread, "U_OWNER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.ok(h.text().includes("Something went wrong"));
  assert.ok(!h.text().includes("Nothing was sent"));
  record("stale-deny-button-preserves-uncertainty", { passed: true });
}
{
  const h = harness({ commitResult: { reused: true, status: "committed", externalId: "receipt-review" } });
  await h.onApprove(h.thread, "U_STRANGER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.equal(h.state.commits.length, 0);
  assert.equal(h.state.triggers.length, 0);
  assert.ok(h.text().includes("Not authorized"));
  record("receipt-reuse-cannot-grant-outsider-continuation", { passed: true });
}
{
  let finishRun;
  const runGate = new Promise(resolve => { finishRun = resolve; });
  const h = harness({
    commitResult: { reused: true, status: "committed", externalId: "receipt-review" }, runGate,
    onRunComplete(wo) { wo.steps[1].status = "done"; },
  });
  const ref = { woId: h.state.wo.id, stepId: "1-send" };
  const clicks = [h.onApprove(h.thread, "U_OWNER", ref), h.onApprove(h.thread, "U_OWNER", ref)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.triggers.length, 1);
  finishRun();
  await Promise.all(clicks);
  await h.onApprove(h.thread, "U_OWNER", ref);
  assert.equal(h.state.triggers.length, 1);
  assert.ok(h.text().includes("Finished"));
  record("concurrent-reused-clicks-share-one-followup-and-completed-retry-is-read", { passed: true });
}
{
  const options = { commitResult: { reused: true, status: "committed", externalId: "receipt-review" }, triggerError: new Error("temporary unavailable") };
  const h = harness(options);
  const ref = { woId: h.state.wo.id, stepId: "1-send" };
  await h.onApprove(h.thread, "U_OWNER", ref);
  options.triggerError = undefined;
  await h.onApprove(h.thread, "U_OWNER", ref);
  assert.equal(h.state.triggers.length, 2);
  record("failed-continuation-can-be-retried", { passed: true });
}
{
  const wo = baseWorkOrder();
  wo.steps[1] = { ...wo.steps[1], kind: "commit", tool: "crm.update", status: "waiting_human" };
  wo.commits.push({ idempotencyKey: `${wo.id}:2-followup:crm.update:hash`, tool: "crm.update", args: {}, status: "proposed" });
  const h = harness({ wo, commitResult: { reused: true, status: "committed", externalId: "receipt-review" } });
  await h.onApprove(h.thread, "U_OWNER", { woId: wo.id, stepId: "1-send" });
  assert.equal(h.state.triggers.length, 0);
  assert.ok(h.text().includes("Awaiting approval: Follow up"));
  assert.equal(wo.commits[1].status, "proposed");
  record("reuse-reposts-next-proposal-without-approving-it", { passed: true });
}
{
  const h = harness({ newWorkOrder: true, planError: new Error("Planning failed: invalid model response") });
  await h.state.mention({ thread: h.thread, message: { text: "use fixture customer-success", actor: { id: "U_OWNER", kind: "human" } } });
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.triggers.length, 0);
  assert.ok(h.text().includes("Planning failed"));
  record("planner-error-creates-no-work-order-or-run", { passed: true });
}
{
  const h = harness();
  await h.thread.post(jsxRuntime.jsx(h.ApprovalCard, { woId: h.state.wo.id, stepId: "1-send" }));
  assert.ok(h.text().includes("To: ops@example.test"));
  assert.ok(h.text().includes("Subject: Reviewed incident"));
  assert.ok(h.text().includes('"text":"Deny"'));
  record("unattempted-proposal-shows-complete-short-preview-and-deny", { passed: true });
}
{
  const events = [
    { type: "RUN_STARTED", threadId: "WO-review", runId: "attempt-2" },
    { type: "STATE_SNAPSHOT", snapshot: { approval: "waiting_human", receipts: 0 } },
    { type: "STEP_STARTED", stepName: "prepare-approval" },
    { type: "CUSTOM", name: "durable.approval_requested", value: { workOrderId: "WO-review" } },
    { type: "STEP_FINISHED", stepName: "prepare-approval" },
    { type: "RUN_FINISHED", threadId: "WO-review", runId: "attempt-2" },
  ];
  events.forEach((event) => EventSchemas.parse(event));
  record("proposed-agui-observer-shapes", { passed: true, validatedEvents: events.length });
}

// Two real humans may play multiple personas across scenarios, but never collapse
// two approvers of the same work order. These are inert test platform IDs.
const slackUsers = { U_MAYA: "UALPHA001", U_PRIYA: "UALPHA001", U_LEO: "UBETA0001", U_JULES: "UBETA0001" };
const datasetEnv = { DATASET_SLACK_USERS: JSON.stringify(slackUsers) };
const mention = (h, text, thread = h.thread, id = "UREQUEST1") => h.state.mention({ thread, message: { text, actor: { id, kind: "human" } } });

{
  const h = harness({ newWorkOrder: true, env: { PLANNER_MODE: "stub" } });
  await mention(h, "@Angie use fixture customer-success");
  assert.equal(h.state.planned.length, 1);
  assert.ok(h.state.planned[0].includes("Northwind"));
  assert.deepEqual([...h.state.created[0].approvers], ["UOWNER001"]);
  assert.ok(!h.state.created[0].approvers.includes("UREQUEST1"));
  record("explicit-fixture-keeps-planner-and-configured-approvers-only", { passed: true });
}
{
  const h = harness({ newWorkOrder: true, env: { APPROVERS: "" } });
  await mention(h, "use fixture customer-success");
  assert.equal(h.state.planned.length, 0);
  assert.equal(h.state.created.length, 0);
  assert.ok(h.text().includes("requester is not automatically an approver"));
  record("fixture-without-approver-configuration-is-refused", { passed: true });
}

for (const [threadId, recipient, fact] of [
  ["THREAD-ACME-OUTAGE", "dana@acme-robotics.example", "18 minutes"],
  ["THREAD-HELIX-SECURITY", "irina@helix-health.example", "public trust center"],
  ["THREAD-LANTERN-PRICING", "chris@lantern.example", "20% off list"],
  ["THREAD-ACME-REFUND", "owen@acme-robotics.example", "not able to offer a service credit"],
]) {
  const h = harness({ realEngine: true, conversationKey: `dataset-${threadId}`, env: datasetEnv });
  await mention(h, `<@UBOT00001> TaKe ThIs ${threadId.toLowerCase()}`);
  const id = `WO-${runIdFromThreadKey(h.thread.conversationKey)}`;
  const wo = core.getWorkOrder(id);
  assert.equal(wo.scenario, threadId);
  assert.equal(wo.threadRef, runIdFromThreadKey(h.thread.conversationKey));
  assert.equal(wo.commits[0]?.status, "proposed");
  assert.equal(wo.commits[0].args.to, recipient);
  assert.ok(wo.commits[0].args.body.includes(fact));
  assert.ok(h.text().includes(recipient));
  assert.ok(h.text().includes(fact));
  assert.ok(h.text().includes("Awaiting approval"));
  wo.constraints.forEach(constraint => assert.ok(h.text().includes(constraint)));
  assert.ok(!wo.approvers.includes("UREQUEST1"));
  assert.ok(wo.approvers.every(id => /^[UW][A-Z0-9]{8,}$/.test(id)));
  assert.equal(h.state.planned.length, 0);
  assert.equal(h.state.triggers.length, 1);
  if (threadId === "THREAD-LANTERN-PRICING") {
    assert.deepEqual(wo.approvers, ["UALPHA001"]);
    assert.ok(!wo.commits[0].args.body.includes("40%"));
    assert.ok(!wo.commits[0].args.body.includes("founder@"));
    await h.onApprove(h.thread, "UBETA0001", { woId: id, stepId: wo.steps.at(-1).id });
    assert.equal(core.getWorkOrder(id).commits[0].status, "proposed");
    assert.equal(h.state.commits.length, 0);
    assert.ok(h.text().includes("Not authorized"));
  }
  record(`dataset-handler-and-renderer-${threadId}`, { passed: true, recipient, approvers: wo.approvers });
}

{
  const h = harness({ realEngine: true, conversationKey: "dataset-reuse-first", env: datasetEnv });
  await mention(h, "take this THREAD-ACME-OUTAGE");
  const id = `WO-${runIdFromThreadKey(h.thread.conversationKey)}`;
  const original = core.getWorkOrder(id);
  await mention(h, "@Angie take this");
  await mention(h, "take this THREAD-ACME-OUTAGE");
  assert.equal(h.state.created.length, 1);
  assert.equal(h.state.triggers.length, 1);
  assert.deepEqual(core.getWorkOrder(id), original);
  await mention(h, "take this THREAD-HELIX-SECURITY");
  assert.ok(h.text().includes("Source already selected"));
  assert.equal(h.state.created.length, 1);
  assert.deepEqual(core.getWorkOrder(id), original);
  const other = h.threadFor("dataset-reuse-second");
  await mention(h, "take this THREAD-ACME-OUTAGE", other);
  const otherId = `WO-${runIdFromThreadKey(other.conversationKey)}`;
  assert.notEqual(otherId, id);
  assert.equal(core.getWorkOrder(otherId).scenario, original.scenario);
  assert.notEqual(core.getWorkOrder(otherId).commits[0].idempotencyKey, original.commits[0].idempotencyKey);
  assert.equal(h.state.triggers.length, 2);
  record("dataset-conversation-identity-resume-and-source-lock", { passed: true });
}

{
  let finishPlan;
  const planGate = new Promise(resolve => { finishPlan = resolve; });
  const h = harness({ realEngine: true, conversationKey: "dataset-source-race", env: datasetEnv, planGate });
  const fixtureMention = mention(h, "use fixture customer-success");
  await mention(h, "take this THREAD-ACME-OUTAGE");
  finishPlan();
  await fixtureMention;
  const wo = core.getWorkOrder(`WO-${runIdFromThreadKey(h.thread.conversationKey)}`);
  assert.equal(wo.scenario, "THREAD-ACME-OUTAGE");
  assert.deepEqual(wo.approvers, ["UALPHA001", "UBETA0001"]);
  assert.equal(h.state.triggers.length, 1);
  assert.ok(h.text().includes("Source already selected"));
  record("dataset-source-selection-survives-concurrent-fixture-plan", { passed: true });
}

for (const [name, text, mapping, expected] of [
  ["empty", "take this THREAD-EMPTY", datasetEnv.DATASET_SLACK_USERS, "needs a customer"],
  ["unknown", "take this THREAD-NOT-FOUND", datasetEnv.DATASET_SLACK_USERS, "Unknown dataset thread"],
  ["short-context", "@Angie take this", datasetEnv.DATASET_SLACK_USERS, "Choose a source thread"],
  ["long-context", "Please help Acme Robotics with a long outage description. This is longer than eighty characters but has no explicit source selection.", datasetEnv.DATASET_SLACK_USERS, "Choose a source thread"],
  ["missing-env", "take this THREAD-ACME-OUTAGE", "", "not configured"],
  ["missing-role", "take this THREAD-ACME-OUTAGE", JSON.stringify({ U_MAYA: "UALPHA001" }), "missing an approver mapping for U_LEO"],
  ["same-thread-duplicate", "take this THREAD-ACME-OUTAGE", JSON.stringify({ U_MAYA: "UALPHA001", U_LEO: "UALPHA001" }), "distinct identity"],
  ["unknown-role", "take this THREAD-ACME-OUTAGE", JSON.stringify({ ...slackUsers, U_UNKNOWN: "UGAMMA001" }), "unknown dataset user"],
  ["synthetic-target", "take this THREAD-ACME-OUTAGE", JSON.stringify({ ...slackUsers, U_MAYA: "U_MAYA" }), "real Slack user ID"],
  ["intern-role", "take this THREAD-ACME-OUTAGE", JSON.stringify({ ...slackUsers, U_SAM: "UGAMMA001" }), "cannot be mapped"],
  ["agent-role", "take this THREAD-ACME-OUTAGE", JSON.stringify({ ...slackUsers, U_COWORKER: "UALPHA001" }), "cannot be mapped"],
  ["duplicate-key", "take this THREAD-ACME-OUTAGE", '{"U_MAYA":"UALPHA001","U_MAYA":"UGAMMA001","U_LEO":"UBETA0001"}', "duplicate keys"],
  ["bad-json", "take this THREAD-ACME-OUTAGE", "{", "must be a JSON object"],
  ["multiple-selectors", "take this THREAD-ACME-OUTAGE THREAD-HELIX-SECURITY", datasetEnv.DATASET_SLACK_USERS, "one explicit source"],
]) {
  const h = harness({ realEngine: true, conversationKey: `dataset-refused-${name}`, env: { DATASET_SLACK_USERS: mapping } });
  await mention(h, text);
  assert.equal(core.findWorkOrder(`WO-${runIdFromThreadKey(h.thread.conversationKey)}`), undefined);
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.planned.length, 0);
  assert.equal(h.state.triggers.length, 0);
  assert.ok(h.text().includes(expected), `${name}: ${h.text()}`);
  record(`dataset-refuses-${name}`, { passed: true });
}

{
  const h = harness({ realEngine: true, conversationKey: "dataset-callback", env: datasetEnv });
  await mention(h, "take this THREAD-LANTERN-PRICING");
  const wo = core.getWorkOrder(`WO-${runIdFromThreadKey(h.thread.conversationKey)}`);
  const stepId = wo.steps.at(-1).id;
  const registry = new ActionRegistry({ store: kvActionStore(new MemoryStore()) });
  registry.registerComponent("ApprovalCard", h.ApprovalCard);
  const tree = await registry.bindTree("ApprovalCard", { woId: wo.id, stepId }, h.thread.conversationKey);
  function findAction(nodes) { for (const n of nodes) { if (n.props?.onClick?.id) return n.props.onClick.id; const found = findAction(n.props?.children ?? []); if (found) return found; } }
  const actionId = findAction(tree);
  assert.ok(actionId);
  const dispatch = actorId => registry.dispatch(actionId, { thread: h.thread, actor: { id: actorId, kind: "human" }, platform: "slack", action: { id: actionId }, values: {}, user: null, message: { ref: { id: "mock-message" }, text: "", actor: { id: actorId, kind: "human" }, user: null, platform: "slack" } });
  const before = readOutbox().length;
  await dispatch("UBETA0001");
  assert.equal(core.getWorkOrder(wo.id).commits[0].status, "proposed");
  assert.equal(readOutbox().length, before);
  await dispatch("UALPHA001");
  assert.equal(core.getWorkOrder(wo.id).commits[0].status, "committed");
  await dispatch("UALPHA001");
  assert.equal(readOutbox().length, before + 1);
  assert.ok(h.text().includes("Already committed"));
  record("dataset-real-card-click-enforces-actor-and-reuses-local-receipt", { passed: true, localOutboxRowsAdded: 1, externalSends: 0 });
}
console.log(JSON.stringify({ mode: "offline-handler-review", source: "src/channel/listener.tsx", reports }, null, 2));
