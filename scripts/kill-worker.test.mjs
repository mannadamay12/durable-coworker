// One assertion script for the one thing that matters: what the kill script
// will and will not signal. Run: node scripts/kill-worker.test.mjs
process.env.KILL_WORKER_IMPORT_ONLY = "1";
const { classify } = await import("./kill-worker.mjs");

const ROOT = "/Users/ad12/Documents/Develop/durable-coworker";
const cases = [
  ["KILL", `node ${ROOT}/node_modules/trigger.dev/dist/esm/index.js dev`],
  ["KILL", `node ${ROOT}/node_modules/trigger.dev/dist/esm/index.js dev --log-level debug`],
  ["KILL", `node ${ROOT}/node_modules/.bin/trigger dev`],
  ["KILL", `node ${ROOT}/.trigger/tmp/build-abc123/worker.js`],
  ["PROTECTED", `node --env-file=.env --import tsx ${ROOT}/src/channel/listener.tsx`],
  ["PROTECTED", `node ${ROOT}/node_modules/trigger.dev/dist/esm/dev/devWatchdog.js 54321`],
  ["PROTECTED", "node scripts/kill-worker.mjs"],
  ["PROTECTED", "node scripts/kill-worker.mjs --dry"],
  ["ignore", "npm run dev:worker"],
  ["ignore", "sh -c trigger dev"],
  ["ignore", "/usr/bin/ssh-agent -l"],
  ["ignore", `node ${ROOT}/node_modules/trigger.dev/dist/esm/index.js deploy`],
  ["other-project", "node /Users/ad12/other-project/node_modules/trigger.dev/dist/esm/index.js dev"],
];

let fail = 0;
for (const [want, cmd] of cases) {
  const got = classify(cmd, ROOT);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "pass" : "FAIL"}  want=${want.padEnd(9)} got=${got.padEnd(9)} ${cmd.slice(-76)}`);
}
console.log(fail === 0 ? "\nall pass" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
