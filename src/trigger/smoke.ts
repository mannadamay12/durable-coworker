import { logger, task } from "@trigger.dev/sdk";
import { TOTAL_STEPS, appendStep, readState, statePath } from "../core/state.js";

/**
 * Five numbered steps, one second apart, each appended to state/<runId>.json.
 *
 * Resume is re-trigger: Trigger.dev has no custom run id and `run()` always
 * starts from the top, so the progress file is the only thing that makes a
 * second run skip finished work.
 *
 * Plain setTimeout, not wait.for() — a waitpoint would put the run in WAITING
 * and we want it visibly EXECUTING when the worker gets killed.
 */
export const smokeTask = task({
  id: "smoke",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async (payload: { runId: string }) => {
    const { runId } = payload;
    if (!runId) throw new Error("payload.runId is required");

    // Read once, before any work. This snapshot is what we skip against.
    const before = readState(runId);
    const done = new Set(before.steps);

    logger.log(`[${runId}] state file ${statePath(runId)}`);
    logger.log(
      done.size > 0
        ? `[${runId}] RESUMING — already recorded: ${[...done].join(", ")}`
        : `[${runId}] FRESH START — nothing recorded yet`,
    );

    for (let step = 1; step <= TOTAL_STEPS; step++) {
      if (done.has(step)) {
        logger.log(`[${runId}] step ${step}/${TOTAL_STEPS} SKIPPED (already recorded)`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 1000));
      const after = appendStep(runId, step);
      logger.log(`[${runId}] step ${step}/${TOTAL_STEPS} DONE -> [${after.steps.join(", ")}]`);
    }

    const final = readState(runId);
    logger.log(`[${runId}] finished — recorded: [${final.steps.join(", ")}]`);
    return {
      runId,
      steps: final.steps,
      skipped: [...done],
      complete: final.steps.length === TOTAL_STEPS,
    };
  },
});
