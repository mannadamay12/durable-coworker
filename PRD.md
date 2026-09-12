# Durable Coworker: PRD

Build window closes 15:30. Everything below is scoped to that.

---

## 1. Problem

Agents keep the plan, the progress, and the evidence in the model's context window.
That is RAM. When the process dies the plan dies with it, and the only recovery
available is to run it again. Running it again is exactly the thing you cannot safely
do once a step has already emailed a customer or written to a CRM.

Retries are at-least-once. Side effects are not idempotent by default. Protocol-level
recovery says nothing about business-level recovery.

## 2. Scenario

Maya, in a customer-success Slack thread. The thread already has the customer name,
the outage, the deadline, and one constraint: do not promise a credit. She types
`@coworker take this`.

The coworker opens a work order, researches, drafts, creates follow-up tasks, then
stops. It cannot send. It posts a card with the constraint attached. Maya approves.
Exactly one email leaves.

## 3. Non-goals

Multi-agent orchestration. An SRE dashboard. Memory or personalisation. Real CRM,
calendar, or e-signature. Autonomy claims of any kind.

---

## 4. The three guarantees

Keeping these separate in the code is the whole design. Merging any two is the bug.

| Guarantee | Question | Lives in |
|---|---|---|
| Progress | Where was I? | Step list on the work order |
| Side effect | Did the world already change? | Ledger, keyed by idempotency key |
| Decision | Did a human already say yes? | Waitpoint token completed by a Slack click |

## 5. The security boundary

The model's toolset in the reversible phase: `search`, `draft`, `write_to_work_order`.
In the commit phase the model has no tools at all. Plain code executes.

Consequences worth stating in the submission:

1. A prompt injection in the thread cannot send an email. There is no code path from
   model output to `mail.send`.
2. Approval authority is checked against an approver allowlist on the work order,
   matched on Slack user ID.
3. Resume is authenticated by work order ID plus that same allowlist.

### Honest limit

At-least-once with a dedupe ledger, not exactly-once. There is a window between the
provider accepting a send and the ledger write landing. Recovery there is
reconciliation.

**Mitigation we build:** embed the idempotency key inside the side effect itself, as a
marker line in the email body. Reconciliation becomes an exact string match over sent
mail rather than a fuzzy match on recipient and subject. Two lines of code, and it
closes the one gap most designs hand-wave.

---

## 6. Where the model goes

Built:

- **Planner and classifier.** Reads the thread, emits a step list with each step tagged
  `reversible` or `commit`. Structured output, strict JSON schema, temperature 0.
- **Constraint extractor.** Pulls "do not promise a credit" out of prose into a
  structured constraint that renders as a chip on the approval card.

Incidental: the drafter. Keep it, do not pitch it.

Stretch: an adversarial reviewer that checks a proposed commit against the extracted
constraints and flags a violation on the card.

Never: a model adjudicating whether a side effect landed.

**The classification is never trusted.** `COMMIT_TOOLS` overrides it and the override
is logged. A caught misclassification is a demo beat.

---

## 7. Data model

```ts
type StepStatus = 'pending' | 'running' | 'done' | 'waiting_human'
                | 'committed' | 'rejected' | 'failed' | 'blocked';

interface WorkOrder {
  id: string;              // "WO-1842"
  scenario: string;        // fixture key
  threadRef: string;       // channel + ts
  constraints: string[];   // extracted, shown on every approval card
  approvers: string[];     // Slack user IDs. authorization, not decoration
  steps: Step[];
  commits: LedgerEntry[];
}

interface Step {
  id: string;              // "5-send-customer-update"
  name: string;
  kind: 'reversible' | 'commit';
  tool?: string;
  status: StepStatus;
  output?: string;         // drafts live here, never in model memory
  classifiedBy: 'model' | 'allowlist_override';
}

interface LedgerEntry {
  idempotencyKey: string;  // `${woId}:${stepId}:${tool}:${sha256(args)}`
  tool: string;
  args: unknown;
  status: 'proposed' | 'approved' | 'committed' | 'rejected'
        | 'failed' | 'outcome_unknown';
  approvedBy?: string;
  externalId?: string;     // only the committer writes this
  attemptedAt?: string;
  committedAt?: string;
}
```

