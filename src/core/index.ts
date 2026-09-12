// The API surface every other lane calls. Lane A replaces each `notImplemented()`.
// Signatures are part of the frozen contract: change a body, never a signature.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { clearOutbox, reconcile } from "../tools/outbox.js";
import { commitTools, runReversibleTool } from "../tools/registry.js";
import type { CommitResult, LedgerEntry, LedgerStatus, Step, ToolFn, WorkOrder } from "./contract.js";
import { COMMIT_TOOLS, NotApprovedError, NotAuthorizedError } from "./contract.js";
import { type Row, tx, withDb } from "./db.js";
import { DEFAULT_CONSTRAINTS, DEFAULT_STEPS, commitArgs } from "./fixtures.js";
import { recordToolCall } from "./inspect.js";

/** An attempt older than this with no outbox match may be retried (at-least-once, not exactly-once). */
const STALE_ATTEMPT_MS = 30_000;

const log = (msg: string) => console.log(`[core ${new Date().toISOString()}] ${msg}`);
const now = () => new Date().toISOString();
const optional = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

/** Key order must not change the hash, or a re-derived key would miss its own ledger row. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function toEntry(r: Row): LedgerEntry {
  return {
    idempotencyKey: String(r.idempotency_key),
    tool: String(r.tool),
    args: JSON.parse(String(r.args)),
    status: String(r.status) as LedgerStatus,
    approvedBy: optional(r.approved_by),
    externalId: optional(r.external_id),
    attemptedAt: optional(r.attempted_at),
    committedAt: optional(r.committed_at),
  };
}

function readWorkOrder(db: DatabaseSync, woId: string): WorkOrder | undefined {
  const row = db.prepare("SELECT body FROM work_orders WHERE id = ?").get(woId) as Row | undefined;
  if (!row) return undefined;
  const body = JSON.parse(String(row.body)) as Omit<WorkOrder, "commits">;
  const commits = (
    db.prepare("SELECT * FROM ledger WHERE wo_id = ? ORDER BY created_at, idempotency_key").all(woId) as Row[]
  ).map(toEntry);
  return { ...body, commits };
}

/** `commits` is dropped here: ledger rows are written only by core, externalId only by the committer. */
function writeWorkOrder(db: DatabaseSync, wo: WorkOrder): void {
  const { commits: _ledgerIsNotWrittenHere, ...body } = wo;
  db.prepare(
    "INSERT INTO work_orders (id, body, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).run(wo.id, JSON.stringify(body), now());
}

/** Invariant 2: the model's classification never grants a commit tool reversible status. */
function enforceCommitTools(woId: string, steps: readonly Step[]): Step[] {
  return steps.map((s) => {
    if (!s.tool || !COMMIT_TOOLS.has(s.tool) || s.kind === "commit") return { ...s };
    log(`OVERRIDE ${woId}: step "${s.id}" uses ${s.tool}, model said "${s.kind}", forced to "commit"`);
    return { ...s, kind: "commit", classifiedBy: "allowlist_override" };
  });
}

function isCommitStep(step: Step): boolean {
  return step.kind === "commit" || (step.tool !== undefined && COMMIT_TOOLS.has(step.tool));
}

function entryFor(wo: WorkOrder, stepId: string): LedgerEntry | undefined {
  const prefix = `${wo.id}:${stepId}:`;
  return wo.commits.find((e) => e.idempotencyKey.startsWith(prefix));
}

function updateStep(woId: string, stepId: string, patch: Partial<Step>): WorkOrder {
  return withDb((db) =>
    tx(db, () => {
      const wo = readWorkOrder(db, woId);
      if (!wo) throw new Error(`work order ${woId} not found`);
      wo.steps = wo.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
      writeWorkOrder(db, wo);
      return wo;
    }),
  );
}

function authorize(wo: WorkOrder, actor: string): void {
  if (!wo.approvers.includes(actor)) {
    log(`REJECTED ${actor} on ${wo.id}: not an approver (approvers: ${wo.approvers.join(", ")})`);
    throw new NotAuthorizedError(actor, wo.approvers);
  }
}

/** Create a work order from a scenario fixture and persist it. Idempotent on id. */
export function createWorkOrder(args: {
  id?: string;
  scenario: string;
  threadRef: string;
  constraints?: string[];
  approvers: string[];
  steps?: Step[];
}): WorkOrder {
  const id = args.id ?? `WO-${args.threadRef}`;
  return withDb((db) =>
    tx(db, () => {
      const existing = readWorkOrder(db, id);
      if (existing) return existing;
      const wo: WorkOrder = {
        id,
        scenario: args.scenario,
        threadRef: args.threadRef,
        constraints: [...(args.constraints ?? DEFAULT_CONSTRAINTS)],
        approvers: [...args.approvers],
        steps: enforceCommitTools(id, args.steps ?? DEFAULT_STEPS),
        commits: [],
      };
      writeWorkOrder(db, wo);
      log(`created ${id} (${wo.steps.length} steps, approvers: ${wo.approvers.join(", ")})`);
      return wo;
    }),
  );
}

/** Read a work order. Throws if absent. */
export function getWorkOrder(woId: string): WorkOrder {
  const wo = findWorkOrder(woId);
  if (!wo) throw new Error(`work order ${woId} not found`);
  return wo;
}

/** Read a work order, or undefined when it does not exist yet. */
export function findWorkOrder(woId: string): WorkOrder | undefined {
  return withDb((db) => readWorkOrder(db, woId));
}

/** Persist a whole work order. Last write wins; callers hold no locks. */
export function putWorkOrder(wo: WorkOrder): void {
  withDb((db) => writeWorkOrder(db, { ...wo, steps: enforceCommitTools(wo.id, wo.steps) }));
}

/** Deterministic key: `${woId}:${stepId}:${tool}:${sha256(args)}`. Pure. */
export function idempotencyKey(woId: string, stepId: string, tool: string, args: unknown): string {
  return `${woId}:${stepId}:${tool}:${createHash("sha256").update(stableJson(args)).digest("hex")}`;
}

/** Returns true when the step's ledger entry is already committed and the step caught up. */
function proposeCommit(wo: WorkOrder, step: Step): boolean {
  const tool = step.tool;
  if (!tool) {
    updateStep(wo.id, step.id, { status: "failed", output: "commit step has no tool" });
    log(`${wo.id} step ${step.id} FAILED: commit step has no tool`);
    return false;
  }
  const existing = entryFor(wo, step.id);
  if (existing?.status === "committed") {
    updateStep(wo.id, step.id, { status: "committed" });
    return true;
  }
  if (existing?.status === "rejected") {
    updateStep(wo.id, step.id, { status: "rejected" });
    return false;
  }
  if (!existing) {
    const args = commitArgs(wo, step);
    const key = idempotencyKey(wo.id, step.id, tool, args);
    withDb((db) =>
      db
        .prepare(
          "INSERT INTO ledger (idempotency_key, wo_id, step_id, tool, args, status, created_at) " +
            "VALUES (?, ?, ?, ?, ?, 'proposed', ?) ON CONFLICT DO NOTHING",
        )
        .run(key, wo.id, step.id, tool, JSON.stringify(args), now()),
    );
    log(`${wo.id} PROPOSED ${tool} at ${step.id}; waiting on ${wo.approvers.join(", ")}`);
  }
  if (step.status !== "waiting_human") updateStep(wo.id, step.id, { status: "waiting_human" });
  return false;
}

/**
 * Run every reversible step that is not already done, then stop at the first commit
 * step: write a `proposed` ledger entry and set the step to `waiting_human`.
 * Never performs a commit. Safe to call repeatedly; finished steps are skipped.
 */
export async function runReversible(woId: string): Promise<WorkOrder> {
  const initial = getWorkOrder(woId);
  const finished = initial.steps.filter((s) => s.status === "done" || s.status === "committed");
  log(
    finished.length
      ? `${woId} RESUME: skipping ${finished.map((s) => s.id).join(", ")}`
      : `${woId} FRESH: nothing recorded yet`,
  );

  for (;;) {
    const wo = getWorkOrder(woId);
    const step = wo.steps.find((s) => s.status !== "done" && s.status !== "committed");
    if (!step) {
      log(`${woId} all steps finished`);
      return wo;
    }
    if (step.status === "rejected" || step.status === "blocked" || step.status === "failed") {
      log(`${woId} stopped at ${step.id} (${step.status})`);
      return wo;
    }
    if (isCommitStep(step)) {
      if (proposeCommit(wo, step)) continue;
      return getWorkOrder(woId);
    }

    log(
      step.status === "running"
        ? `${woId} step ${step.id} was interrupted mid-run; re-running (reversible)`
        : `${woId} step ${step.id} RUNNING (${step.tool ?? "no tool"})`,
    );
    updateStep(woId, step.id, { status: "running" });
    try {
      const output = await runReversibleTool({ wo, step });
      recordToolCall(woId, step.id, step.tool ?? "none");
      updateStep(woId, step.id, { status: "done", output });
      log(`${woId} step ${step.id} DONE`);
    } catch (err) {
      updateStep(woId, step.id, { status: "failed", output: (err as Error).message });
      log(`${woId} step ${step.id} FAILED: ${(err as Error).message}`);
      return getWorkOrder(woId);
    }
  }
}

/** The step awaiting a human, if any. */
export function pendingApproval(wo: WorkOrder): { step: Step; entry: LedgerEntry } | undefined {
  const step = wo.steps.find((s) => s.status === "waiting_human");
  if (!step) return undefined;
  const entry = entryFor(wo, step.id);
  if (!entry || (entry.status !== "proposed" && entry.status !== "approved")) return undefined;
  return { step, entry };
}

/** Mark a proposed entry approved by an allowlisted actor. Throws NotAuthorizedError. */
export function approve(woId: string, stepId: string, actor: string): WorkOrder {
  const wo = getWorkOrder(woId);
  authorize(wo, actor);
  const entry = entryFor(wo, stepId);
  if (!entry || entry.status === "rejected" || entry.status === "failed") throw new NotApprovedError();
  withDb((db) =>
    db
      .prepare("UPDATE ledger SET status = 'approved', approved_by = ? WHERE idempotency_key = ? AND status = 'proposed'")
      .run(actor, entry.idempotencyKey),
  );
  log(`${woId} APPROVED ${stepId} by ${actor}`);
  return getWorkOrder(woId);
}

/** Deny: blocks the work order and records who stopped it. Throws NotAuthorizedError. */
export function deny(woId: string, stepId: string, actor: string): WorkOrder {
  const wo = getWorkOrder(woId);
  authorize(wo, actor);
  const entry = entryFor(wo, stepId);
  if (!wo.steps.some((s) => s.id === stepId)) throw new Error(`${woId} has no step ${stepId}`);
  return withDb((db) =>
    tx(db, () => {
      if (entry) {
        // Re-read under the lock: a commit may have claimed the send since `wo` was read.
        const row = db
          .prepare("SELECT status, attempted_at FROM ledger WHERE idempotency_key = ?")
          .get(entry.idempotencyKey) as Row | undefined;
        if (row && (row.status === "committed" || row.attempted_at !== null)) {
          throw new Error(`${stepId} is already committed or being sent; it cannot be denied`);
        }
        db.prepare(
          "UPDATE ledger SET status = 'rejected', approved_by = ? WHERE idempotency_key = ? AND status IN ('proposed', 'approved')",
        ).run(actor, entry.idempotencyKey);
      }
      const current = readWorkOrder(db, woId) ?? wo;
      const at = current.steps.findIndex((s) => s.id === stepId);
      current.steps = current.steps.map((s, i) => {
        if (i === at) return { ...s, status: "rejected" };
        if (i > at && s.status !== "done" && s.status !== "committed") return { ...s, status: "blocked" };
        return s;
      });
      writeWorkOrder(db, current);
      log(`Stopped by ${actor}. ${woId} blocked at ${stepId}.`);
      return readWorkOrder(db, woId) ?? current;
    }),
  );
}

function markCommitted(woId: string, stepId: string, key: string, externalId: string): void {
  withDb((db) =>
    tx(db, () => {
      db.prepare(
        "UPDATE ledger SET status = 'committed', external_id = ?, committed_at = ? WHERE idempotency_key = ? AND status != 'committed'",
      ).run(externalId, now(), key);
      const wo = readWorkOrder(db, woId);
      if (!wo) return;
      wo.steps = wo.steps.map((s) => (s.id === stepId ? { ...s, status: "committed" } : s));
      writeWorkOrder(db, wo);
    }),
  );
}

/**
 * The committer. No model anywhere in this path (invariant 1).
 * Returns the existing receipt when already committed (invariant 4).
 * Only this function writes externalId (invariant 3).
 */
export async function commit(woId: string, stepId: string, actor: string): Promise<CommitResult> {
  const wo = getWorkOrder(woId);
  const entry = entryFor(wo, stepId);
  if (!entry) throw new NotApprovedError();
  const key = entry.idempotencyKey;

  if (entry.status === "committed") {
    log(`${woId} RETRY of committed ${stepId} by ${actor}: returning receipt ${entry.externalId}, nothing sent`);
    return { reused: true, status: "committed", externalId: entry.externalId, idempotencyKey: key };
  }
  authorize(wo, actor);
  if (entry.status === "rejected" || entry.status === "failed") throw new NotApprovedError();

  // An approver clicking Approve is the approval, so a proposed entry is approved here.
  // The attempt claim is atomic: two concurrent clicks cannot both reach the tool.
  const staleBefore = new Date(Date.now() - STALE_ATTEMPT_MS).toISOString();
  const claimed = withDb((db) =>
    tx(db, () => {
      db.prepare(
        "UPDATE ledger SET status = 'approved', approved_by = ? WHERE idempotency_key = ? AND status = 'proposed'",
      ).run(actor, key);
      const res = db
        .prepare(
          "UPDATE ledger SET attempted_at = ? WHERE idempotency_key = ? AND status IN ('approved', 'outcome_unknown') " +
            "AND (attempted_at IS NULL OR attempted_at < ?)",
        )
        .run(now(), key, staleBefore);
      return Number(res.changes) === 1;
    }),
  );

  // Reconcile before acting: the side effect may have landed before the ledger write did.
  const landed = reconcile(key);
  if (landed) {
    const externalId = landed.id;
    markCommitted(woId, stepId, key, externalId);
    log(`${woId} RECONCILED ${stepId}: found ${externalId} in outbox by idempotency key, nothing sent`);
    return { reused: true, status: "committed", externalId, idempotencyKey: key };
  }

  if (!claimed) {
    const current = entryFor(getWorkOrder(woId), stepId);
    if (current?.status === "committed") {
      return { reused: true, status: "committed", externalId: current.externalId, idempotencyKey: key };
    }
    log(`${woId} ${stepId} commit already in flight; not sending again`);
    return { reused: false, status: current?.status ?? entry.status, idempotencyKey: key };
  }

  const tool = commitTools[entry.tool];
  if (!tool) throw new Error(`no commit tool registered for ${entry.tool}`);
  log(`${woId} COMMITTING ${entry.tool} at ${stepId}, approved by ${actor}`);
  let externalId: string | undefined;
  try {
    externalId = (await tool({ ...(entry.args as Record<string, unknown>), idempotencyKey: key })).id;
  } catch (err) {
    log(`${woId} ${stepId} tool threw: ${(err as Error).message}`);
  }
  if (!externalId) {
    withDb((db) =>
      db.prepare("UPDATE ledger SET status = 'outcome_unknown' WHERE idempotency_key = ?").run(key),
    );
    log(`${woId} ${stepId} OUTCOME UNKNOWN: no id returned; reconcile before retrying`);
    return { reused: false, status: "outcome_unknown", idempotencyKey: key };
  }
  markCommitted(woId, stepId, key, externalId);
  log(`${woId} COMMITTED ${stepId}: externalId ${externalId}`);
  return { reused: false, status: "committed", externalId, idempotencyKey: key };
}

/** Tool registry. Commit tools live here and are never handed to a model. */
export function getTool(name: string): ToolFn {
  const tool = commitTools[name];
  if (!tool) throw new Error(`unknown tool "${name}" (registered: ${Object.keys(commitTools).join(", ")})`);
  return tool;
}

/** Wipe SQLite and the outbox. Must work from the first hour (invariant 8). */
export function reset(): void {
  withDb((db) =>
    db.exec("DELETE FROM work_orders; DELETE FROM ledger; DELETE FROM tool_calls;"),
  );
  clearOutbox();
  log("reset: work orders, ledger, outbox cleared");
}

export * from "./contract.js";
