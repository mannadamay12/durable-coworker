// Read-side helpers for the CLI and the kill test. Not part of the frozen API.
import { type Row, withDb } from "./db.js";

export { type OutboxRow, readOutbox as outboxRows } from "../tools/outbox.js";

/** One row per completed reversible tool execution; proves resume did not redo work. */
export function toolCalls(woId: string): { stepId: string; tool: string }[] {
  return withDb((db) =>
    (db.prepare("SELECT step_id, tool FROM tool_calls WHERE wo_id = ? ORDER BY seq").all(woId) as Row[]).map((r) => ({
      stepId: String(r.step_id),
      tool: String(r.tool),
    })),
  );
}

export function recordToolCall(woId: string, stepId: string, tool: string): void {
  withDb((db) =>
    db
      .prepare("INSERT INTO tool_calls (wo_id, step_id, tool, at) VALUES (?, ?, ?, ?)")
      .run(woId, stepId, tool, new Date().toISOString()),
  );
}
