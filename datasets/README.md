# Synthetic seeds for Durable Coworker

SQLite is truth. These JSON files are how you fill it, stub Exa, stub mail, and jump to a demo beat.

## Load order

1. `users.json` — Slack identities. `U_SAM` is never an approver.
2. `customers.json` — fake accounts, contacts, `doNot[]`.
3. `threads.json` — six seeded threads. Primary is `THREAD-ACME-OUTAGE`.
4. `research_blobs.json` — hardcoded Exa stand-ins. Keyed by thread.
5. `tasks_seed.json` — reversible task titles. Dedupe on `(workOrderId, title)`.
6. `injections.json` — poison messages + expected ledger state.
7. `work_order_fixtures.json` — skip-ahead rows for kill / retry / deny.
8. `outbox.json` — start empty. `mail.send` only appends.

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

## Assertions the tests should lock

- After kill-resume of `WO-1842-KILL`, task count stays 2.
- After retry of `WO-1842-SENT`, `outbox.messages.length === 1` and `reused: true`.
- After `INJ-NON-APPROVER-CLICK`, ledger stays `proposed`.
- `@coworker take this` on `THREAD-EMPTY` creates zero work orders.
- `U_SAM` is never in `approvedBy`.
