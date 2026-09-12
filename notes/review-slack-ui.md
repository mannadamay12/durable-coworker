# Slack, AG-UI, and demo verification review

Reviewed 2026-09-12 against `c564f70`, after the parent pulled the newly merged Slack approval lane. This replaces the earlier review of `35365f7`; the old smoke-only integration finding is resolved. No live Slack messages, managed deliveries, Trigger runs, external sends, or process kills were performed by this reviewer.

## Current integrated behavior

The merged `src/channel/listener.tsx` now calls the planner, creates a work order, triggers the `workorder` task, renders a native approval card, and calls the model-free core committer using `ctx.actor.id`. Re-mentioning a pending work order re-posts its approval; a successful new commit triggers the next phase. This is substantial working integration, not the previous smoke path.

`notes/lane-b.md` reports a prior live Slack demonstration with an email, duplicate-email approval returning the existing receipt, and a separately approved CRM update. That is inherited evidence, not a new live test from this review. Non-approver clicks, Slack denial, worker kill/resume from Slack, and old-card clicks after listener restart remain unverified live in that handoff.

The current planner makes two concurrent structured calls (`src/agent/plan.ts:105`): step planning and constraint extraction. The listener now calls it at `src/channel/listener.tsx:280`, so routed LLM calls can belong to the integrated flow. Request IDs, token usage, returned model/provider, and fallback mode are not persisted; the model SDK response is reduced to JSON at `src/agent/openrouter.ts:42`. There is no implemented AG-UI event stream in this listener.

The worker returns at a proposal boundary (`src/trigger/workorder.ts:23`–35); it does not park on a Trigger waitpoint. This lets the current mention delivery end before a later click. README's “waitpoint completed by a Slack click” description still does not match this implementation.

## Reproduced failure modes

The executable probe is `scripts/review-channel.mjs`. Run from the worktree:

```sh
node --import tsx scripts/review-channel.mjs
```

It transpiles the actual listener's TSX handler definitions using the installed TypeScript compiler, removes imports and lifecycle startup, and injects mock Trigger/core/thread dependencies. Cards use the real installed JSX and Slack renderer. The callback durability probe uses the real installed ActionRegistry, MemoryStore, and actual ApprovalCard. No listener or database is started and no network is accessed. Assertions marked `reproduced` confirm defects in this revision; they are review reproductions, not desired-behavior regression tests.

| Priority | Finding and exact source | Reproduction and impact | Recommended correction |
|---|---|---|---|
| P1 | `errorCard` asserts “Nothing was sent,” `src/channel/listener.tsx:136`–140; the same catch covers commit and later `runJob`, lines 190–234. | Mock commit returns a verified receipt, then the follow-on Trigger request fails. Slack renders “Committed” followed by “Nothing was sent.” A successful send is denied by the UI, encouraging confusing recovery. | Separate commit outcome from presentation/continuation failure. After an error, reread the ledger and report “Sent; continuation interrupted” or “Outcome unverified.” A missing receipt alone cannot establish that nothing happened. |
| P1 | Requests of at most 80 trimmed characters are replaced with the customer-success fixture, line 279. | “Review Acme's outage. Do not email anyone.” is sent to the planner as the Northwind fixture. The card has no source-mode label. | Make fixture/demo mode explicit. Use supplied text and managed history; if unavailable, show that limitation or request context. Length must not choose the customer or erase a prohibition. |
| P1 | `runJob` only recognizes pending approval, failed, blocked, and rejected states before calling everything else “Finished,” lines 171–182. | A work order with a `waiting_human` step and `outcome_unknown` ledger row gets “Finished” after a successful worker return. `pendingApproval` intentionally excludes unknown outcomes (`src/core/index.ts:237`). | Define business completion as every step being done/committed, then render unknown outcome and incomplete states explicitly. Recovery must continue to show uncertainty until reconciled. |
| P2 | The `result.reused` branch returns before triggering continuation, lines 191–199. | A reused or reconciled receipt produces zero follow-on triggers even with remaining steps. If the listener died after sending but before scheduling the next phase, clicking again leaves the remaining work idle. | Reused receipt should still resume unfinished downstream work, or display an explicit resume control. Deduplication of the effect must not suppress recovery of the workflow. |
| P2 | Approval body is placed in one unbounded section, lines 102 and 113–115. | A 15,000-character body becomes a 3,000-character rendered section, with no link to the complete draft. The actual approved body exceeds what the person could review in the card. | Bound previews deliberately and expose the complete immutable proposal before approval. Show subject, recipients, attachments, and other material arguments as well as body. |
| P2 | Named components are registered but no store is configured, lines 264–268. | A new ActionRegistry can dispatch the real card with the retained MemoryStore; a new MemoryStore yields `channel_action_expired`. Registration alone does not survive listener process loss. | Add a durable Channels StateStore, or narrow the demo claim to worker-only recovery and make old-card recovery depend explicitly on re-mentioning. The comment at line 96 overstates registration's guarantee. |
| Policy decision | Approvers always include the mentioning user plus `APPROVERS`, line 281. | With `APPROVERS=U_OWNER`, requester `U_REQUESTER` is added and can approve their own request. | Decide explicitly whether requester self-approval is the intended product policy. If the env list is an administrative allowlist, do not augment it from mention identity. Current behavior is an implemented lane decision, not an outsider bypass of the core list. |

