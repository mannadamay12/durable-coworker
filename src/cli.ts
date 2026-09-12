// Run a work order end to end from the terminal, no Slack. The fallback demo.
//   node --env-file=.env --import tsx src/cli.ts <command> [--wo WO-1842] [--actor U123]
import {
  NotApprovedError,
  NotAuthorizedError,
  type WorkOrder,
  commit,
  createWorkOrder,
  deny,
  findWorkOrder,
  getWorkOrder,
  pendingApproval,
  reset,
  runReversible,
} from "./core/index.js";
import { outboxRows } from "./core/inspect.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPROVERS = (process.env.APPROVERS ?? "U_MAYA").split(",").map((s) => s.trim()).filter(Boolean);
const woId = flag("wo", "WO-1842");
const actor = flag("actor", APPROVERS[0]);

function ensure(): WorkOrder {
  return (
    findWorkOrder(woId) ??
    createWorkOrder({ id: woId, scenario: "customer-success", threadRef: woId, approvers: APPROVERS })
  );
}

function show(wo: WorkOrder): void {
  console.log(`\n${wo.id}  constraints: ${wo.constraints.join("; ")}  approvers: ${wo.approvers.join(", ")}`);
  for (const s of wo.steps) {
    const override = s.classifiedBy === "allowlist_override" ? "  (allowlist override)" : "";
    console.log(`  ${s.status.padEnd(13)} ${s.kind.padEnd(10)} ${s.id}${override}`);
  }
  for (const e of wo.commits) {
    console.log(`  ledger ${e.status.padEnd(15)} ${e.tool} ${e.externalId ?? ""} ${e.approvedBy ? `by ${e.approvedBy}` : ""}`);
  }
  console.log(`  outbox rows: ${outboxRows().length}\n`);
}

async function tryCommit(as: string): Promise<void> {
  const pending = pendingApproval(getWorkOrder(woId));
  const stepId = pending?.step.id ?? getWorkOrder(woId).steps.find((s) => s.kind === "commit")?.id;
  if (!stepId) return console.log("no commit step");
  try {
    const r = await commit(woId, stepId, as);
    console.log(
      r.reused
        ? `ALREADY COMMITTED ${stepId}: receipt ${r.externalId}, nothing sent`
        : `commit ${stepId} as ${as}: ${r.status} ${r.externalId ?? ""}`,
    );
  } catch (err) {
    if (err instanceof NotAuthorizedError) console.log(`REJECTED ${as}: only ${err.approvers.join(", ")} can approve`);
    else if (err instanceof NotApprovedError) console.log(`NOT APPROVED: ${stepId} has no approvable proposal`);
    else throw err;
  }
}

switch (command) {
  case "reset":
    reset();
    break;
  case "create":
    show(ensure());
    break;
  case "run":
    ensure();
    show(await runReversible(woId));
    break;
  case "show":
    show(getWorkOrder(woId));
    break;
  case "commit":
  case "approve":
    await tryCommit(actor);
    show(getWorkOrder(woId));
    break;
  case "deny": {
    const pending = pendingApproval(getWorkOrder(woId));
    if (!pending) {
      console.log("nothing waiting on a human");
      break;
    }
    try {
      show(deny(woId, pending.step.id, actor));
    } catch (err) {
      if (err instanceof NotAuthorizedError) console.log(`REJECTED ${actor}: only ${err.approvers.join(", ")} can deny`);
      else throw err;
    }
    break;
  }
  case "outbox":
    for (const row of outboxRows()) console.log(`--- ${row.id} (${row.tool}) ${row.sentAt}\n${row.body}\n`);
    break;
  case "demo":
    reset();
    ensure();
    await runReversible(woId);
    await tryCommit("U_STRANGER");
    await tryCommit(actor);
    await tryCommit(actor);
    show(getWorkOrder(woId));
    break;
  default:
    console.log("commands: reset | create | run | show | approve | commit | deny | outbox | demo  [--wo ID] [--actor SLACK_ID]");
}
