// Default customer-success work order (PRD section 2). Used when the caller supplies no
// planned steps, so core and the CLI work without the planner.
import { COMMIT_TOOLS, type Step, type WorkOrder } from "./contract.js";
import { type Context, draftFor, loadContext } from "./context.js";

function groundedArgs(ctx: Context, commitStep: Step, drafted: string | undefined): Record<string, unknown> {
  const tool = commitStep.tool ?? "";
  if (!COMMIT_TOOLS.has(tool)) throw new Error(`${tool} has no registered commit tool`);
  if (tool !== ctx.thread.commitTool) throw new Error(`commit tool differs from ${ctx.thread.id} source`);
  const draft = draftFor(ctx);
  if (draft instanceof Error) throw draft;
  if (!drafted) throw new Error("no draft recorded on the work order");
  // The dataset demo uses curated drafts. This is source-integrity validation,
  // not a general language-model checker for arbitrary natural-language constraints.
  if (drafted !== draft.body) throw new Error(`recorded draft differs from curated source for ${ctx.thread.id}`);
  if (tool === "mail.send") {
    if (draft.to !== ctx.thread.commitTarget) throw new Error(`recipient differs from ${ctx.thread.id} commitTarget`);
    if (!ctx.customer.contacts.some((c) => c.email === draft.to)) {
      throw new Error(`recipient ${draft.to} is not a contact of ${ctx.customer.name}`);
    }
    return { to: draft.to, subject: draft.subject, body: drafted };
  }
  return { target: ctx.thread.commitTarget, customer: ctx.customer.id, detail: drafted };
}

// Matches scenarios/customer-success.json, the thread the listener plans from.
export const CUSTOMER = { name: "Northwind Logistics", person: "Dana Okafor", contact: "dana.okafor@northwind.example" };

export const DEFAULT_CONSTRAINTS = ["Do not promise a credit"];

const step = (id: string, name: string, kind: Step["kind"], tool: string): Step => ({
  id,
  name,
  kind,
  tool,
  status: "pending",
  classifiedBy: "model",
});

export const DEFAULT_STEPS: readonly Step[] = [
  step("1-gather-thread-context", "Gather thread context", "reversible", "search"),
  step("2-research-outage", "Research the outage timeline", "reversible", "search"),
  step("3-draft-customer-update", "Draft the customer update", "reversible", "draft"),
  step("4-create-follow-up-tasks", "Create follow-up tasks", "reversible", "tasks.create"),
  step("5-send-customer-update", "Send the customer update", "commit", "mail.send"),
];

/**
 * Fixed at proposal time, so the approver approves exactly what the committer sends.
 * Throws when a grounded payload cannot be built; the caller fails the step instead of proposing.
 */
export function commitArgs(wo: WorkOrder, commitStep: Step): Record<string, unknown> {
  const drafted = [...wo.steps].reverse().find((s) => s.tool === "draft" && s.output)?.output;
  const ctx = loadContext(wo.scenario);
  if (ctx) return groundedArgs(ctx, commitStep, drafted);
  if (commitStep.tool === "mail.send") {
    return {
      to: CUSTOMER.contact,
      subject: `Update on today's outage (${wo.id})`,
      body: drafted ?? "(no draft recorded)",
    };
  }
  return { workOrder: wo.id, step: commitStep.id, detail: drafted ?? commitStep.name };
}
