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
  account:
    `${CUSTOMER.name}: ${CUSTOMER.person} (VP Ops, ${CUSTOMER.contact}) wants a written update ` +
    "before their exec review, out by 17:00 PT today. Finance: no credit or refund promises.",
  default:
    "INC-4471: webhook delivery down Sept 11 14:05-17:10 UTC. Root cause: expired TLS cert on the " +
    "webhook egress proxy in us-east-2. Cert rotated 17:10 UTC; 18,240 events replayed by 18:30 UTC.",
};

const reversibleTools: Record<string, ReversibleTool> = {
  search: async ({ step }) => {
    await pause();
    return /account|context|customer/.test(step.id) ? RESEARCH.account : RESEARCH.default;
  },
  draft: async ({ wo }) => {
    await pause();
    return [
      `Hi ${CUSTOMER.person.split(" ")[0]},`,
      ``,
      `Webhook delivery to ${CUSTOMER.name} was down on Sept 11 from 14:05 to 17:10 UTC (INC-4471). ` +
        `The cause was an expired TLS certificate on our webhook egress proxy. The certificate was ` +
        `rotated at 17:10 UTC and all 18,240 delayed shipment status events were replayed by 18:30 UTC.`,
      ``,
      `We are adding certificate expiry alerting so this cannot recur silently, and we will share ` +
        `the postmortem once it is final.`,
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
