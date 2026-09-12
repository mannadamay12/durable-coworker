import type { LedgerEntry, Step, StepStatus, WorkOrder } from "../core/contract.js";

const STATUS_WORDS: Record<StepStatus, string> = {
  pending: "PENDING",
  running: "RUNNING",
  done: "DONE",
  waiting_human: "WAITING ON HUMAN",
  committed: "COMMITTED",
  rejected: "REJECTED",
  failed: "FAILED",
  blocked: "BLOCKED",
};

function cell(text: string | undefined): string {
  if (text === undefined || text === "") return "-";
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function stepLabel(step: Step): string {
  return step.tool ? `${step.id} (${step.tool})` : step.id;
}

function headline(wo: WorkOrder): string {
  const steps = wo.steps;
  const first = (status: StepStatus) => steps.find((s) => s.status === status);

  const failed = first("failed");
  if (failed) return `FAILED: ${stepLabel(failed)}`;

  const denied = steps.find((s) => s.status === "rejected" || s.status === "blocked");
  if (denied) return `BLOCKED: denied at ${stepLabel(denied)}`;

  const waiting = first("waiting_human");
  if (waiting) return `WAITING ON HUMAN: ${stepLabel(waiting)}`;

  const running = first("running");
  if (running) return `RUNNING: ${stepLabel(running)}`;

  const finished = steps.filter((s) => s.status === "done" || s.status === "committed").length;
  if (steps.length > 0 && finished === steps.length) return `DONE: all ${steps.length} steps finished`;
  // Between steps (e.g. right after a resume) nothing is running yet but work has happened.
  if (finished > 0) return `IN PROGRESS: ${finished} of ${steps.length} steps finished`;
  return "PENDING";
}

// Key format is `${woId}:${stepId}:${tool}:${hash}`; step ids and tools contain no colons.
function stepFromKey(entry: LedgerEntry): string | undefined {
  const parts = entry.idempotencyKey.split(":");
  return parts.length >= 4 ? parts[1] : undefined;
}

export function renderWorkOrder(wo: WorkOrder): string {
  const lines: string[] = [];
  lines.push(`# ${wo.id}: ${wo.scenario}`, "");
  lines.push(`**${headline(wo)}**`, "");

  lines.push("## Constraints", "");
  if (wo.constraints.length === 0) lines.push("None");
  else for (const c of wo.constraints) lines.push(`- ${c.replace(/\r?\n/g, " ")}`);
  lines.push("");

  lines.push("## Steps", "");
  lines.push("| # | Step | Kind | Status |", "|---|---|---|---|");
  wo.steps.forEach((step, i) => {
    const name = step.tool ? `${step.name} (${step.tool})` : step.name;
    const kind = (step.kind === "commit" ? "COMMIT" : "reversible")
      + (step.classifiedBy === "allowlist_override" ? " [allowlist]" : "");
    lines.push(`| ${i + 1} | ${cell(name)} | ${kind} | ${STATUS_WORDS[step.status] ?? cell(step.status)} |`);
  });
  lines.push("");

  lines.push("## Ledger", "");
  if (wo.commits.length === 0) {
    lines.push("No commits proposed yet.");
  } else {
    lines.push("| Step / tool | Status | Approved by | External id |", "|---|---|---|---|");
    for (const entry of wo.commits) {
      const step = stepFromKey(entry) ?? "-";
      lines.push(
        `| ${cell(`${step} / ${entry.tool}`)} | ${cell(entry.status.toUpperCase())} | ${cell(entry.approvedBy)} | ${cell(entry.externalId)} |`,
      );
    }
  }
  lines.push("");

  lines.push("_Mirror of SQLite. SQLite is truth; this document can lag._");
  return `${lines.join("\n")}\n`;
}
