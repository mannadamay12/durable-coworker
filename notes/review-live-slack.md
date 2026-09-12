# Live Slack UI follow-up

2026-09-12, following explicit user authorization to interact with Angie in the open Slack app. Source checkout remained at `54afa04`. Native Slack accessibility and screenshots were captured through the computer-use tool. No Approve or Deny button was clicked; existing workflows were not changed.

## Observed existing UI

Opened the latest earlier test in `#all-agents-cowork`, whose [root message](https://agents-cowork.slack.com/archives/C0C1ESDGPDG/p1789248424756149) was posted at 14:27 PT.

The thread visibly contains an email receipt, an Already committed response with the same receipt, a separate CRM approval and receipt, and Finished. This directly confirms that those earlier cards are visible in the real Slack UI; it is not a new send/retry test. Approval controls remain visible on earlier cards after the workflow finishes.

Visual findings:

- The narrow thread panel makes long titles, raw step identifiers and the CRM JSON preview hard to scan.
- Step lines contain implementation vocabulary (`done`, `reversible`, `committed`, `commit`) and read as a log, not a concise customer-facing progress summary.
- Slack adds a Show more expansion for longer content. This is a separate behavior from the SDK's 3,000-character section truncation; expansion does not establish that longer-than-limit content is recoverable.
- Global outbox counts are labeled message(s), even though the visible receipts include one email and one CRM update.
- Constraints and actor identity are present, and duplicate approval returns a recognizable existing receipt.

## Newly sent test

At 15:01:52 PT, sent a native @angie mention in the existing test channel, creating a new thread:

> UI review test: Acme Freight needs an incident update. Tracking was unavailable from 09:00 to 09:30 UTC and then recovered, with no data loss. Prepare a customer email to demo-review@example.invalid for human approval. Do not promise a credit. Do not send anything or update CRM without approval.

[Open the test thread](https://agents-cowork.slack.com/archives/C0C1ESDGPDG/p1789250512303809).

Angie posted [Starting · WO-0ed6bf3c1a79](https://agents-cowork.slack.com/archives/C0C1ESDGPDG/p1789250522698839?thread_ts=1789250512.303809&cid=C0C1ESDGPDG) at 15:02:02 PT. The actual UI displayed two reversible steps: draft the Acme incident email, then log it to the work order. It displayed the no-credit/no-send/no-CRM-without-approval constraints and the requested example.invalid recipient. This particular plan did not include a commit step.

A read-only SQLite inspection at 15:02:49 PT confirmed both steps were still pending, with zero tool-call records and zero ledger entries for this work order. The UI therefore verifies mention → planning → persisted work order → initial card. It does not verify worker completion, a new approval card, or a new receipt. No claim is made about the reason execution had not started; worker availability and queue state were not independently established.

## Recommended UI changes from the live view

Show Queued / Running / Waiting for approval / Interrupted as distinct labels, with the current attempt and last observed update available under details. The initial card should not imply active execution before a worker claims the job. Prefer brief business-language step names and per-work-order receipt counts by tool. Put full immutable proposal content behind an explicit View proposal action, and replace old approval controls with their recorded outcome when possible while retaining backend deduplication.

Native captures of the earlier receipt thread and this test's Starting card were returned inline in the conversation. No reconstructed or generated screenshot was used. The open Slack UI was left on the new test thread.
