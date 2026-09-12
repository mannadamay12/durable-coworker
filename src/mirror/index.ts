// Camera mirror of a work order (D5). SQLite is truth; nothing here is ever read back to
// decide state, and nothing here throws into the caller.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkOrder } from "../core/contract.js";
import { STATE_DIR } from "../core/state.js";
import { ambiguousConfigured, upsertDoc } from "./ambiguous.js";
import { renderWorkOrder } from "./render.js";

export { renderWorkOrder } from "./render.js";

const FILE_PATH = resolve(STATE_DIR, "workorder.md");
const DOC_MAP_PATH = resolve(STATE_DIR, "mirror-docs.json");

const lastSent = new Map<string, string>();
const pending = new Map<string, WorkOrder>();
const inflight = new Map<string, Promise<void>>();

function log(message: string): void {
  console.error(`[mirror] ${message}`);
}

function shortReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

// Read fresh on every call: a killed-and-resumed process may have written it.
function readDocMap(): Record<string, string> {
  try {
    if (!existsSync(DOC_MAP_PATH)) return {};
    const parsed = JSON.parse(readFileSync(DOC_MAP_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function mirrorOnce(wo: WorkOrder): Promise<void> {
  const body = renderWorkOrder(wo);

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeAtomic(FILE_PATH, `${body}\nLast mirrored: ${new Date().toISOString()}\n`);
  } catch (err) {
    log(`file write failed for ${wo.id} (${shortReason(err)})`);
  }

  if (process.env.MIRROR_MODE === "file" || !ambiguousConfigured()) return;
  if (lastSent.get(wo.id) === body) return;

  try {
    const existing = readDocMap()[wo.id];
    const docId = await upsertDoc(existing, `Work order ${wo.id}: ${wo.scenario}`, body);
    if (docId && docId !== existing) {
      writeAtomic(DOC_MAP_PATH, `${JSON.stringify({ ...readDocMap(), [wo.id]: docId }, null, 2)}\n`);
    }
    lastSent.set(wo.id, body);
  } catch (err) {
    log(`ambiguous update failed for ${wo.id} (${shortReason(err)}); state/workorder.md is current`);
  }
}

// One upsert per work order at a time, so a slow first call cannot race a second into
// creating a duplicate doc. Newer states arriving meanwhile collapse into the latest one.
async function drain(woId: string): Promise<void> {
  try {
    for (let wo = pending.get(woId); wo; wo = pending.get(woId)) {
      pending.delete(woId);
      await mirrorOnce(wo);
    }
  } finally {
    // Synchronous with the empty check above, so no caller can enqueue unseen.
    inflight.delete(woId);
  }
}

export async function mirror(wo: WorkOrder): Promise<void> {
  try {
    pending.set(wo.id, wo);
    let run = inflight.get(wo.id);
    if (!run) {
      run = drain(wo.id);
      inflight.set(wo.id, run);
    }
    await run;
  } catch (err) {
    log(`unexpected failure for ${wo?.id} (${shortReason(err)})`);
  }
}

/** Fire-and-forget. Commit paths must use this, never an awaited mirror(). */
export function mirrorSoon(wo: WorkOrder): void {
  void mirror(wo);
}
