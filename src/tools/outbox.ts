// Stubbed side effects. Commit tools append to state/outbox.jsonl; nothing leaves this machine.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import type { ToolFn } from "../core/contract.js";
import { STATE_DIR } from "../core/state.js";

export const OUTBOX_PATH = resolve(STATE_DIR, "outbox.jsonl");

/** Rides inside the artifact so reconciliation is an exact string match (D9). */
export const IDEMPOTENCY_MARKER = "X-Idempotency-Key:";

export interface OutboxRow {
  id: string;
  tool: string;
  body: string;
  sentAt: string;
}

export function readOutbox(): OutboxRow[] {
  if (!existsSync(OUTBOX_PATH)) return [];
  const rows: OutboxRow[] = [];
  for (const line of readFileSync(OUTBOX_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as OutboxRow);
    } catch {
      // A kill mid-append can leave a partial last line; it is not a send.
    }
  }
  return rows;
}

/** Finds a send that landed even if the ledger write after it did not. */
export function reconcile(idempotencyKey: string): OutboxRow | undefined {
  const marker = `${IDEMPOTENCY_MARKER} ${idempotencyKey}`;
  return readOutbox().find((row) => row.body.includes(marker));
}

export function clearOutbox(): void {
  rmSync(OUTBOX_PATH, { force: true });
}

export function outboxTool(tool: string): ToolFn {
  return async (raw) => {
    const { idempotencyKey, ...payload } = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const lines =
      tool === "mail.send"
        ? [`To: ${String(payload.to)}`, `Subject: ${String(payload.subject)}`, "", String(payload.body ?? "")]
        : [JSON.stringify(payload, null, 2)];
    if (typeof idempotencyKey === "string") lines.push("", `${IDEMPOTENCY_MARKER} ${idempotencyKey}`);
    const row: OutboxRow = {
      id: `${tool.replace(".", "_")}_${randomUUID().slice(0, 8)}`,
      tool,
      body: lines.join("\n"),
      sentAt: new Date().toISOString(),
    };
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(OUTBOX_PATH, `${JSON.stringify(row)}\n`, "utf8");
    return { id: row.id };
  };
}