The harness also confirms that a core `NotAuthorizedError` becomes a “Not authorized” card and does not schedule follow-on work. This verifies handler behavior with an injected core result, not Slack webhook authentication or a real second-user click.

## Other source-backed gaps

- `Thread.getMessages()` exists in the installed SDK and [official Thread reference](https://docs.copilotkit.ai/reference/channels/classes/Thread), even though an inbound mention only includes its own text. History can be unavailable; the right behavior is to detect that, not equate mention text with all retrievable history. Test a constraint in an earlier message explicitly.
- `outboxRows().length` is displayed as “message(s)” at lines 182, 197, 207, 216, and 303. This counts all work orders and all stub tool kinds. The inherited demo itself has one email plus one CRM artifact. Show per-work-order counts by tool and receipt instead of calling every outbox row a sent message.
- A model/tool exception, denied-after-send race, or observer error can reach the same generic false “Nothing was sent” message. Use ledger-based outcomes consistently for approval, denial, and mention handlers.
- Work order IDs persist per Slack thread. New context or constraints supplied in later messages do not update an existing work order. Add an explicit proposal revision path that invalidates prior approval; do not quietly rewrite already-approved arguments.
- No active Trigger attempt is persisted before the subscription. Repeated distinct mentions and recovery after delivery loss need business-level deduplication and status semantics, even though managed admission constrains overlapping same-conversation deliveries. A status query should not cause an extra task run.
- `STATE_DIR` and SQLite are local (`src/core/state.ts:14`, `src/core/db.ts:8`). Listener and Trigger dev worker can share one machine; independent cloud workers cannot see listener-created local files automatically. Shared durable storage is required before claiming multi-host deployment.
- The listener logs readiness once at lines 353–363, and the HTTP server may start even if setup is incomplete. Track gateway readiness, worker availability, state availability, and observer connectivity separately. A running HTTP port is not evidence that Slack is online.
- The worker-only phase correctly ends before human input, but one managed delivery remains occupied while `runJob` watches the worker. Do not extend it over a long human wait. The installed transport seals Thread operations after handler return (`node_modules/@copilotkit/channels-intelligence/dist/delivery-transport.js:280`, `:750`), and defaults to eight execution slots at line 13. Those are implementation details to measure, not a capacity guarantee. [StoreConfig](https://docs.copilotkit.ai/reference/channels/types/StoreConfig) explains the separate managed admission and SDK concurrency behaviors.

The action uses provider `ctx.actor.id`, which is the right source for a Slack user allowlist. The installed registry restores the bound action value, so a naive forged-button-value claim is not established. Still bind work-order access to authenticated platform/workspace/thread scope when adding a web API. In the core, committed receipt replay returns before actor authorization (`src/core/index.ts:319`–323); decide whether receipt disclosure requires authorization independently of send authorization.

## Slack UI recommendation

Keep Slack focused on reviewing and authorizing a specific world-changing action. Use a companion observer for detailed execution evidence. A useful first screen is:

```text
Approval required · Northwind customer update
Send 1 email to ops@example.test
Subject: Your incident update

Constraints: no credit promise · due 17:00 PT
Draft: [bounded excerpt; full immutable draft available]

Work completed 3/4   Approval pending   External receipts 0
[Approve this draft] [Stop work] [View evidence]
```

Show proposal identity/version and all material arguments. Do not derive approvers from the model. Update the originating card after a decision when possible, but keep recovery independent of that presentation update. A repeated click should say “Existing receipt returned,” and resume any unfinished work.

Render “Approved; send pending,” “Sent; receipt …,” “Stopped,” and “Outcome unknown; reconcile” as distinct states. A Trigger run completing or a tool-call event ending must never substitute for an external receipt.

Use words and status icons because managed Slack ignores `Message.accent`; the [Message reference](https://docs.copilotkit.ai/reference/channels/components/Message) documents that. The direct local renderer preserves accent, so an offline render does not prove the managed connector displays it. Slack limits section text to 3,000 characters; see [section block](https://docs.slack.dev/reference/block-kit/blocks/section-block/).

Registered component props must remain serializable and old-card recovery needs persisted snapshots. Actor identity and callback semantics are documented in [JSX callbacks](https://docs.copilotkit.ai/reference/channels/types/JSXCallbacks). The live manifest must also have working Interactivity.

Do not promise modal editing or token-by-token Slack streaming with the current managed path. Direct adapters have additional capabilities and bring provider-connection responsibilities; managed streaming buffers before posting. See [direct provider adapters](https://docs.copilotkit.ai/reference/channels/sdk/direct-adapters). The proactive approver DM in D15 is not implemented; the current listener only posts through Thread handles delivered to it.

## AG-UI: useful as an observation protocol

AG-UI can expose this existing core without adding an agent framework. Implement a small adapter that reads durable facts and emits a UI event stream; keep the committer as the only side-effect authority. [AG-UI architecture](https://docs.ag-ui.com/concepts/architecture) describes a transport-independent event interface and the HTTP client path.

| Durable fact | Proposed observation |
|---|---|
| Execution attempt starts | `RUN_STARTED`; stable work-order ID and separate attempt ID |
| Current work order / ledger projection | `STATE_SNAPSHOT` on connect; `STATE_DELTA` or another snapshot after durable changes |
| Reversible phase begins/ends | `STEP_STARTED` / `STEP_FINISHED`; reused outputs clearly marked on resume |
| A proposal awaits review | `CUSTOM durable.approval_requested`; decision lane changes while receipts remain unchanged |
| Provider attempt begins | Attempt recorded, “sending,” without a success claim |
| Verified external ID recorded | Receipt lane advances from ledger evidence |
| Observer disconnects | Connection indicator changes; work state is preserved until authoritative refresh |

These are proposed mappings. The event families are specified in [AG-UI events](https://docs.ag-ui.com/concepts/events) and snapshot/delta semantics in [state management](https://docs.ag-ui.com/concepts/state). Six representative observer events validate against installed `@ag-ui/core@0.0.59` in the review script. That proves schema compatibility, not an integrated AG-UI server or UI.

Persist an event sequence with work-order ID, attempt ID, step ID, timestamp, event type, payload version, and redacted evidence. Write a business mutation and its audit event in the same transaction. Reconnect by cursor or current snapshot; connecting a viewer must never rerun work. A missing event sequence should trigger snapshot reconciliation rather than inventing a transition.

Add model-call provenance: purpose (`plan_steps` / `extract_constraints`), requested model, returned model/provider when available, request ID, duration, tokens, error, and fallback mode. Display “live result,” “fixture fallback,” and “reused persisted result.” Evidence and short task summaries are sufficient; private model reasoning is unnecessary.

The browser's AG-UI state must not authorize `mail.send`. Approvals should call an authenticated backend command with server-derived actor identity, proposal version, and the same core gate. A replayed event, reconnect, state patch, or crafted tool result must not acquire send authority.

Native AG-UI interrupts are not automatically portable to managed Channels. CopilotKit documents a specific `on_interrupt` → post → return → later resume route and requires backend-specific provider verification. The existing direct core callback is a sensible integration for this custom worker. See [Slack interactive approvals](https://docs.copilotkit.ai/slack/interactive).

For the first useful observer, Trigger metadata plus scoped realtime subscriptions may be faster than the complete adapter. The ledger projection still supplies approvals and receipts. See [Trigger realtime](https://trigger.dev/docs/realtime/overview) and [backend subscriptions](https://trigger.dev/docs/realtime/backend/overview). Use run-scoped public tokens in a browser, never a server secret; expose only intended observation data.

## Demo sequence and innovation

Show three lanes: **Work**, **Decision**, **Receipt**. Keep one stable work order visible while execution attempts come and go. Let the audience choose the worker failure point. After interruption, completed work remains; resuming highlights skipped steps. An unauthorized click changes none of the lanes. The named approver advances Decision, then a verified external ID advances Receipt. Replaying the old approval keeps the receipt count unchanged while remaining work can continue.

The most informative added beat is the provider-accept/ledger-write window. The local outbox artifact exists before the receipt is recorded. Recovery finds its exact marker and attaches the receipt without another send. Label the provider as a local stub and describe the design as at-least-once with deduplication and reconciliation.

Additional demonstrations: reconnect the viewer during approval; compare fresh and resumed attempt logs; run a different dataset case with explicit provenance; show an unavailable model without presenting fallback content as the supplied customer's plan; reveal an actual classifier disagreement being forced to commit. `classifiedBy: allowlist_override` also labels model agreement (`src/agent/plan.ts:80`), so it alone does not prove the model was overruled.

## Verification matrix

| Case | Evidence required | Current review result |
|---|---|---|
| Normal live Slack sequence | Mention → planner → same work order → approval → receipt → next approval | Reported in lane-B handoff, not rerun here |
| Provider send then continuation fails | Receipt remains visible; continuation error does not negate send | Defect reproduced offline |
| Reconciled/reused approval | Same receipt, downstream incomplete phase resumes | Defect reproduced: no trigger |
| Short custom request | Actual customer and constraints reach planner | Defect reproduced: Acme replaced by Northwind |
| Earlier-thread constraint | History retrieved or explicitly unavailable; constraint preserved | Needs dedicated-provider test |
| Unknown provider outcome | Uncertainty stays visible, no Finished state | Defect reproduced offline |
| Configured approver boundary | Intended requester-vs-admin policy applied | Requester augmentation reproduced; product policy decision |
| Unauthorized click | Real outsider refused; no effect/continuation | Error-card rendering passes with mocked core rejection; real second-user test pending |
| Duplicate click and deny | Correct receipt/blocked states, accurate counts | Core lane tests separate; Slack duplicate success inherited; Slack deny pending |
| Worker kill/resume | Listener remains live; completed work skipped; no repeated effect | Requires isolated live worker test; not performed here |
| Listener restart with old card | Persisted callback restores against current proposal | Actual SDK reconstruction passes with retained store; fresh MemoryStore expires action |
| Complete approval content | Full immutable body and arguments reviewable | Actual card truncates 15k body to 3k, no full link |
| Model-call visibility | Request purpose/ID, provider/model, fallback, work-order correlation | Missing durable provenance |
| AG-UI adapter | Typed events, reconnect cursor, no re-execution, authenticated observation | Six event shapes pass; server/UI not implemented in this lane |
| Observer connection loss | Connection state separate from job state | Proposed; parent observer is independently owned |
| Multiple work orders | Per-work-order receipt count by tool | Current Slack counts global outbox rows |
| Multi-host worker | Shared durable state accessible across separate filesystems | Local-file limitation identified |

All eight offline probe groups pass as review assertions. They are not a claim that the identified defects are fixed. Before recording, repeat the dedicated Slack/Trigger checks on the latest synchronized commit and record that commit alongside the evidence. The parent owns final synchronization and the shared decision/changelog entries.
