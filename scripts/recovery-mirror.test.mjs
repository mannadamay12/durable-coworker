// Offline regressions for the actual Trigger task and mirror modules. All filesystem,
// database, scheduler, SDK and provider boundaries are in memory; no .env is loaded.
// Run: node scripts/recovery-mirror.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const compiled = new Map();
function load(relative, dependencies = {}, globals = {}) {
  if (!compiled.has(relative)) {
    const source = readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
    compiled.set(relative, ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
  }
  const exports = {};
  vm.runInNewContext(compiled.get(relative), {
    exports, Error, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name} in ${relative}`);
      return dependencies[name];
    },
  }, { filename: relative });
  return exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function workOrder(status = "running") {
  return {
    id: "WO-MIRROR-RECOVERY", scenario: "Mirror failure isolation", threadRef: "offline-review",
    constraints: ["Do not send before approval"], approvers: ["U_REVIEW"],
    steps: [{ id: "draft", name: "Draft update", tool: "draft", kind: "reversible", status, classifiedBy: "model" }],
    commits: [],
  };
}

function harness(options = {}) {
  const state = {
    wo: workOrder(), run: deferred(), reads: 0, failNextRead: false,
    logs: [], warnings: [], mirrorErrors: [], intervals: new Map(), cleared: [],
    files: new Map(), fileWrites: 0, remote: [],
  };
  const renderer = load("src/mirror/render.ts");
  const mirror = load("src/mirror/index.ts", {
    "node:path": { resolve },
    "node:fs": {
      existsSync: path => state.files.has(path),
      mkdirSync() {},
      readFileSync(path) { assert.ok(state.files.has(path)); return state.files.get(path); },
      writeFileSync(path, body) {
        if (options.fileFailure) throw new Error("mock filesystem unavailable");
        state.fileWrites++;
        state.files.set(path, body);
      },
      renameSync(from, to) { state.files.set(to, state.files.get(from)); state.files.delete(from); },
    },
    "../core/state.js": { STATE_DIR: "/memory-only" },
    "./render.js": renderer,
    "./ambiguous.js": {
      ambiguousConfigured: () => true,
      upsertDoc(existing, title, body) {
        const request = { existing, title, body, ...deferred() };
        state.remote.push(request);
        return request.promise;
      },
    },
  }, {
    process: { env: {}, pid: 42 },
    console: { error: message => state.mirrorErrors.push(message) },
  });
  const task = load("src/trigger/workorder.ts", {
    "@trigger.dev/sdk": {
      task: definition => definition,
      logger: {
        log: message => state.logs.push(message),
        warn: message => state.warnings.push(message),
      },
    },
    "../core/index.js": {
      getWorkOrder(id) {
        assert.equal(id, state.wo.id);
        state.reads++;
        if (state.failNextRead) { state.failNextRead = false; throw new Error("mock SQLite read failed"); }
        return structuredClone(state.wo);
      },
      runReversible: () => state.run.promise,
      pendingApproval(wo) {
        const step = wo.steps.find(step => step.status === "waiting_human");
        return step ? { step, entry: { tool: "mail.send" } } : undefined;
      },
    },
    "../mirror/index.js": options.mirrorThrow
      ? { mirrorSoon() { throw new Error("mock mirror boundary failed"); } }
      : mirror,
  }, {
    setInterval(callback, delay) {
      assert.equal(delay, 1000);
      const token = {};
      state.intervals.set(token, callback);
      return token;
    },
    clearInterval(token) { state.cleared.push(token); state.intervals.delete(token); },
  }).workorderTask;
  return {
    state, mirror,
    start: () => task.run({ woId: state.wo.id }),
    tick() { for (const callback of state.intervals.values()) callback(); },
    finish(status = "done") { state.wo = workOrder(status); state.run.resolve(structuredClone(state.wo)); },
    local: () => state.files.get("/memory-only/workorder.md"),
  };
}

// Bound failures in the test itself: a regression that awaits a stuck provider
// should produce a useful failure instead of hanging the verification script.
async function settles(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Task waited for optional remote projection")), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const checks = [];

{
  const h = harness();
  const running = h.start();
  h.state.failNextRead = true;
  assert.doesNotThrow(() => h.tick());
  assert.match(h.state.warnings[0], /mock SQLite read failed/);
  h.finish("waiting_human");
  const result = await settles(running);
  assert.equal(result.pendingStepId, "draft");
  assert.equal(h.state.intervals.size, 0);
  assert.equal(h.state.cleared.length, 1);
  assert.match(h.local(), /WAITING ON HUMAN/);
  assert.equal(h.state.remote.length, 1); // Still unresolved when the task returned.
  h.state.remote[0].resolve("mock-doc");
  await flush();
  checks.push("timer read failure is contained; approval becomes ready without waiting for the provider");
}

{
  const h = harness({ mirrorThrow: true });
  const running = h.start();
  assert.doesNotThrow(() => h.tick());
  h.finish();
  await settles(running);
  assert.equal(h.state.warnings.length, 2); // Poll and final refresh are both isolated.
  assert.equal(h.state.intervals.size, 0);
  checks.push("synchronous mirror boundary failure cannot crash polling or task completion");
}

{
  const h = harness();
  const running = h.start();
  h.tick();
  assert.match(h.local(), /RUNNING/);
  assert.equal(h.state.remote.length, 1);
  h.finish("waiting_human");
  await settles(running);
  assert.match(h.local(), /WAITING ON HUMAN/);
  assert.equal(h.state.remote.length, 1); // Final state is queued behind the old remote request.
  const writesAtCompletion = h.state.fileWrites;
  h.state.remote[0].resolve("mock-doc");
  await flush();
  assert.equal(h.state.remote.length, 2);
  assert.match(h.state.remote[1].body, /WAITING ON HUMAN/);
  assert.match(h.local(), /WAITING ON HUMAN/);
  // Only the document mapping was written by the old remote request, never workorder.md.
  assert.equal(h.state.fileWrites, writesAtCompletion + 1);
  h.state.remote[1].resolve("mock-doc");
  await flush();
  assert.match(h.local(), /WAITING ON HUMAN/);
  checks.push("final local snapshot bypasses a stuck remote request and cannot regress when it completes");
}

{
  const h = harness();
  const running = h.start();
  h.tick();
  h.state.remote[0].reject(new Error("mock document provider rejected"));
  await flush();
  assert.match(h.state.mirrorErrors[0], /mock document provider rejected/);
  h.finish();
  await settles(running);
  assert.equal(h.state.intervals.size, 0);
  assert.match(h.local(), /DONE: all 1 steps finished/);
  assert.equal(h.state.remote.length, 2);
  h.state.remote[1].reject(new Error("mock final projection rejected"));
  await flush();
  assert.match(h.state.mirrorErrors.at(-1), /mock final projection rejected/);
  checks.push("poll and final asynchronous provider rejections are contained");
}

{
  const h = harness();
  const running = h.start();
  h.tick();
  const failure = new Error("mock reversible operation failed");
  h.state.wo = workOrder("failed");
  h.state.run.reject(failure);
  await assert.rejects(settles(running), error => error === failure);
  assert.equal(h.state.intervals.size, 0);
  assert.equal(h.state.cleared.length, 1);
  assert.match(h.local(), /FAILED/);
  h.state.remote[0].resolve("mock-doc");
  await flush();
  h.state.remote[1].resolve("mock-doc");
  await flush();
  checks.push("failed reversible work clears its timer, preserves its error, and publishes a local final snapshot");
}

{
  const h = harness();
  const running = h.start();
  const failure = new Error("original core failure");
  h.state.failNextRead = true;
  h.state.run.reject(failure);
  await assert.rejects(settles(running), error => error === failure);
  assert.equal(h.state.intervals.size, 0);
  assert.match(h.state.warnings[0], /mock SQLite read failed/);
  checks.push("a failed final mirror read cannot replace the original task failure");
}

{
  const h = harness({ fileFailure: true });
  const running = h.start();
  h.finish();
  await settles(running);
  assert.match(h.state.mirrorErrors[0], /mock filesystem unavailable/);
  assert.equal(h.state.intervals.size, 0);
  h.state.remote[0].resolve("mock-doc");
  await flush();
  checks.push("local filesystem failures remain best effort and do not block task completion");
}

console.log(JSON.stringify({ mode: "offline-in-memory-boundaries", passed: checks.length, checks }, null, 2));
