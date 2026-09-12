# Smoke test: Slack → Trigger.dev → kill → resume

Proves three things and nothing else:

1. A Slack @mention starts a Trigger.dev job.
2. The job can be killed mid-flight.
3. Re-triggering from the same thread resumes instead of restarting.

No work orders, no ledger, no agent, no approval gate. Five numbered steps, one
second apart, appended to `state/<runId>.json`.

---

## One-time setup

`.env` is already filled in. One thing is still missing, and only you can do it:

```sh
npx trigger.dev@latest login
```

The `tr_dev_sk_...` secret key in `.env` lets the **listener** trigger jobs. It does
**not** authenticate the **dev CLI** — that uses a personal access token from the
login profile (or `TRIGGER_ACCESS_TOKEN=tr_pat_...`). Without it, terminal B will not
start.

Then sanity-check:

```sh
npm run typecheck   # must be silent
npm run test:kill   # must print "all pass"
npm run kill:dry    # must print "no Trigger.dev worker process found"
```

---

## Two terminals

Terminal A — the Channels listener. **Never kill this one.** It owns the Slack
gateway socket; killing it makes the bot go silent and the demo reads as a crash.

```sh
npm run dev:channel
```

Wait for `channel "angie" ONLINE`. If it says `NOT online`, read the printed status
detail — a channel whose transport joined but whose Slack leg is unhealthy reports
`error` there.

Terminal B — the Trigger.dev dev worker.

```sh
npm run dev:worker
```

---

## The acceptance run

| # | Do this | Expect |
|---|---|---|
| 1 | `npm run reset` | `state cleared` |
| 2 | @mention the bot in a Slack thread | Card: **Starting** — `started <runId>`, `fresh start, 0 of 5 steps recorded` |
| 3 | `cat state/<runId>.json` (or the run log in the Trigger.dev dashboard) | steps grow `[1]`, `[1,2]`, `[1,2,3]`, one second apart. Terminal B only prints run start/finish. |
| 4 | After step 3, terminal C: `npm run kill` | `killed <pid>` then `Listener untouched.` Terminal B dies. |
| 5 | Slack | Card: **Interrupted (CANCELED)** — `Progress kept: 1, 2, 3` |
| 6 | `cat state/<runId>.json` | `"steps": [1, 2, 3]` |
| 7 | Terminal A | Still `ONLINE`, no restart. The listener has no plain-message handler, so it will not reply to a non-mention message. |
| 8 | Terminal B: `npm run dev:worker` | worker back up |
| 9 | @mention **in the same thread** | Card: **Resuming** — same `<runId>`, `steps already recorded: 1, 2, 3` |
| 10 | Terminal A + `cat state/<runId>.json` | `RESUME (prior: 1,2,3)`, then `COMPLETED ... recorded [1,2,3,4,5]`. SKIPPED/DONE lines are in the dashboard run log; terminal B shows about 2s instead of 5s. |
| 11 | Slack | Card: **Finished** — all 5 steps |

Step 10 is the whole test. Only 4 and 5 do work.

`npm run kill -- --dry` lists what would be killed without signalling. Use it before
filming.

To stop the listener deliberately (e.g. to pick up a code change), use `kill -TERM`;
it does not exit on Ctrl-C while the gateway is connected, and a second copy fails on
port 3000.

---

## Two places the spec could not be followed literally

**The runId is not the Slack `thread_ts`.** CopilotKit Channels deliberately does not
expose it — `ReplyTarget` is declared `unknown` and the Slack adapter resolves
`{channel, threadTs}` internally without forwarding it. The docs also say not to parse
`conversationKey` for channel or thread ids. So the runId is
`sha256(thread.conversationKey).slice(0, 12)`. Same property that matters: same thread
gives the same runId across restarts. It is also filesystem-safe, which the raw key is
not.

**The Trigger.dev runId is not ours to set.** There is no run-id field on
`tasks.trigger()`. `idempotencyKey` looks like the answer and is a trap: re-triggering
with the same key returns the *original* run's handle, and a run killed this way ends
up `CANCELED`, which **keeps** its key. Re-triggering would hand back a dead run and
silently execute nothing. So the logical runId travels in the payload, the run is
tagged `smoke:<runId>`, and each resume is a fresh Trigger.dev run. The progress file
is what makes it a resume. This matches DECISIONS.md D4.

Related: `ttl: 0` on the trigger. Dev runs default to a 10-minute TTL, so a queued
resume would silently expire if more than 10 minutes passed between kill and restart.

---

## How the closing card gets posted

The task has no Slack connection — the listener owns the gateway socket. So the
listener subscribes to the run it just triggered (`runs.subscribeToRun`) and posts the
closing card itself, and the mention handler stays open until the run is terminal:
Channels seals the delivery when the handler returns, after which `thread.post` is
rejected (D21). A side benefit: the listener surviving the worker's death is what
makes the **Interrupted** card possible at all.

## Why the watchdog is left alive

`npm run kill` deliberately does not kill Trigger.dev's detached watchdog. When the
dev CLI dies the watchdog cancels the in-flight run within about a second, which is the
`CANCELED` beat in step 5. Kill the watchdog too and recovery falls back to a 5-minute
heartbeat timeout. `devWatchdog.js` lives under `.../dist/esm/dev/`, so a pattern
matching a bare `dev` path segment hits it by accident — `scripts/kill-worker.test.mjs`
pins that case.
