---
description: Build and run the gate-2 smoke test. Proves kill and resume before any feature work.
---

Build a minimal smoke test. Do NOT build work orders, ledgers, or an agent.

Goal: prove a Slack message can start a Trigger.dev job, that the job can be killed,
and that re-triggering it resumes instead of restarting.

1. Node 22 TypeScript repo. Two processes, two terminals.
2. Process A: CopilotKit Channels listener (`@copilotkit/channels`) using
   `CHANNEL_CODE` and `INTELLIGENCE_API_KEY`. On `@mention` in a thread, trigger the
   job with a `runId` derived from the Slack thread ts, and post a card saying
   `started <runId>`.
3. Process B: Trigger.dev dev worker. One task that logs 5 numbered steps, 1 second
   apart, appending each to `./state/<runId>.json`. On start it reads that file and
   skips any step already recorded.
4. Post a card back to the thread when it finishes.
5. Add `npm run kill` that kills ONLY the Trigger.dev worker, not the Channels listener.

Acceptance criteria, all of which must hold:

- Mention in Slack, watch steps 1 to 3 log
- Run `npm run kill`
- Restart the worker, re-trigger with the same `runId`
- It logs only 4 and 5
- The Slack bot is responsive the entire time

If the Slack bot goes silent when the worker dies, the wrong process is being killed.
Fix that before anything else.

If this is not passing within 45 minutes, stop and report. The fallback is to drop the
Channels SDK and drive the same test from `cli.ts` in a terminal.
