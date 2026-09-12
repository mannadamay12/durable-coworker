// Pure-ish progress file. Imports nothing from Slack, Trigger.dev, or OpenAI
// (CLAUDE.md invariant 7). Node stdlib only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TOTAL_STEPS = 5;

/**
 * Both processes must agree on one absolute directory. The Trigger.dev dev CLI
 * spawns each run in a child process whose cwd is not guaranteed, so STATE_DIR
 * is set explicitly in .env and cwd is only a fallback.
 */
export const STATE_DIR = resolve(process.env.STATE_DIR ?? resolve(process.cwd(), "state"));

/**
 * Stable run id for a Slack thread.
 *
 * CopilotKit Channels does not expose Slack's `thread_ts` (ReplyTarget is
 * deliberately opaque). `thread.conversationKey` is the documented stable
 * per-conversation key, so it is the thread identity we hash. Same thread =>
 * same runId across restarts, which is what the resume test needs.
 */
export function runIdFromThreadKey(conversationKey: string): string {
  return createHash("sha256").update(conversationKey).digest("hex").slice(0, 12);
}

export interface SmokeState {
  runId: string;
  steps: number[];
  updatedAt: string;
}

export function statePath(runId: string): string {
  return resolve(STATE_DIR, `${runId}.json`);
}

export function readState(runId: string): SmokeState {
  const path = statePath(runId);
  if (!existsSync(path)) return { runId, steps: [], updatedAt: "" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SmokeState>;
    const steps = Array.isArray(parsed.steps) ? parsed.steps.filter((n) => typeof n === "number") : [];
    return { runId, steps, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    // A half-written file must not wedge the demo.
    return { runId, steps: [], updatedAt: "" };
  }
}

export function appendStep(runId: string, step: number): SmokeState {
  const next = readState(runId);
  if (!next.steps.includes(step)) next.steps.push(step);
  next.steps.sort((a, b) => a - b);
  next.updatedAt = new Date().toISOString();
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(runId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
