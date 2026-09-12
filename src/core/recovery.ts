// Recovery beats built by driving the engine, never by inserting ledger rows, so every
// key, status and outbox row is one the real code path would have produced.
import { constraintsFor, findThread, loadContext, recoveryFixtures, stepsFor } from "./context.js";
import { NotAuthorizedError } from "./contract.js";
import { type WorkOrder, approve, commit, createWorkOrder, deny, getTool, getWorkOrder, pendingApproval, runReversible } from "./index.js";

const log = (msg: string) => console.log(`[recovery] ${msg}`);

/** Refuses threads with no customer; returns undefined and creates nothing. */
export function createFromThread(threadId: string, opts: { id?: string; approvers?: string[] } = {}): WorkOrder | undefined {
  const ctx = loadContext(threadId);
  if (!ctx) {
    log(`refused ${threadId}: ${findThread(threadId) ? "no customer on the thread" : "unknown thread"}; no work order`);
    return undefined;
  }
  const approvers = opts.approvers ?? ctx.thread.approvers;
  if (approvers.length === 0) {
    log(`refused ${threadId}: no allowlisted approver; no work order`);
    return undefined;
  }
  return createWorkOrder({
    id: opts.id ?? `WO-${threadId}`,
    scenario: threadId,
    threadRef: threadId,
    constraints: constraintsFor(ctx),
    approvers,
    steps: stepsFor(ctx),
  });
}

export const RECOVERY_BEATS = [
  "fresh_start",
  "kill_before_approval",
  "retry_send_already_committed",
  "crash_between_provider_and_ledger",
  "injection_still_proposed",
  "deny_path",
] as const;
export type RecoveryBeat = (typeof RECOVERY_BEATS)[number];

async function toProposal(wo: WorkOrder) {
  const pending = pendingApproval(await runReversible(wo.id));
  if (!pending) throw new Error(`${wo.id} did not reach a proposal: ${getWorkOrder(wo.id).steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  return pending;
}

/** Drives a fresh work order to the named beat. Call on a reset ledger. */
export async function buildRecovery(beat: RecoveryBeat): Promise<WorkOrder> {
  const fixture = recoveryFixtures().find((f) => f.fixtureFor === beat);
  if (!fixture) throw new Error(`no fixture for ${beat}`);
  const wo = createFromThread(fixture.threadId, { id: fixture.id, approvers: fixture.approvers });
  if (!wo) throw new Error(`${fixture.threadId} cannot create a work order`);
  const approver = fixture.approvers[0];

  switch (beat) {
    case "fresh_start":
      break;
    case "kill_before_approval":
      await toProposal(wo);
      break;
    case "retry_send_already_committed": {
      const { step } = await toProposal(wo);
      await commit(wo.id, step.id, approver);
      break;
    }
    case "crash_between_provider_and_ledger": {
      // The provider accepted the send, then the process died before the ledger write.
      const { step, entry } = await toProposal(wo);
      approve(wo.id, step.id, approver);
      await getTool(entry.tool)({ ...(entry.args as object), idempotencyKey: entry.idempotencyKey });
      break;
    }
    case "injection_still_proposed": {
      const { step } = await toProposal(wo);
      try {
        approve(wo.id, step.id, "U_SAM");
      } catch (err) {
        if (!(err instanceof NotAuthorizedError)) throw err;
      }
      break;
    }
    case "deny_path": {
      const { step } = await toProposal(wo);
      deny(wo.id, step.id, approver);
      break;
    }
  }
  const built = getWorkOrder(wo.id);
  log(`${beat}: ${built.id} ${built.steps.map((s) => s.status).join(",")} ledger=${built.commits.map((c) => c.status).join(",") || "-"}`);
  return built;
}
