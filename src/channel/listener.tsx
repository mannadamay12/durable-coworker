import { createServer } from "node:http";

import { createChannel } from "@copilotkit/channels";
import { Context, Header, Markdown, Message, Section } from "@copilotkit/channels/ui";
import { CopilotKitIntelligence, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { runs, tasks } from "@trigger.dev/sdk";

import { STATE_DIR, TOTAL_STEPS, readState, runIdFromThreadKey, statePath } from "../core/state.js";
import type { smokeTask } from "../trigger/smoke.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const log = (msg: string) => console.log(`[channel ${new Date().toISOString()}] ${msg}`);

const CHANNEL_CODE = required("CHANNEL_CODE");
required("TRIGGER_SECRET_KEY"); // fail at boot, not on the first mention

/** Run states that mean "this run is over and did not finish the work". */
const TERMINAL_INCOMPLETE = new Set([
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

// No `agent` — this is a smoke test, there is no model in the loop.
const channel = createChannel({
  name: CHANNEL_CODE,
  identifyUser: "platform",
});

channel.onMention(async ({ thread, message }) => {
  // Never react to our own cards or another app's.
  if (message.actor?.kind === "bot" || message.actor?.kind === "app") return;

  const runId = runIdFromThreadKey(thread.conversationKey);
  const prior = readState(runId);
  const resuming = prior.steps.length > 0;

  let handle: Awaited<ReturnType<typeof tasks.trigger<typeof smokeTask>>>;
  try {
    // No idempotencyKey on purpose. A killed run lands in CANCELED and keeps its
    // key, so re-triggering with one would hand back the dead run's handle and
    // nothing would execute. The runId lives in the payload instead; the tag
    // makes the run findable.
    handle = await tasks.trigger<typeof smokeTask>(
      "smoke",
      { runId },
      { tags: [`smoke:${runId}`], ttl: 0 },
    );
  } catch (err) {
    log(`trigger FAILED for ${runId}: ${(err as Error).message}`);
    await thread.post(
      <Message accent="#C0392B">
        <Header>Could not start the job</Header>
        <Section>
          <Markdown>{`\`${runId}\` — ${(err as Error).message}`}</Markdown>
        </Section>
        <Context>Is the Trigger.dev dev worker running in terminal B?</Context>
      </Message>,
    );
    return;
  }

  log(
    `mention -> runId=${runId} triggerRun=${handle.id} ` +
      `${resuming ? `RESUME (prior: ${prior.steps.join(",")})` : "FRESH"}`,
  );

  await thread.post(
    <Message accent={resuming ? "#E67E22" : "#2D7FF9"}>
      <Header>{resuming ? "Resuming" : "Starting"}</Header>
      <Section>
        <Markdown>{`started \`${runId}\``}</Markdown>
      </Section>
      <Context>
        {resuming
          ? `steps already recorded: ${prior.steps.join(", ")} · trigger run ${handle.id}`
          : `fresh start, 0 of ${TOTAL_STEPS} steps recorded · trigger run ${handle.id}`}
      </Context>
    </Message>,
  );

  // Watch the run from this process and post the closing card. The task itself
  // has no Slack connection — the listener owns the gateway socket and must
  // stay up (CLAUDE.md invariant 6), so completion reporting belongs here.
  // Deliberately not awaited: the handler must return so the delivery loop is
  // free for the next message.
  void (async () => {
    try {
      for await (const run of runs.subscribeToRun(handle.id)) {
        if (run.status === "COMPLETED") {
          const s = readState(runId);
          log(`run ${handle.id} COMPLETED — ${runId} recorded [${s.steps.join(",")}]`);
          await thread.post(
            <Message accent="#27AE60">
              <Header>Finished</Header>
              <Section>
                <Markdown>{`\`${runId}\` completed all ${TOTAL_STEPS} steps.`}</Markdown>
              </Section>
              <Context>{`recorded: ${s.steps.join(", ")} · ${statePath(runId)}`}</Context>
            </Message>,
          );
          return;
        }
        if (TERMINAL_INCOMPLETE.has(run.status)) {
          const s = readState(runId);
          log(`run ${handle.id} ${run.status} — ${runId} kept [${s.steps.join(",")}]`);
          await thread.post(
            <Message accent="#E67E22">
              <Header>{`Interrupted (${run.status})`}</Header>
              <Section>
                <Markdown>
                  {`\`${runId}\` stopped mid-flight. Progress kept: ${
                    s.steps.length ? s.steps.join(", ") : "none"
                  }.`}
                </Markdown>
              </Section>
              <Context>Mention me again in this thread to resume from here.</Context>
            </Message>,
          );
          return;
        }
      }
    } catch (err) {
      log(`watch ${handle.id} failed: ${(err as Error).message}`);
    }
  })();
});

const intelligence = new CopilotKitIntelligence({
  apiKey: required("CPK_INTELLIGENCE_API_KEY"),
  ...(process.env.INTELLIGENCE_API_URL ? { apiUrl: process.env.INTELLIGENCE_API_URL } : {}),
  ...(process.env.INTELLIGENCE_GATEWAY_WS_URL
    ? { wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL }
    : {}),
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
