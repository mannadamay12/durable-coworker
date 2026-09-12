// Offline regression checks for the model-to-work-order boundary.
// No HTTP requests leave this process. Run: node scripts/recovery-planner.test.mjs
import { register } from "tsx/esm/api";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

register();

const originalFetch = globalThis.fetch;
const envKeys = ["PLANNER_MODE", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const requests = [];
let responseFor;
let checks = 0;
const check = async (name, run) => {
  await run();
  checks++;
  console.log(`ok ${checks} ${name}`);
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
  assert.equal(url.origin, "http://127.0.0.1:1", "test blocked an external model endpoint");
  const body = JSON.parse(init?.body ?? await input.text());
  requests.push(body);
  return responseFor(body);
};
process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:1/v1";

const fixture = JSON.parse(readFileSync(new URL("../scenarios/customer-success.json", import.meta.url), "utf8"));
const goodStep = { id: "1-draft-acme", name: "Draft Acme Freight update", kind: "reversible", tool: "draft" };
const goodPlan = { steps: [goodStep] };
const goodConstraints = { constraints: ["Do not promise a credit"] };
function respond(planned = goodPlan, extracted = goodConstraints) {
  responseFor = (request) => new Response(JSON.stringify({
    id: "recovery-planner-mock",
    object: "chat.completion",
    created: 0,
    model: "local-mock",
    choices: [{ index: 0, message: {
      role: "assistant",
      content: JSON.stringify(request.response_format.json_schema.name === "plan_steps" ? planned : extracted),
    }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

try {
  const { plan } = await import("../src/agent/plan.ts");

  await check("only explicit stub mode returns the demo fixture without a model key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.PLANNER_MODE = "stub";
    const result = await plan("An unrelated request in explicitly selected demo mode");
    assert.deepEqual(result.steps.map((step) => step.id), fixture.expected.steps.map((step) => step.id));
    assert.deepEqual(result.constraints, fixture.expected.constraints);
    assert.equal(requests.length, 0);
  });
  await check("missing key in default or model mode fails before any work can be created", async () => {
    delete process.env.PLANNER_MODE;
    await assert.rejects(plan("Acme Freight needs an update"), /Planner is unavailable.*No plan was created/);
    process.env.PLANNER_MODE = "model";
    await assert.rejects(plan("Acme Freight needs an update"), /Planner is unavailable.*No plan was created/);
    assert.equal(requests.length, 0);
  });

  process.env.OPENROUTER_API_KEY = "recovery-in-memory-key";
  await check("valid response preserves request-specific steps and constraints", async () => {
    const text = "Acme Freight needs an incident update. Do not promise a credit.";
    respond();
    const result = await plan(text);
    assert.equal(result.steps[0].name, goodStep.name);
    assert.equal(result.steps[0].id, goodStep.id);
    assert.equal(result.steps[0].status, "pending");
    assert.deepEqual(result.constraints, goodConstraints.constraints);
    assert.ok(requests.slice(-2).every((request) => request.messages.at(-1).content === text));
    assert.ok(!JSON.stringify(result).includes("Northwind"));
  });
  await check("null, missing, numeric, colon, duplicate, and oversized IDs get unique safe identities", async () => {
    const labels = [null, undefined, 42, {}, "", "same:id", "same:id", "a".repeat(1000)];
    respond({ steps: labels.map((id) => ({ ...goodStep, id, status: "committed", output: "model-claimed receipt" })) });
    const result = await plan("Prepare Acme's internal drafts");
    assert.equal(result.steps.length, labels.length);
    assert.equal(new Set(result.steps.map((step) => step.id)).size, labels.length);
    result.steps.forEach((step, index) => {
      assert.match(step.id, new RegExp(`^${index + 1}-[a-z0-9]+(?:-[a-z0-9]+)*$`));
      assert.ok(step.id.length <= 84);
      assert.equal(step.status, "pending");
      assert.equal(step.output, undefined);
    });
  });
  await check("known external tools cannot be made reversible by the model", async () => {
    const tools = ["mail.send", "crm.update", "calendar.invite", "esign.send"];
    respond({ steps: tools.map((tool) => ({ ...goodStep, tool })) });
    const result = await plan("Prepare external actions for approval");
    for (const step of result.steps) {
      assert.equal(step.kind, "commit");
      assert.equal(step.classifiedBy, "allowlist_override");
      assert.equal(step.status, "pending");
    }
  });
  await check("valid internal steps may have no tool", async () => {
    respond({ steps: [{ ...goodStep, tool: null }] }, { constraints: [] });
    const result = await plan("Record an internal note");
    assert.equal(result.steps[0].tool, undefined);
    assert.deepEqual(result.constraints, []);
  });

  const invalidPlans = [
    ["null plan", null], ["array plan", []], ["missing steps", {}],
    ["null steps", { steps: null }], ["object steps", { steps: {} }], ["empty steps", { steps: [] }],
    ["null step", { steps: [null] }], ["string step", { steps: ["draft"] }],
    ["numeric name", { steps: [{ ...goodStep, name: 42 }] }],
    ["blank name", { steps: [{ ...goodStep, name: " " }] }],
    ["invalid kind", { steps: [{ ...goodStep, kind: "approved" }] }],
    ["missing tool", { steps: [{ id: "1", name: "Draft", kind: "reversible" }] }],
    ["near-miss tool", { steps: [{ ...goodStep, tool: "mail_send" }] }],
    ["unknown tool", { steps: [{ ...goodStep, tool: "shell.exec" }] }],
    ["object tool", { steps: [{ ...goodStep, tool: { name: "draft" } }] }],
    ["commit without tool", { steps: [{ ...goodStep, kind: "commit", tool: null }] }],
    ["commit with internal tool", { steps: [{ ...goodStep, kind: "commit", tool: "search" }] }],
  ];
  for (const [name, planned] of invalidPlans) {
    await check(`${name} rejects visibly without substituting a fixture`, async () => {
      respond(planned);
      await assert.rejects(plan("Acme Freight needs an update"), /Planner response is invalid:.*No plan was created/);
    });
  }
  const invalidConstraints = [null, [], {}, { constraints: "Never send" }, { constraints: null },
    { constraints: {} }, { constraints: ["Never send", 42] }, { constraints: [" "] }];
  for (const [index, extracted] of invalidConstraints.entries()) {
    await check(`malformed constraints ${index + 1} reject rather than being lost or split into characters`, async () => {
      respond(goodPlan, extracted);
      await assert.rejects(plan("Do not send anything for Acme Freight"), /Planner response is invalid:.*No plan was created/);
    });
  }
  await check("provider HTTP failure is visible and does not return another customer's plan", async () => {
    responseFor = () => new Response(JSON.stringify({ error: { message: "unavailable" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    await assert.rejects(plan("Acme Freight needs an update"), /Planner request failed\. No plan was created/);
  });
  await check("non-JSON provider output fails visibly after the existing parse retry", async () => {
    const before = requests.length;
    responseFor = () => new Response(JSON.stringify({
      choices: [{ message: { content: "not JSON" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(plan("Acme Freight needs an update"), /Planner request failed\. No plan was created/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length - before, 4);
  });
  await check("explicit stub mode still works after model errors without issuing model requests", async () => {
    const before = requests.length;
    process.env.PLANNER_MODE = "stub";
    const result = await plan(fixture.threadText);
    assert.deepEqual(result.steps.map((step) => step.id), fixture.expected.steps.map((step) => step.id));
    assert.equal(requests.length, before);
  });
  console.log(`${checks} planner recovery checks passed; all model responses were in-memory mocks`);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
