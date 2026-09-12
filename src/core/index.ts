// The API surface every other lane calls. Lane A replaces each `notImplemented()`.
// Signatures are part of the frozen contract: change a body, never a signature.
import type { CommitResult, LedgerEntry, Step, ToolFn, WorkOrder } from "./contract.js";

const notImplemented = (name: string): never => {
  throw new Error(`core.${name} not implemented yet (lane A)`);
};

/** Create a work order from a scenario fixture and persist it. Idempotent on id. */
export function createWorkOrder(args: {
  id?: string;
  scenario: string;
  threadRef: string;
  constraints?: string[];
  approvers: string[];
  steps?: Step[];
}): WorkOrder {
  void args;
  return notImplemented("createWorkOrder");
}

/** Read a work order. Throws if absent. */
export function getWorkOrder(woId: string): WorkOrder {
  void woId;
  return notImplemented("getWorkOrder");
}

/** Read a work order, or undefined when it does not exist yet. */
export function findWorkOrder(woId: string): WorkOrder | undefined {
  void woId;
  return notImplemented("findWorkOrder");
}

/** Persist a whole work order. Last write wins; callers hold no locks. */
export function putWorkOrder(wo: WorkOrder): void {
  void wo;
  notImplemented("putWorkOrder");
}

/** Deterministic key: `${woId}:${stepId}:${tool}:${sha256(args)}`. Pure. */
export function idempotencyKey(woId: string, stepId: string, tool: string, args: unknown): string {
  void woId; void stepId; void tool; void args;
  return notImplemented("idempotencyKey");
}

/**
 * Run every reversible step that is not already done, then stop at the first commit
 * step: write a `proposed` ledger entry and set the step to `waiting_human`.
 * Never performs a commit. Safe to call repeatedly; finished steps are skipped.
 */
export function runReversible(woId: string): Promise<WorkOrder> {
  void woId;
  return notImplemented("runReversible");
}

/** The step awaiting a human, if any. */
export function pendingApproval(wo: WorkOrder): { step: Step; entry: LedgerEntry } | undefined {
  void wo;
  return notImplemented("pendingApproval");
}

/** Mark a proposed entry approved by an allowlisted actor. Throws NotAuthorizedError. */
export function approve(woId: string, stepId: string, actor: string): WorkOrder {
  void woId; void stepId; void actor;
  return notImplemented("approve");
}

/** Deny: blocks the work order and records who stopped it. Throws NotAuthorizedError. */
export function deny(woId: string, stepId: string, actor: string): WorkOrder {
  void woId; void stepId; void actor;
  return notImplemented("deny");
}

/**
 * The committer. No model anywhere in this path (invariant 1).
 * Returns the existing receipt when already committed (invariant 4).
 * Only this function writes externalId (invariant 3).
 */
export function commit(woId: string, stepId: string, actor: string): Promise<CommitResult> {
  void woId; void stepId; void actor;
  return notImplemented("commit");
}

/** Tool registry. Commit tools live here and are never handed to a model. */
export function getTool(name: string): ToolFn {
  void name;
  return notImplemented("getTool");
}

/** Wipe SQLite and the outbox. Must work from the first hour (invariant 8). */
export function reset(): void {
  notImplemented("reset");
}

export * from "./contract.js";
