// One local gate with complete per-check logs and a source fingerprint. Never loads .env.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "state"), { recursive: true });
const evidence = mkdtempSync(resolve(root, "state/verification-"));
function fingerprint() {
  const files = ["package.json", "package-lock.json", "trigger.config.ts", "tsconfig.json"];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".md")) files.push(path);
    }
  };
  for (const dir of ["src", "scripts", "datasets", "scenarios"]) walk(dir);
  return Object.fromEntries(files.sort().map(file => [file, createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex")]));
}
const source = fingerprint();
const checks = [
  ["typecheck", ["node_modules/typescript/bin/tsc", "--noEmit"]],
  ["kill-matcher", ["scripts/kill-worker.test.mjs"]],
  ["core-kill-resume", ["--import", "tsx", "src/core/kill.test.ts"]],
  ["dataset-scenarios", ["--import", "tsx", "src/core/scenarios.test.ts"]],
  ["bundled-worker", ["scripts/dataset-bundle.test.mjs"]],
  ["planner-fixture", ["src/agent/plan.test.mjs"]],
  ["receipt-races", ["--import", "tsx", "scripts/recovery-core.test.mjs"]],
  ["planner-validation", ["scripts/recovery-planner.test.mjs"]],
  ["mirror-isolation", ["scripts/recovery-mirror.test.mjs"]],
  ["slack-handlers", ["--import", "tsx", "scripts/review-channel.mjs"]],
  ["evidence-replay", ["scripts/review-demo.mjs"]],
];
const results = [];
for (const [name, args] of checks) {
  const started = Date.now();
  const env = { ...process.env, PLANNER_MODE: "stub", MIRROR_MODE: "file" };
  for (const key of Object.keys(env)) {
    if (/API_KEY|SECRET|TOKEN/.test(key)) delete env[key];
  }
  let output = "";
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 60_000);
  const code = await new Promise(resolve => {
    child.on("error", err => { output += String(err); resolve(-1); });
    child.on("close", resolve);
  });
  clearTimeout(timer);
  writeFileSync(resolve(evidence, `${name}.log`), output);
  const result = { name, passed: code === 0 && !timedOut, code, timedOut, durationMs: Date.now() - started };
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${name} (${result.durationMs}ms)`);
  if (!result.passed) console.log(output.slice(-6000));
}
const stableSource = JSON.stringify(source) === JSON.stringify(fingerprint());
writeFileSync(resolve(evidence, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), runtime: process.version, stableSource, source, results }, null, 2) + "\n");
console.log(`Evidence: ${evidence}/report.json`);
if (!stableSource) console.error("Source changed during verification; rerun the gate after edits finish.");
if (!stableSource || results.some(result => !result.passed)) process.exitCode = 1;
