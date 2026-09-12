// Exercise the bundled Trigger task from a directory containing no source dataset files.
// The installed SDK registers the real task; its scheduler is replaced by a local call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const sandbox = mkdtempSync(join(tmpdir(), "coworker-bundle-"));
try {
  symlinkSync(resolve(root, "node_modules"), join(sandbox, "node_modules"), "dir");
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, sourcefile: "bundle-probe.mjs", contents: `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { resourceCatalog } from "@trigger.dev/core/v3";
      const registered = new Map();
      resourceCatalog.setGlobalResourceCatalog({
        registerTaskMetadata(definition) { registered.set(definition.id, definition); },
        registerQueueMetadata() {},
      });
      globalThis.fetch = async () => { throw new Error("Network is forbidden in the bundle probe"); };
      await import("./src/trigger/workorder.ts");
      const core = await import("./src/core/index.ts");
      const { createFromThread } = await import("./src/core/recovery.ts");
      const { outboxRows } = await import("./src/core/inspect.ts");
      const task = registered.get("workorder");
      assert.equal(typeof task?.fns?.run, "function", "actual SDK task must register");
      const expected = {
        "THREAD-ACME-OUTAGE": "dana@acme-robotics.example",
        "THREAD-HELIX-SECURITY": "irina@helix-health.example",
        "THREAD-LANTERN-PRICING": "chris@lantern.example",
        "THREAD-ACME-REFUND": "owen@acme-robotics.example",
      };
      for (const [thread, to] of Object.entries(expected)) {
        const wo = createFromThread(thread);
        const done = await task.fns.run({ woId: wo.id });
        assert.equal(done.pendingStepId, "5-send-customer-update");
        const pending = core.pendingApproval(core.getWorkOrder(wo.id));
        assert.equal(pending.entry.args.to, to);
        assert.equal(pending.entry.status, "proposed");
        assert.ok(readFileSync(process.env.STATE_DIR + "/workorder.md", "utf8").includes(to));
      }
      const unsupported = createFromThread("THREAD-NORTHWIND-STATUS");
      assert.equal((await task.fns.run({ woId: unsupported.id })).pendingStepId, null);
      assert.equal(core.getWorkOrder(unsupported.id).commits.length, 0);
      assert.equal(core.getWorkOrder(unsupported.id).steps.at(-1).status, "failed");
      assert.equal(createFromThread("THREAD-EMPTY"), undefined);
      assert.equal(outboxRows().length, 0);
      console.log("PASS: bundled SDK task runs four grounded proposals, refuses unsupported/empty seeds, writes local mirrors; no sends");
    ` },
    outfile: join(sandbox, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node20", "es2022"], // Matches the installed Trigger 4.5.16 bundler.
    conditions: ["trigger.dev", "module", "node"],
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  for (const file of ["threads", "customers", "research_blobs", "tasks_seed", "work_order_fixtures", "users"]) {
    assert.ok(result.metafile.inputs[`datasets/${file}.json`], `${file} must be bundled`);
  }
  assert.equal(existsSync(join(sandbox, "datasets")), false);
  const run = spawnSync(process.execPath, [join(sandbox, "worker.mjs")], {
    cwd: sandbox,
    env: { ...process.env, STATE_DIR: join(sandbox, "state"), STUB_DELAY_MS: "0", MIRROR_MODE: "file" },
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
  console.log(run.stdout.trim().split("\n").at(-1));
  console.log("PASS: all six runtime JSON inputs embedded in emitted bundle; no source dataset directory needed");

  await build({ absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: join(sandbox, "cli.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
  const cliState = join(sandbox, "cli-state");
  const cliEnv = { ...process.env, STATE_DIR: cliState, STUB_DELAY_MS: "0", APPROVERS: "U_WRONG_DEFAULT" };
  const demo = spawnSync(process.execPath, [join(sandbox, "cli.mjs"), "demo", "--thread", "THREAD-LANTERN-PRICING"], {
    cwd: sandbox, env: cliEnv, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /as U_PRIYA: committed/);
  assert.match(demo.stdout, /ALREADY COMMITTED/);
  assert.equal(readFileSync(join(cliState, "outbox.jsonl"), "utf8").trim().split("\n").length, 1);
  const wrongThread = spawnSync(process.execPath, [join(sandbox, "cli.mjs"), "run", "--wo", "WO-THREAD-LANTERN-PRICING", "--thread", "THREAD-ACME-OUTAGE"], {
    cwd: sandbox, env: cliEnv, encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(wrongThread.status, 0);
  assert.match(wrongThread.stderr, /already belongs to THREAD-LANTERN-PRICING/);
  writeFileSync(join(cliState, "workorder.md"), "old mirror");
  const reset = spawnSync("npm", ["run", "reset"], { cwd: root, env: cliEnv, encoding: "utf8", timeout: 10_000 });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(existsSync(join(cliState, "outbox.jsonl")), false);
  assert.equal(existsSync(join(cliState, "workorder.md")), false);
  const show = spawnSync(process.execPath, [join(sandbox, "cli.mjs"), "show", "--thread", "THREAD-LANTERN-PRICING"], {
    cwd: sandbox, env: cliEnv, encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(show.status, 0);
  assert.match(show.stderr, /not found/);
  console.log("PASS: bundled CLI uses the selected approver, retry keeps one artifact, wrong-thread reuse fails, npm reset clears the configured absolute state");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
