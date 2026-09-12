import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { createChannel } from "@copilotkit/channels";
import {
  Actions,
  Button,
  Context,
  Field,
  Fields,
  Header,
  type InteractionContext,
  Markdown,
  Message,
  Section,
} from "@copilotkit/channels/ui";
import { CopilotKitIntelligence, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { runs, tasks } from "@trigger.dev/sdk";

import { plan } from "../agent/plan.js";
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
} from "../core/index.js";
import { STATE_DIR, runIdFromThreadKey } from "../core/state.js";
import { createFromThread } from "../core/recovery.js";
import { mirrorSoon } from "../mirror/index.js";
import type { workorderTask } from "../trigger/workorder.js";
import { datasetSlackApprovers, mentionSelection, SELECTION_HELP, SourceSelectionError } from "./datasets.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const log = (msg: string) => console.log(`[channel ${new Date().toISOString()}] ${msg}`);

const CHANNEL_CODE = required("CHANNEL_CODE");
required("TRIGGER_SECRET_KEY"); // fail at boot, not on the first mention

// Channels hands us only the mention text. This fixture is selected explicitly;
// dataset seeds have a separate grounded path and never enter the model planner.
const FIXTURE = JSON.parse(
  readFileSync(new URL("../../scenarios/customer-success.json", import.meta.url), "utf8"),
) as { id: string; threadText: string };

const ENV_APPROVERS = (process.env.APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Run states that end a run. */
const TERMINAL = new Set(["COMPLETED", "CANCELED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"]);

const ACCENT = { info: "#2D7FF9", wait: "#E67E22", ok: "#27AE60", stop: "#C0392B" };

/** Mention and click handlers get different thread types; cards only need post. */
type Thread = Pick<InteractionContext["thread"], "post">;
type StepRef = { woId: string; stepId: string };

const who = (slackId: string) => `<@${slackId}>`;

function stepLines(wo: WorkOrder): string {
  return wo.steps.map((s) => `\`${s.status}\`  ${s.kind === "commit" ? "*commit*" : "reversible"}  ${s.name}`).join("\n");
}

function StatusCard(props: { woId: string; title: string; accent: string; note: string }) {
  const wo = getWorkOrder(props.woId);
  return (
    <Message accent={props.accent}>
      <Header>{`${props.title} · ${wo.id}`}</Header>
      <Section>
        <Markdown>{stepLines(wo)}</Markdown>
      </Section>
      <Context>{props.note}</Context>
    </Message>
  );
}

function NoticeCard(props: { accent: string; title: string; body: string; note: string }) {
  return (
    <Message accent={props.accent}>
      <Header>{props.title}</Header>
      <Section>
        <Markdown>{props.body}</Markdown>
      </Section>
      <Context>{props.note}</Context>
    </Message>
  );
}

/** Registered with the channel so a click after a listener restart can still find its handler. */
function ApprovalCard(props: StepRef) {
  const wo = getWorkOrder(props.woId);
  const step = wo.steps.find((s) => s.id === props.stepId);
  const entry = wo.commits.find((e) => e.idempotencyKey.startsWith(`${wo.id}:${props.stepId}:`));
  const args = (entry?.args ?? {}) as Record<string, unknown>;
  const preview =
    typeof args.body === "string"
      ? `To: ${String(args.to)}\nSubject: ${String(args.subject)}\n\n${args.body}`
      : JSON.stringify(args, null, 2);
  const ref: StepRef = { woId: props.woId, stepId: props.stepId };
  const unknown = entry?.status === "outcome_unknown";
  const attempted = unknown || Boolean(entry?.attemptedAt);
  const canDeny = !attempted && (entry?.status === "proposed" || entry?.status === "approved");
  return (
    <Message accent={ACCENT.wait}>
      <Header>{unknown ? `Outcome unknown: ${step?.name ?? props.stepId}` : `Awaiting approval: ${step?.name ?? props.stepId}`}</Header>
      <Fields>
        <Field label="Tool">{entry?.tool ?? step?.tool ?? "unknown"}</Field>
        <Field label="Target">{String(args.to ?? args.workOrder ?? wo.id)}</Field>
        <Field label="Approvers">{wo.approvers.map(who).join(" ")}</Field>
        <Field label="Work order">{wo.id}</Field>
      </Fields>
      <Section>
        <Markdown>{`\`\`\`\n${preview}\n\`\`\``}</Markdown>
      </Section>
      <Context>
        {wo.constraints.length
          ? `Constraints: ${wo.constraints.map((c) => `[ ${c} ]`).join("  ")}`
          : "No constraints extracted"}
      </Context>
      {attempted ? <Context>An attempt may already have applied this action. Retry checks for a receipt first and may send again after the retry window.</Context> : null}
      <Actions>
        <Button style="primary" value={ref} onClick={(ctx) => onApprove(ctx.thread, ctx.actor.id, ctx.action.value ?? ref)}>
          {attempted ? "Reconcile / retry" : "Approve"}
        </Button>
        {canDeny ? <Button style="danger" value={ref} onClick={(ctx) => onDeny(ctx.thread, ctx.actor.id, ctx.action.value ?? ref)}>
          Deny
        </Button> : null}
      </Actions>
    </Message>
  );
}

function receipts(woId: string): string {
  const n = getWorkOrder(woId).commits.filter((e) => e.status === "committed").length;
  return `${n} receipt${n === 1 ? "" : "s"} on ${woId}`;
}

const notice = (thread: Thread, accent: string, title: string, body: string, note: string) =>
  thread.post(<NoticeCard accent={accent} title={title} body={body} note={note} />);

async function errorCard(thread: Thread, err: unknown, woId?: string): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log(`ERROR ${message}`);
  let note = "The outcome could not be verified. Check stored progress before retrying.";
  if (woId) {
    try {
      note = `${receipts(woId)}. Recorded progress and receipts are kept; unconfirmed actions may have applied.`;
    } catch {
      // A failed state read must not turn a notification error into a false no-send claim.
    }
  }
  await notice(thread, ACCENT.stop, "Something went wrong", `\`${message}\``, note);
}

