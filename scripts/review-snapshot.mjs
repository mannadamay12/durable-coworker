// Read-only projection for the review viewer. Never imports core or creates state.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function snapshot(stateDir) {
  const result = { capturedAt: new Date().toISOString(), stateDir: resolve(stateDir), workOrders: [], ledger: [], toolCalls: [], outbox: [], smoke: [], warnings: [] };
  const dbPath = resolve(stateDir, "durable.db");
  if (existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000; BEGIN");
      result.workOrders = db.prepare("SELECT body, updated_at FROM work_orders ORDER BY id").all().map(r => ({ ...JSON.parse(r.body), updatedAt: r.updated_at }));
      result.ledger = db.prepare("SELECT * FROM ledger ORDER BY created_at, idempotency_key").all().map(r => ({ ...r, args: JSON.parse(r.args) }));
      result.toolCalls = db.prepare("SELECT * FROM tool_calls ORDER BY seq").all();
      db.exec("COMMIT");
    } catch (error) {
      // Do not present partial SQL reads as a complete view.
      result.workOrders = []; result.ledger = []; result.toolCalls = [];
      result.warnings.push(`Database unavailable: ${error.message}`);
    } finally { db?.close(); }
  } else result.warnings.push("No work-order database yet.");
  const outboxPath = resolve(stateDir, "outbox.jsonl");
  if (existsSync(outboxPath)) {
    for (const [index, line] of readFileSync(outboxPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.id !== "string" || typeof row.body !== "string") throw new Error("invalid row");
        result.outbox.push(row);
      } catch { result.warnings.push(`Unreadable outbox line ${index + 1}; receipt count may be incomplete.`); }
    }
  }
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir).filter(n => /^[a-f0-9]{12}\.json$/.test(n))) {
      try { result.smoke.push(JSON.parse(readFileSync(resolve(stateDir, name), "utf8"))); }
      catch { result.warnings.push(`Unreadable smoke state: ${name}`); }
    }
  }
  return result;
}
