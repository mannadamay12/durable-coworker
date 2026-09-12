# Synthetic seeds for Durable Coworker

SQLite is truth for work orders, the ledger, and the local outbox. These JSON seed
files are an immutable, bundled pack: the core validates them at import time,
then clones the selected thread, customer, research, draft, tasks, constraints and
approver metadata into a work order. A Trigger bundle therefore does not need the
source checkout or a writable `datasets/` directory.

## Load order

1. `users.json` — Slack identities. `U_SAM` is never an approver.
2. `customers.json` — fake accounts, contacts, `doNot[]`.
3. `threads.json` — six seeded threads. Primary is `THREAD-ACME-OUTAGE`.
4. `research_blobs.json` — hardcoded Exa stand-ins. Keyed by thread.
5. `tasks_seed.json` — reversible task titles. Dedupe on `(workOrderId, title)`.
6. `injections.json` — poison messages + expected ledger state.
7. `work_order_fixtures.json` — named recovery-beat inputs. `src/core/recovery.ts`
   builds their rows by driving the real engine; the JSON rows are not imported as
   ledger truth.
8. `outbox.json` — historical empty seed metadata. Runtime `mail.send` only appends
   to the SQLite-backed local outbox.

## Demo loadout (two minutes)

| Beat | Load |
| --- | --- |
| Live take-this | `THREAD-ACME-OUTAGE` empty ledger |
| Kill / resume | optionally jump to fixture `WO-1842-KILL` if live loop is slow |
| Injection | `THREAD-LANTERN-PRICING` (Sam's message is already in the thread) |
| Retry send | fixture `WO-1842-SENT` |
| Honest crash window | fixture `WO-1842-UNKNOWN` + outbox already has `outbox-0001` |
| Deny | `WO-0901` / `THREAD-ACME-REFUND` |
| Theme refuse | `THREAD-EMPTY` |

The CLI equivalents are `node --import tsx src/cli.ts create --thread THREAD-*`,
`demo --thread THREAD-*`, and `load <beat>`. A Slack mention must choose a source
explicitly: `take this THREAD-*` selects a grounded seed; `use fixture
customer-success` selects the planner fixture. An unqualified or ambiguous mention
does not create a work order.

For live Slack, set `DATASET_SLACK_USERS` to a JSON object such as:

```json
{"U_MAYA":"U012REALMAYA","U_LEO":"U012REALLEO","U_PRIYA":"U012REALMAYA","U_JULES":"U012REALLEO"}
```

Those values are workspace member IDs, not display names or invented dataset IDs.
The same member may represent different synthetic personas in different scenarios,
but the two approvers on one work order must remain distinct. `U_SAM` and the agent
identity can never be mapped to an approver.

## Assertions the tests should lock

- After kill-resume of `WO-1842-KILL`, task count stays 2.
- After retry of `WO-1842-SENT`, `outbox.messages.length === 1` and `reused: true`.
- After `INJ-NON-APPROVER-CLICK`, ledger stays `proposed`.
- `@coworker take this` on `THREAD-EMPTY` creates zero work orders.
- `U_SAM` is never in `approvedBy`.

Run `npm run test:datasets`, `npm run test:bundle`, and
`node --import tsx scripts/review-channel.mjs` to exercise the source pack, bundled
worker/CLI, and Slack handler/card flow without sending an external message.