// Coalesce active runs in this listener. Recovery after process death still uses a new
// Trigger attempt; this is not a distributed execution lock or a permanent dedupe key.
const activeJobs = new Map<string, Promise<void>>();

/**
 * Trigger the job and wait for it here. D21: a Thread is writable only while this
 * delivery is open, so the result card must be posted before the handler returns.
 */
async function watchJob(thread: Thread, woId: string): Promise<string> {
  // No idempotencyKey (D18); ttl 0 so a resume queued after a long pause does not expire.
  const handle = await tasks.trigger<typeof workorderTask>("workorder", { woId }, { tags: [`wo:${woId}`], ttl: 0 });
  log(`trigger ${woId} -> ${handle.id}`);
  let status = "UNKNOWN";
  let last = "";
  // A run stuck in QUEUED almost always means no dev worker is connected; say so instead of going silent.
  const queuedWarning = setTimeout(() => {
    if (last === "QUEUED" || last === "PENDING_VERSION" || last === "") {
      log(`run ${handle.id} still ${last || "not started"} after 10s; is \`trigger dev\` running?`);
      void notice(thread, ACCENT.wait, "Queued", "Waiting for a worker to pick this up.", "Progress is kept.").catch(() => {});
    }
  }, 10_000);
  try {
    for await (const run of runs.subscribeToRun(handle.id)) {
      if (run.status !== last) {
        log(`run ${handle.id} ${last || "-"} -> ${run.status}`);
        last = run.status;
      }
      if (TERMINAL.has(run.status)) {
        status = run.status;
        break;
      }
    }
  } finally {
    clearTimeout(queuedWarning);
  }
  return status;
}

