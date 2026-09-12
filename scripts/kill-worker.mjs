#!/usr/bin/env node
/**
 * Kills ONLY the Trigger.dev dev worker (terminal B).
 *
 * CLAUDE.md invariant 6: the Channels listener owns the persistent Slack gateway
 * socket. Killing it makes the bot go silent and the demo reads as a crash
 * instead of a resume. The listener is excluded by pattern before any signal is
 * sent, and `--dry` exists so the match list can be checked before filming.
 *
 *   npm run kill            kill the worker
 *   npm run kill -- --dry   print what would be killed, signal nothing
 *
 * The detached Trigger.dev watchdog is left alive on purpose. When the dev CLI
 * dies the watchdog cancels the in-flight run within about a second, which is
 * the "interrupted" beat we want. Kill the watchdog too and recovery falls back
 * to a 5-minute heartbeat timeout instead.
 *
 * Note `devWatchdog.js` lives under .../dist/esm/dev/, so any pattern matching a
 * bare "dev" path segment hits it. The CLI pattern below requires `index.js dev`
 * with `dev` as the argument.
 */
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry");

/** Never signal a process whose command line matches any of these. */
const NEVER_KILL = [
  /src\/channel\/listener/i, // the Channels listener. Non-negotiable.
  /kill-worker/i, // this script
  /watchdog/i, // leave it alive so it cancels the run
];

/** A process is the worker if its command line matches any of these. */
const WORKER_PATTERNS = [
  /node_modules\/trigger\.dev\/dist\/\S*index\.js\s+dev(?:\s|$)/, // the dev CLI
  /node_modules\/\.bin\/trigger\s+dev(?:\s|$)/, // via the bin shim
  /\.trigger\/tmp\//, // per-run child task processes
];

const IS_LISTENER = /node\b[^\n]*src\/channel\/listener/;
const short = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

export function classify(cmd, root) {
  if (NEVER_KILL.some((re) => re.test(cmd))) return "PROTECTED";
  if (!WORKER_PATTERNS.some((re) => re.test(cmd))) return "ignore";
  // A dev worker for a different project on this machine is not ours to kill.
  if (root && !cmd.includes(root)) return "other-project";
  return "KILL";
}

function psLines() {
  for (const cmd of ["ps -axww -o pid=,command=", "ps -eww -o pid=,args="]) {
    try {
      return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* try the next form */
    }
  }
  throw new Error("could not list processes");
}

function main() {
  const root = process.cwd();
  const matches = [];
  const listeners = [];
  const elsewhere = [];

  for (const line of psLines()) {
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === process.pid || pid === process.ppid) continue;

    if (IS_LISTENER.test(cmd)) listeners.push({ pid, cmd });
    const verdict = classify(cmd, root);
    if (verdict === "KILL") matches.push({ pid, cmd });
    if (verdict === "other-project") elsewhere.push({ pid, cmd });
  }

  for (const l of listeners) console.log(`protected  ${l.pid}  Channels listener — not touched`);

  if (matches.length === 0) {
    console.log(`no Trigger.dev worker process found under ${root}`);
    for (const e of elsewhere) {
      console.log(`skipped    ${e.pid}  worker for another project — ${short(e.cmd)}`);
    }
    return;
  }

  for (const { pid, cmd } of matches) {
    if (DRY) {
      console.log(`would kill ${pid}  ${short(cmd)}`);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      console.log(`killed     ${pid}  ${short(cmd)}`);
    } catch (err) {
      console.log(`failed     ${pid}  ${err.code ?? err.message}`);
    }
  }

  console.log(
    DRY
      ? `\n${matches.length} process(es) matched. Nothing signalled.`
      : `\n${matches.length} worker process(es) killed. Listener untouched.`,
  );
}

if (!process.env.KILL_WORKER_IMPORT_ONLY) main();
