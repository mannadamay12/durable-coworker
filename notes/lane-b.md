# Lane B: Slack approval surface

## Shipped

`src/channel/listener.tsx`, replacing the smoke listener.

- Mention: `WO-<sha256(conversationKey)[:12]>` (D17). Creates the work order from
  `plan(threadText)`; approvers are the mentioning user plus `APPROVERS` (comma separated).
  Posts Starting/Resuming, triggers `workorder` (`ttl: 0`, no idempotencyKey, D18), waits
  for the run inside the handler (D21), then posts the approval card or Finished.
- A mention on a work order already waiting on a human re-posts its approval card instead
  of triggering a second run.
- Approval card: step, tool, target, approvers, the frozen commit args (email body), the
  constraints, Approve and Deny. All cards are registered in `createChannel({ components })`.
- Approve calls `commit()` directly (lane A treats an approver's commit on a proposed entry
  as the approval). Posts Committed with the receipt, then re-triggers the job so the next
  commit step gets its own card. `reused: true` posts Already committed with the same id.
- Non-approver: Not authorized card naming who can approve. Deny: "Stopped by <user>.
  <woId> blocked at <stepId>." Every other error from core renders as a card.

## Verified live (Slack, 14:27, WO-a989f8b0093a)

Mention -> live-model plan (mail.send and crm.update classified commit, allowlist agreed)
-> run COMPLETED at the send, approval card -> Approve -> `mail_send_15e6dbf6`, job
re-triggered, stopped at crm.update -> second Approve on the send card -> "RETRY of
committed ... nothing sent" -> Approve CRM -> `crm_update_79f87e7c` -> all steps committed.
Outbox: 2 lines (one email, one CRM update).

## Not verified

- Non-approver click (needs a second Slack user).
- Deny from Slack (covered by lane A's kill test, not clicked live).
- Kill during a Slack-triggered run, then resume by re-mention.
- Click after a listener restart (components are registered, but the listener must not be
  killed on camera anyway, invariant 6).

## Discovered

- Channels passes only the mention's own text, not thread history. The listener plans from
  `scenarios/customer-success.json` `threadText` unless the mention itself is over 80
  characters.
- Mention and click handlers get different Thread types (`StatefulThread` vs `Thread`);
  card helpers take `Pick<Thread, "post">`.
- lane/b-approval-card includes lanes A and C (merged in to run the listener live); their
  commits are identical to the lane branches, so the merge stays clean.
