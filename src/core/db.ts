// SQLite is truth (D5). Built-in node:sqlite: no native build step, no extra dependency.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { STATE_DIR } from "./state.js";

export const DB_PATH = resolve(STATE_DIR, "durable.db");

export type Row = Record<string, unknown>;

// UNIQUE (wo_id, step_id): one proposal per commit step, even if two runners race or a
// re-drafted body would hash to a different idempotency key.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  idempotency_key TEXT PRIMARY KEY,
  wo_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  external_id TEXT,
  attempted_at TEXT,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (wo_id, step_id)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

/**
 * Open, use, close. Never hold a handle: `npm run reset` deletes state/, and a process
 * holding the old file open would keep writing to a deleted inode while the other
 * process creates a new one.
 */
export function withDb<T>(fn: (db: DatabaseSync) => T): T {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return fn(db);
  } finally {
    db.close();
  }
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
