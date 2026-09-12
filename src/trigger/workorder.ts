import { logger, task } from "@trigger.dev/sdk";

import { getWorkOrder, pendingApproval, runReversible } from "../core/index.js";

/**
 * Runs a work order's reversible steps and stops at the first commit step.
 *
 * Never commits: the committer runs in the listener on an approver's click. Resume is
 * re-trigger with the same woId; finished steps are skipped from SQLite. No
 * idempotencyKey on trigger (D18), and pass `ttl: 0`.
 */
export const workorderTask = task({
  id: "workorder",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async (payload: { woId: string }) => {
    const { woId } = payload;
    if (!woId) throw new Error("payload.woId is required");

    const before = getWorkOrder(woId);
    logger.log(`[${woId}] start: ${before.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);

    const wo = await runReversible(woId);
    const pending = pendingApproval(wo);
    logger.log(
      pending
        ? `[${woId}] waiting on a human at ${pending.step.id} (${pending.entry.tool})`
        : `[${woId}] ended: ${wo.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`,
    );

    return {
      woId,
      steps: wo.steps.map((s) => ({ id: s.id, status: s.status })),
      pendingStepId: pending?.step.id ?? null,
    };
  },
});
