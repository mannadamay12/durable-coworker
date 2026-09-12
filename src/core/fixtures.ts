// Default customer-success work order (PRD section 2). Used when the caller supplies no
// planned steps, so core and the CLI work without the planner.
import type { Step, WorkOrder } from "./contract.js";

export const CUSTOMER = { name: "Northwind Freight", contact: "dana@northwind.example" };

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

/** Fixed at proposal time, so the approver approves exactly what the committer sends. */
export function commitArgs(wo: WorkOrder, commitStep: Step): Record<string, unknown> {
  const drafted = [...wo.steps].reverse().find((s) => s.tool === "draft" && s.output)?.output;
  if (commitStep.tool === "mail.send") {
    return {
      to: CUSTOMER.contact,
      subject: `Update on today's outage (${wo.id})`,
      body: drafted ?? "(no draft recorded)",
    };
  }
  return { workOrder: wo.id, step: commitStep.id, detail: drafted ?? commitStep.name };
}