async function runJobOnce(thread: Thread, woId: string): Promise<void> {
  const status = await watchJob(thread, woId);
  const wo = getWorkOrder(woId);
  mirrorSoon(wo);
  log(`${woId} worker ${status}: ${wo.steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);

  if (status !== "COMPLETED") {
    await thread.post(
      <StatusCard
        woId={woId}
        title={`Interrupted (${status})`}
        accent={ACCENT.wait}
        note="Progress kept. Mention me to resume."
      />,
    );
    return;
  }
  const pending = pendingApproval(wo);
  if (pending) {
    await thread.post(<ApprovalCard woId={woId} stepId={pending.step.id} />);
    return;
  }
  const stopped = wo.steps.find((s) => s.status === "rejected" || s.status === "blocked" || s.status === "failed");
  const allDone = wo.steps.every((s) => s.status === "done" || s.status === "committed");
  await thread.post(
    <StatusCard
      woId={woId}
      title={stopped ? `Stopped at ${stopped.id}` : allDone ? "Finished" : "Paused"}
      accent={stopped ? ACCENT.stop : allDone ? ACCENT.ok : ACCENT.wait}
      note={receipts(woId)}
    />,
  );
}

async function runJob(thread: Thread, woId: string): Promise<void> {
  let job = activeJobs.get(woId);
  if (!job) {
    job = runJobOnce(thread, woId);
    activeJobs.set(woId, job);
  }
  try {
    await job;
  } finally {
    if (activeJobs.get(woId) === job) activeJobs.delete(woId);
  }
}

async function continueAfterCommit(thread: Thread, woId: string): Promise<void> {
  const wo = getWorkOrder(woId);
  const pending = pendingApproval(wo);
  if (pending) {
    await thread.post(<ApprovalCard woId={woId} stepId={pending.step.id} />);
    return;
  }
  const next = wo.steps.find((s) => s.status !== "done" && s.status !== "committed");
  if (next && (next.status === "pending" || next.status === "running")) await runJob(thread, woId);
}

async function onApprove(thread: Thread, actor: string, ref: StepRef): Promise<void> {
  log(`approve click ${ref.woId}/${ref.stepId} by ${actor}`);
  try {
    // Core permits receipt reads on committed keys. Advancing the workflow still
    // requires an approver, including when an old button returns a reused receipt.
    const before = getWorkOrder(ref.woId);
    if (!before.approvers.includes(actor)) throw new NotAuthorizedError(actor, before.approvers);
    const result = await commit(ref.woId, ref.stepId, actor);
    mirrorSoon(getWorkOrder(ref.woId));
    if (result.reused) {
      await notice(
        thread,
        ACCENT.ok,
        "Already committed",
        `Stored receipt \`${result.externalId}\`. This click reused the receipt.`,
        receipts(ref.woId),
      );
      await continueAfterCommit(thread, ref.woId);
      return;
    }
    if (result.status === "outcome_unknown") {
      await notice(
        thread,
        ACCENT.wait,
        "Outcome unknown",
        `\`${ref.stepId}\` may or may not have been sent. Approve again after 30s to check the outbox before any resend.`,
        receipts(ref.woId),
      );
      return;
    }
    if (result.status !== "committed") {
      await notice(thread, ACCENT.wait, "Send in progress", `\`${ref.stepId}\` is already being sent. Not sending again.`, receipts(ref.woId));
      return;
    }
    await notice(
      thread,
      ACCENT.ok,
      "Committed",
      `Approved by ${who(actor)}. Receipt \`${result.externalId}\``,
      receipts(ref.woId),
    );
    await continueAfterCommit(thread, ref.woId);
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      await notice(
        thread,
        ACCENT.stop,
        "Not authorized",
        `${who(actor)} cannot approve this step. Only ${err.approvers.map(who).join(", ")} can.`,
        "Anyone can click. Only an approver moves a step.",
      );
      return;
    }
    if (err instanceof NotApprovedError) {
      await notice(thread, ACCENT.stop, "Not approvable", `\`${ref.stepId}\` was denied or has no proposal. This click did not authorize a new action.`, ref.woId);
      return;
    }
    await errorCard(thread, err, ref.woId);
  }
}

async function onDeny(thread: Thread, actor: string, ref: StepRef): Promise<void> {
  log(`deny click ${ref.woId}/${ref.stepId} by ${actor}`);
  try {
    mirrorSoon(deny(ref.woId, ref.stepId, actor));
    await notice(
      thread,
      ACCENT.stop,
      `Stopped by ${actor}`,
      `Stopped by ${who(actor)}. ${ref.woId} blocked at \`${ref.stepId}\`.`,
      `${receipts(ref.woId)}. This action and remaining work are blocked; earlier receipts are kept.`,
    );
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      await notice(
        thread,
        ACCENT.stop,
        "Not authorized",
        `${who(actor)} cannot deny this step. Only ${err.approvers.map(who).join(", ")} can.`,
        "Anyone can click. Only an approver moves a step.",
      );
      return;
    }
    await errorCard(thread, err, ref.woId);
  }
}

const channel = createChannel({
  name: CHANNEL_CODE,
  identifyUser: "platform",
  components: [ApprovalCard, StatusCard, NoticeCard],
});

