// Recovery beats built by driving the engine, never by inserting ledger rows, so every
// key, status and outbox row is one the real code path would have produced.
import { constraintsFor, datasetUsers, findThread, loadContext, recoveryFixtures, stepsFor } from "./context.js";
import { NotAuthorizedError, type ToolFn } from "./contract.js";
import { type WorkOrder, approve, commit, createWorkOrder, deny, getWorkOrder, pendingApproval, runReversible } from "./index.js";
import { commitTools } from "../tools/registry.js";

const log = (msg: string) => console.log(`[recovery] ${msg}`);

/** Refuses threads with no customer; returns undefined and creates nothing. */
export function createFromThread(threadId: string, opts: { id?: string; approvers?: string[]; threadRef?: string } = {}): WorkOrder | undefined {
  // findThread validates the source pack (including synthetic approvers) before a
  // caller can override them with explicitly mapped real Slack accounts.
  const thread = findThread(threadId);
  if (!thread?.customerId) {
    log(`refused ${threadId}: ${thread ? "no customer on the thread" : "unknown thread"}; no work order`);
    return undefined;
  }
  const ctx = loadContext(threadId)!;
  const approvers = opts.approvers ?? ctx.thread.approvers;
  if (approvers.length === 0) {
    log(`refused ${threadId}: no allowlisted approver; no work order`);
    return undefined;
  }
  const users = datasetUsers();
  if (new Set(approvers).size !== approvers.length || approvers.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`invalid approvers for ${threadId}: expected unique nonempty IDs`);
  }
  for (const id of approvers) {
    if (id.startsWith("U_") && !ctx.thread.approvers.includes(id)) {
      throw new Error(`invalid approver ${id} for ${threadId}: not on thread allowlist`);
    }
    if (id === "U_SAM" || users.find((u) => u.slackUserId === id)?.isAgent) {
      throw new Error(`${id} cannot approve`);
    }
  }
  return createWorkOrder({
    id: opts.id ?? `WO-${threadId}`,
    scenario: threadId,
    threadRef: opts.threadRef ?? threadId,
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
      // Simulate an accepted local send whose response is lost, through the real
      // committer. This records attemptedAt and outcome_unknown, so Deny cannot
      // pretend the accepted action was prevented. No real provider is called.
      const { step, entry } = await toProposal(wo);
      const registry = commitTools as Record<string, ToolFn>;
      const original = registry[entry.tool];
      registry[entry.tool] = async (args) => {
        const result = await original(args);
        if ((args as { idempotencyKey?: string }).idempotencyKey === entry.idempotencyKey) {
          throw new Error("demo fault: local outbox accepted the send but its response was lost");
        }
        return result;
      };
      try {
        const result = await commit(wo.id, step.id, approver);
        if (result.status !== "outcome_unknown") throw new Error(`expected lost-receipt outcome_unknown, got ${result.status}`);
      } finally {
        registry[entry.tool] = original;
      }
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
