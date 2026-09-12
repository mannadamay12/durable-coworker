// Tool registry: name -> tool. Commit tools live here and are never handed to a model.
import { COMMIT_TOOLS, type Step, type ToolFn, type WorkOrder } from "../core/contract.js";
import { CUSTOMER } from "../core/fixtures.js";
import { outboxTool } from "./outbox.js";

/** Long enough that a kill reliably lands mid-run on camera. */
const STEP_DELAY_MS = Number(process.env.STUB_DELAY_MS ?? 1500);
const pause = () => new Promise<void>((r) => setTimeout(r, STEP_DELAY_MS));

export interface ReversibleContext {
  wo: WorkOrder;
  step: Step;
}

type ReversibleTool = (ctx: ReversibleContext) => Promise<string>;

// Research is a hardcoded blob (PRD cut list: Exa).
const RESEARCH: Record<string, string> = {
  "1-gather-thread-context":
    `${CUSTOMER.name} lost shipment tracking for 3 hours this morning. ` +
    "They need a written update before their 17:00 ops review.",
  default:
    "Outage 09:12-12:04 UTC. Root cause: expired certificate on the tracking API gateway. " +
    "Fixed and monitored since 12:10. No data lost; events replayed by 12:40.",
};

const reversibleTools: Record<string, ReversibleTool> = {
  search: async ({ step }) => {
    await pause();
    return RESEARCH[step.id] ?? RESEARCH.default;
  },
  draft: async ({ wo }) => {
    await pause();
    return [
      `Hi Dana,`,
      ``,
      `Shipment tracking was unavailable from 09:12 to 12:04 UTC today. The cause was an ` +
        `expired certificate on our tracking gateway. It has been fixed, no data was lost, ` +
        `and all tracking events were replayed by 12:40.`,
      ``,
      `We are adding certificate expiry alerts so this cannot recur silently. I will send ` +
        `the full incident report before your ops review.`,
      ``,
      `Reference: ${wo.id}`,
    ].join("\n");
  },
  "tasks.create": async ({ wo }) => {
    await pause();
    return `Created 2 follow-ups on ${wo.id}: incident report due tomorrow, cert expiry alerting.`;
  },
  write_to_work_order: async ({ wo, step }) => {
    await pause();
    return `Recorded ${step.name.toLowerCase()} on ${wo.id}.`;
  },
};

/** Unknown reversible tools are recorded, not fatal: the planner may name tools we have not stubbed. */
export async function runReversibleTool(ctx: ReversibleContext): Promise<string> {
  const fn = ctx.step.tool ? reversibleTools[ctx.step.tool] : undefined;
  if (fn) return fn(ctx);
  await pause();
  return `No stub for tool "${ctx.step.tool ?? "none"}"; step recorded.`;
}

export const commitTools: Readonly<Record<string, ToolFn>> = Object.fromEntries(
  [...COMMIT_TOOLS].map((tool) => [tool, outboxTool(tool)]),
);