channel.onMention(async ({ thread, message }) => {
  // Never react to our own cards or another app's.
  if (message.actor?.kind === "bot" || message.actor?.kind === "app") return;

  const threadRef = runIdFromThreadKey(thread.conversationKey);
  const woId = `WO-${threadRef}`;
  try {
    const selection = mentionSelection(message.text);
    let wo = findWorkOrder(woId);
    if (!wo) {
      if (!selection) {
        await notice(thread, ACCENT.wait, "Choose a source thread", SELECTION_HELP, "No work order or worker run was created.");
        return;
      }
      if (selection.kind === "dataset") {
        const approvers = datasetSlackApprovers(selection.id);
        wo = createFromThread(selection.id, { id: woId, threadRef, approvers });
        if (!wo) {
          await notice(thread, ACCENT.stop, "Cannot start this dataset thread", `${selection.id} needs a customer, a constraint, and an allowlisted approver.`, "No work order or worker run was created.");
          return;
        }
      } else {
        if (selection.id !== FIXTURE.id) throw new SourceSelectionError(`Unknown fixture ${selection.id}. ${SELECTION_HELP}`);
        if (!ENV_APPROVERS.length || ENV_APPROVERS.some(id => !/^[UW][A-Z0-9]{8,}$/.test(id))) {
          throw new SourceSelectionError("Set APPROVERS to a comma-separated list of real Slack user IDs before starting the fixture. The requester is not automatically an approver.");
        }
        const planned = await plan(FIXTURE.threadText);
        const approvers = [...new Set(ENV_APPROVERS)];
        wo = createWorkOrder({
          id: woId,
          scenario: FIXTURE.id,
          threadRef,
          constraints: planned.constraints,
          approvers,
          steps: planned.steps,
        });
      }
      log(`mention -> selected ${woId} source=${wo.scenario} approvers=${wo.approvers.join(",")}`);
    }
    // The fixture planner awaits a model; another mention may select a dataset
    // before its create returns the already stored work order. Check that result too.
    if (selection && selection.id !== wo.scenario) {
      await notice(thread, ACCENT.stop, "Source already selected", `This conversation belongs to ${wo.scenario}. Start a new Slack thread to use ${selection.id}.`, "Recorded work and approval identities are preserved.");
      return;
    }

    const pending = pendingApproval(wo);
    if (pending) {
      log(`mention -> ${woId} already waiting at ${pending.step.id}; re-posting approval card`);
      await thread.post(<ApprovalCard woId={woId} stepId={pending.step.id} />);
      return;
    }

    const recorded = wo.steps.filter((s) => s.status === "done" || s.status === "committed");
    if (recorded.length === wo.steps.length) {
      await thread.post(
        <StatusCard woId={woId} title="Finished" accent={ACCENT.ok} note={receipts(woId)} />,
      );
      return;
    }
    log(`mention -> ${woId} ${recorded.length ? `RESUME (recorded: ${recorded.map((s) => s.id).join(",")})` : "FRESH"}`);
    await thread.post(
      <StatusCard
        woId={woId}
        title={recorded.length ? "Resuming" : "Starting"}
        accent={ACCENT.info}
        note={
          recorded.length
            ? `Already recorded, will not re-run: ${recorded.map((s) => s.id).join(", ")}`
            : `Approvers: ${wo.approvers.map(who).join(" ")} · constraints: ${wo.constraints.join("; ") || "none"}`
        }
      />,
    );
    await runJob(thread, woId);
  } catch (err) {
    if (err instanceof SourceSelectionError) {
      await notice(thread, ACCENT.stop, "Cannot start this source", err.message, "No new work order or worker run was created.");
      return;
    }
    await errorCard(thread, err, woId);
  }
});

const intelligence = new CopilotKitIntelligence({
  apiKey: required("CPK_INTELLIGENCE_API_KEY"),
  ...(process.env.INTELLIGENCE_API_URL ? { apiUrl: process.env.INTELLIGENCE_API_URL } : {}),
  ...(process.env.INTELLIGENCE_GATEWAY_WS_URL ? { wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL } : {}),
});

const runtime = new CopilotRuntime({
  agents: {},
  intelligence,
  identifyUser: () => ({ id: "durable-coworker", name: "Durable Coworker" }),
  channels: [channel],
});

const listener = createCopilotNodeListener({ runtime, basePath: "/api/copilotkit" });
const channelControl = listener.channels;
if (!channelControl) throw new Error("Channels control surface was not created.");

const server = createServer(listener);

const shutdown = async () => {
  log("shutting down");
  await channelControl.stop();
  if (server.listening) server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await channelControl.ready({ timeoutMs: 30_000 });

const status = channelControl.status();
if (status.overall === "online") {
  log(`channel "${CHANNEL_CODE}" ONLINE`);
} else {
  log(`channel "${CHANNEL_CODE}" NOT online -> ${JSON.stringify(status)}`);
}

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => log(`lifecycle server on :${port} — state dir ${STATE_DIR}`));
