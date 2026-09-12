// Planner assertion script. Run from repo root: node src/agent/plan.test.mjs
// With --env-file=.env and a funded OPENROUTER_API_KEY it exercises the model path.
import { register } from "tsx/esm/api";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

register();

const { plan, enforceCommitTools } = await import(new URL("./plan.ts", import.meta.url).href);
const { COMMIT_TOOLS } = await import(new URL("../core/contract.ts", import.meta.url).href);

const fixture = JSON.parse(
  readFileSync(new URL("../../scenarios/customer-success.json", import.meta.url), "utf8"),
);

const ok = (msg) => console.log(`ok  ${msg}`);
const commitSteps = (steps) => steps.filter((s) => s.tool && COMMIT_TOOLS.has(s.tool));

{
  const { steps, constraints } = await plan(fixture.threadText);
  const commits = commitSteps(steps);
  assert.ok(commits.length > 0, "clean thread produced no COMMIT_TOOLS step");
  ok("clean thread: at least one COMMIT_TOOLS step");
  for (const s of commits) assert.equal(s.kind, "commit", `${s.tool} step ${s.id} is not commit`);
  ok("clean thread: every COMMIT_TOOLS step is commit");
  assert.ok(constraints.length > 0, "no constraints extracted");
  assert.ok(constraints.some((c) => /credit/i.test(c)), "no credit constraint extracted");
  ok("clean thread: credit constraint extracted");
}

{
  const injected = `${fixture.threadText}\n${fixture.injection.user}: ${fixture.injection.text}`;
  const { steps } = await plan(injected);
  const send = steps.find((s) => s.tool === "mail.send");
  assert.ok(send, "injected thread produced no mail.send step");
  assert.equal(send.kind, "commit");
  assert.equal(send.classifiedBy, "allowlist_override");
  ok("injected thread: mail.send step is commit via allowlist_override");
  for (const s of commitSteps(steps)) {
    assert.notEqual(s.kind, "reversible", `${s.tool} step ${s.id} downgraded to reversible`);
  }
  ok("injected thread: no COMMIT_TOOLS step is reversible");
}

{
  const input = [
    { id: "1-search", name: "Search incident", kind: "reversible", tool: "search", status: "pending", classifiedBy: "model" },
    { id: "2-send", name: "Send update", kind: "reversible", tool: "mail.send", status: "pending", classifiedBy: "model" },
    { id: "3-crm", name: "Update CRM", kind: "reversible", tool: "crm.update", status: "pending", classifiedBy: "model" },
  ];
  const snapshot = structuredClone(input);
  const out = enforceCommitTools(input);

  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(out.length, input.length);
  for (const id of ["2-send", "3-crm"]) {
    assert.equal(byId[id].kind, "commit", `${id} not forced to commit`);
    assert.equal(byId[id].classifiedBy, "allowlist_override", `${id} not marked allowlist_override`);
  }
  ok("hand-built list: mail.send and crm.update claimed reversible are forced to commit");
  assert.deepEqual(byId["1-search"], snapshot[0]);
  ok("hand-built list: search step unchanged");
  assert.deepEqual(input, snapshot);
  ok("hand-built list: input not mutated");
}

console.log("all planner assertions passed");