Storage: SQLite is truth. The Ambiguous doc is a mirror for the camera. A failed doc
write must never corrupt the guarantee.

### The committer

```ts
async function commit(wo: WorkOrder, stepId: string, actor: string) {
  const entry = findEntry(wo, stepId);
  if (entry.status === 'committed') return { reused: true, externalId: entry.externalId };
  if (!wo.approvers.includes(actor)) throw new Error('not_authorized_to_approve');
  if (entry.status !== 'approved') throw new Error('not_approved');

  const existing = await reconcile(entry.idempotencyKey);
  if (existing) return markCommitted(entry, existing.id);

  const res = await tools[entry.tool](entry.args);
  if (!res?.id) return mark(entry, 'outcome_unknown');
  return markCommitted(entry, res.id);
}
```

---

## 8. Policy

- **Deny stops the job.** Card reads "Stopped by @maya. WO-1842 blocked at step 5."
  No silent continuation.
- **Timeout blocks.** Work order goes to `blocked`, card posts, approver is DMed. It
  must never fall through to a send.
- **Approvers** are hardcoded at work-order creation from the thread participants.
  No settings UI.
- **Mobile approval is free.** A Slack DM to the approver pushes to their phone. Send
  the approval card as a DM in addition to the thread card. Zero infrastructure.

---

## 9. Build order

Inverted deliberately. The kill test is built first against stubs because it is the
only thing a reviewer remembers, and it must be dull before anything real is wired in.

| Milestone | Definition of done |
|---|---|
| Kill mechanic proven | A worker dies and the work comes back. Slack bot stays alive. |
| Core loop, all tools stubbed | Kill, restart, approve, retry send. Outbox has exactly one row. |
| Authorization | Non-approver click is rejected with a card naming who can approve. |
| Slack surface | Mention starts the job. Native card with steps, constraint chips, approve and deny. |
| Ambiguous doc and tasks | Work order visible in the doc UI while the process is killed. |
| Injection beat | Seeded thread message instructing an immediate send. Step does not move. |
| Video | Two minutes, no architecture narration. |
| Submit | Repo, description, video, social post. |

### Cut list, in order

Cloud Run deploy, Exa (hardcode a research blob), Auth0, mobile approval, CRM and
calendar, OpenRouter failover, real mail provider, second scenario.

---

## 10. Demo

| Time | Beat |
|---|---|
| 0:00–0:20 | Slack thread with a real constraint. `@coworker take this`. Work order appears in the Ambiguous doc. |
| 0:20–0:40 | Research and draft land in the doc. Tasks created. No email sent. |
| 0:40–1:00 | Kill the worker. Restart. Resumes at the approval step. Tasks not duplicated. |
| 1:00–1:20 | Injection attempt in the thread. Step does not move. |
| 1:20–1:40 | Approve. Receipt with external id on the doc. Outbox shows one email. |
| 1:40–2:00 | Retry the send. Card says already committed. Outbox still shows one. |

If the kill beat or the retry beat does not work, there is nothing worth submitting.
Protect those two above everything.

## 11. Framing

Lead with the stance, not the mechanism. "The agent never holds the send button" tells
a scanning reviewer what is new in six words. Durability is the supporting mechanism.

Do not put a sponsor mapping table in the submission. It reads as prize farming.

---

## 12. Scenarios

Three fixtures, build against one, demo at most two.

1. **Customer-success email.** Double-commit prevented. Primary.
2. **Employee offboarding.** Four commits across systems. Kill after two, resume
   completes only the missing two. Different failure mode, same ledger. This is the
   generality claim and it costs a tool registry swap.
3. **Refund issuance.** Money. Held in reserve.
