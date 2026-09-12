// Offline review probe for the actual listener handlers. No listener, network, or database is started.
// Run: node --import tsx scripts/review-channel.mjs
// Recovery regressions assert desired behavior; remaining limitations are labeled separately.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as ui from "@copilotkit/channels/ui";
import * as jsxRuntime from "@copilotkit/channels/jsx-runtime";
import { renderSlackMessage } from "@copilotkit/channels/slack/render";
import { EventSchemas } from "@ag-ui/core";
import { NotApprovedError, NotAuthorizedError, pendingApproval } from "../src/core/index.ts";
import { ActionRegistry } from "../node_modules/@copilotkit/channels-core/dist/action-registry.js";
import { MemoryStore } from "../node_modules/@copilotkit/channels-core/dist/state/memory-store.js";
import { kvActionStore } from "../node_modules/@copilotkit/channels-core/dist/state/kv-action-store.js";

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
  const thread = { conversationKey: "review-thread", post: async (tree) => { state.posted.push(renderSlackMessage(ui.renderToIR(tree))); return { id: `mock-message-${state.posted.length}` }; } };
  const context = vm.createContext({
    ...ui, URL, readFileSync, setTimeout, clearTimeout, exports: {}, console: { log() {}, warn() {} },
    process: { env: { CHANNEL_CODE: "offline-review", TRIGGER_SECRET_KEY: "inert-mocked-key", APPROVERS: "U_OWNER" } },
    require(name) { assert.equal(name, "@copilotkit/channels/jsx-runtime"); return jsxRuntime; },
    createChannel(config) { state.channelOptions = config; return { onMention(handler) { state.mention = handler; } }; },
    NotApprovedError, NotAuthorizedError, pendingApproval,
    getWorkOrder() { return state.wo; }, findWorkOrder() { return options.newWorkOrder ? undefined : state.wo; },
    createWorkOrder(args) { state.created.push(args); state.wo = { ...args, commits: [] }; return state.wo; },
    plan: async (text) => { state.planned.push(text); if (options.planError) throw options.planError; return { steps: [], constraints: [] }; },
    commit: async (...args) => {
      state.commits.push(args);
      if (options.commitError) throw options.commitError;
      const result = options.commitResult ?? { reused: false, status: "committed", externalId: "receipt-review", idempotencyKey: "review-key" };
      if (result.status === "committed") {
        state.wo.steps.find(s => s.id === args[1]).status = "committed";
        Object.assign(state.wo.commits[0], { status: "committed", externalId: result.externalId });
      }
      return result;
    },
    deny() { if (options.denyError) throw options.denyError; return state.wo; },
    mirrorSoon(wo) { state.mirrors.push(wo.id); },
    STATE_DIR: "/offline-review-never-written", runIdFromThreadKey() { return "review-thread"; },
    tasks: { trigger: async (...args) => { state.triggers.push(args); if (options.triggerError) throw options.triggerError; return { id: "run-review" }; } },
    runs: { async *subscribeToRun() { if (options.runGate) await options.runGate; options.onRunComplete?.(state.wo); yield { status: "COMPLETED" }; } },
  });
  vm.runInContext(`${runnable}\nglobalThis.handlers = { onApprove, onDeny, runJob, ApprovalCard };`, context);
  return { ...context.handlers, state, thread, text: () => JSON.stringify(state.posted) };
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
  assert.notEqual(h.state.planned[0], text);
  assert.ok(h.state.planned[0].includes("Northwind"));
  assert.deepEqual([...h.state.created[0].approvers], ["U_REQUESTER", "U_OWNER"]);
  record("short-custom-request-replaced-and-requester-can-approve", { knownLimitation: true, suppliedCustomer: "Acme", plannedCustomer: "Northwind", approvers: [...h.state.created[0].approvers] });
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
  await h.state.mention({ thread: h.thread, message: { text: "Prepare a customer update", actor: { id: "U_OWNER", kind: "human" } } });
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
console.log(JSON.stringify({ mode: "offline-handler-review", source: "src/channel/listener.tsx", reports }, null, 2));
