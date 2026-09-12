// Offline review probe for the actual listener handlers. No listener, network, or database is started.
// Run: node --import tsx scripts/review-channel.mjs
// Reproductions assert current defects, rather than being regression acceptance tests.
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
    commits: [{ idempotencyKey: "WO-review-thread:1-send:mail.send:hash", tool: "mail.send", args: { to: "ops@example.test", body: "Reviewed update" }, status: "proposed" }],
  };
}

function harness(options = {}) {
  const state = { wo: options.wo ?? baseWorkOrder(), posted: [], triggers: [], commits: [], planned: [], created: [], mention: undefined, channelOptions: undefined };
  const thread = { conversationKey: "review-thread", post: async (tree) => { state.posted.push(renderSlackMessage(ui.renderToIR(tree))); return { id: `mock-message-${state.posted.length}` }; } };
  const context = vm.createContext({
    ...ui, URL, readFileSync, exports: {}, console: { log() {}, warn() {} },
    process: { env: { CHANNEL_CODE: "offline-review", TRIGGER_SECRET_KEY: "inert-mocked-key", APPROVERS: "U_OWNER" } },
    require(name) { assert.equal(name, "@copilotkit/channels/jsx-runtime"); return jsxRuntime; },
    createChannel(config) { state.channelOptions = config; return { onMention(handler) { state.mention = handler; } }; },
    NotApprovedError, NotAuthorizedError, pendingApproval,
    getWorkOrder() { return state.wo; }, findWorkOrder() { return options.newWorkOrder ? undefined : state.wo; },
    createWorkOrder(args) { state.created.push(args); state.wo = { ...args, commits: [] }; return state.wo; },
    plan: async (text) => { state.planned.push(text); return { steps: [], constraints: [] }; },
    commit: async (...args) => { state.commits.push(args); if (options.commitError) throw options.commitError; return options.commitResult ?? { reused: false, status: "committed", externalId: "receipt-review", idempotencyKey: "review-key" }; },
    deny() { if (options.denyError) throw options.denyError; },
    outboxRows() { return options.outbox ?? []; },
    STATE_DIR: "/offline-review-never-written", runIdFromThreadKey() { return "review-thread"; },
    tasks: { trigger: async (...args) => { state.triggers.push(args); if (options.triggerError) throw options.triggerError; return { id: "run-review" }; } },
    runs: { async *subscribeToRun() { yield { status: "COMPLETED" }; } },
  });
  vm.runInContext(`${runnable}\nglobalThis.handlers = { onApprove, onDeny, runJob, ApprovalCard };`, context);
  return { ...context.handlers, state, thread, text: () => JSON.stringify(state.posted) };
}

const reports = [];
function record(name, facts) { reports.push({ name, ...facts }); }

{
  const h = harness({ triggerError: new Error("mock follow-on Trigger unavailable"), outbox: [{ id: "receipt-review" }] });
  await h.onApprove(h.thread, "U_OWNER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.ok(h.text().includes("Committed"));
  assert.ok(h.text().includes("Nothing was sent. The listener is still up."));
  record("commit-success-follow-on-failure-misreported", { reproduced: true, committedReceipt: "receipt-review", contradictoryCard: "Nothing was sent" });
}
{
  const h = harness({ commitResult: { reused: true, status: "committed", externalId: "receipt-review" } });
  await h.onApprove(h.thread, "U_OWNER", { woId: h.state.wo.id, stepId: "1-send" });
  assert.equal(h.state.triggers.length, 0);
  record("reconciled-or-reused-receipt-does-not-resume-followup", { reproduced: true, followupTriggers: h.state.triggers.length });
}
{
  const h = harness({ newWorkOrder: true });
  const text = "Review Acme's outage. Do not email anyone.";
  await h.state.mention({ thread: h.thread, message: { text, actor: { id: "U_REQUESTER", kind: "human" } } });
  assert.notEqual(h.state.planned[0], text);
  assert.ok(h.state.planned[0].includes("Northwind"));
  assert.deepEqual([...h.state.created[0].approvers], ["U_REQUESTER", "U_OWNER"]);
  record("short-custom-request-replaced-and-requester-can-approve", { reproduced: true, suppliedCustomer: "Acme", plannedCustomer: "Northwind", approvers: [...h.state.created[0].approvers] });
}
{
  const wo = baseWorkOrder();
  wo.commits[0].status = "outcome_unknown";
  const h = harness({ wo });
  await h.runJob(h.thread, wo.id);
  assert.ok(h.text().includes("Finished"));
  assert.equal(wo.steps[0].status, "waiting_human");
  record("unknown-outcome-with-pending-work-reported-finished", { reproduced: true, ledgerStatus: wo.commits[0].status, stepStatus: wo.steps[0].status });
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
  record("registered-component-memory-store-cold-recovery", { passedWithRetainedStore: true, freshMemoryStoreError: "channel_action_expired" });
}
{
  const h = harness();
  h.state.wo.commits[0].args.body = "X".repeat(15000);
  await h.thread.post(jsxRuntime.jsx(h.ApprovalCard, { woId: h.state.wo.id, stepId: "1-send" }));
  const maxSection = Math.max(...h.state.posted[0].blocks.filter((b) => b.type === "section").map((b) => b.text?.text?.length ?? 0));
  assert.equal(maxSection, 3000);
  record("actual-approval-card-long-body-truncated", { inputLength: 15000, renderedSectionLength: maxSection, hasFullDraftLink: h.text().includes('"url":') });
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
