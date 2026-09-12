# Demo and architecture review

Reviewed 2026-09-12 in `codex/demo-architecture-review`, isolated at `/Users/ad12/Documents/Develop/durable-coworker-review`. The baseline moved from `35365f7` through `c564f70` to `54afa04` during review; both approval-card and document-mirror merges were incorporated and reviewed. Three parallel reviewers covered core correctness, Slack/AG-UI, and planner/data/provider integrations. Application source and dependency versions were not changed by this review. Earlier evidence retains the revision at which it was captured; the latest merge only adds `src/mirror/` and its handoff, leaving the tested core/planner/listener unchanged.

**Present this as a coworker whose actions can be accounted for after interruption.** The model proposes a job; stored work, human authority, and provider evidence determine what happens next. The most compelling demonstration lets the audience choose a failure point and then inspect what survived. More agents or more integrations are less valuable than making these guarantees visible and accurate.

The fresh Slack merge is a substantial improvement: it now calls the planner, creates a work order, runs reversible steps through Trigger, posts approval cards, commits from authenticated callback identity, and continues to subsequent steps. The review found important correctness failures beyond the existing happy path. Address those before presenting the same guarantees for real providers.

The latest mirror merge adds an Ambiguous document client, a local Markdown fallback and a component assertion script. It is not yet invoked by the worker/listener. Its existing renderer shows constraints, steps and ledger status but omits draft/research outputs, so it cannot yet support the planned “watch the draft land in the document” beat.

## What is verified

| Layer | Evidence | Result and limit |
|---|---|---|
| Existing build and tests | Typecheck, kill process matcher, core SIGKILL/resume assertion script, stub planner assertions | Pass. The killed process was a child created for this test; active user workers/listener were untouched. |
| Core fault injection | [Core report](review-core.md), [JSON evidence](review-core-results.json) | 7 passing invariants; 9 failing checks. Includes 20 concurrent clicks and 8 independent processes sharing SQLite. Slow/expired attempts reveal a separate duplicate-send race. |
| Dataset and malformed provider responses | [Offline evidence](review-planner-offline-results.json) | 3 pass / 16 fail across 19 desired-behavior checks. Nine cases share the same fixture-fallback defect; these are not 16 independent vulnerabilities. |
| Real model calls | [Live evidence](review-planner-live-results.json) | Four HTTP 200 responses, two scenarios, no fallback; 7 pass / 3 fail on content and safety checks. Requested/returned model `google/gemini-3.8-flash`, reported provider Google AI Studio. |
| Model cost and latency | Same saved response metadata | About 4.03s and 3.78s per parallel plan/extract pair; 3,459 total tokens; provider-reported total cost $0.00922125. These are two observations, not a benchmark. |
| Latest Slack handlers / installed SDK | [Slack review](review-slack-ui.md), `scripts/review-channel.mjs` | Eight successful characterization/protocol probes, several intentionally proving bugs. These are isolated handler checks; lane B documents an earlier live happy path. |
| Live Slack follow-up | [Native UI and persisted state](review-live-slack.md) | Inspected prior receipt/retry cards and sent one authorized Acme test mention. Angie posted Starting and persisted a two-step plan; both steps remained pending at observation. No approval click or new send was tested. |
| AG-UI | Installed `@ag-ui/core` schema validation | Six proposed observer events validate. No AG-UI server was deployed. |
| Ambiguous discovery | [Capability evidence](review-ambiguous-capabilities.json) | Authenticated `initialize` and `tools/list` succeeded, advertising 856 tools. No provider tool was executed. |
| Newly merged mirror | [Mocked-transport evidence](review-mirror-results.json) | 1 pass / 8 failed desired-behavior checks, including multi-work-order limitations. Same-process coalescing works; two processes can create two documents. These are not eight demonstrated production incidents. |
| Evidence viewer | Six recorded checkpoints, localhost HTTP and browser checks | Reads real SQLite/outbox state; replay and live views work at desktop and 375px width, without browser errors. Local stub evidence is explicitly labeled. |
| Dependencies | [Audit snapshot](review-dependency-audit.json) | npm reported 33 affected package entries: 25 moderate, 7 high, 1 critical. These include transitive/dev dependencies; exploitability was not established. |

## Fixes with the highest return

| Priority | Concrete failure | Change and acceptance condition |
|---|---|---|
| P1 | Two identical model step IDs mark mail and CRM committed after only mail ran. Colon-containing IDs can reuse another step's receipt. | Validate unique, bounded IDs at the core boundary; select ledger rows by exact stored identity. Both adversarial ID tests must fail closed. |
| P1 | A slow provider call outlives the 30s claim; another attempt sends again. A late failure can downgrade a committed ledger to `outcome_unknown`. | Add attempt fencing and terminal-state protection. Use provider-native idempotency where supported; an expired timer alone must not authorize a new send. |
| P1 | Slack posts “Committed” and then “Nothing was sent” if the next Trigger operation fails. A pending unknown outcome can be labeled “Finished.” | Derive business status from persisted state; separate commit result, continuation result, and delivery failure. Unknown outcome gets explicit reconciliation status. |
| P1 for a real-use demo | A short Acme request is replaced by the Northwind fixture. Even a correct live plan generates the fixed recipient, draft, and outage timeline. | Make fixture mode explicit. Preserve source context and typed tool inputs through planning and proposal creation; show exact source-to-payload evidence. Never turn provider failure into another customer's plan. |
| P1 before real adapters | Reconciliation accepts a marker quoted in a different tool's artifact. A torn JSONL tail can hide a later complete receipt. | Use structured, exact operation/key/payload identity and an indexed receipt store. Provider adapter tests must cover duplicate key, conflicting payload, accepted-but-timeout, and uncertain search results. |
| P2 | Reconciled/reused approval returns before triggering remaining work. Old buttons expire after a listener restart with the default in-memory store. | A retry should reconcile the receipt and advance unfinished workflow safely. Persist Channels callback snapshots; recover the same proposal after restart. |
| P2 | Request initiator is automatically an approver even when `APPROVERS` lists someone else. Long approval content is truncated. | Choose and label the authorization policy explicitly; fixed-owner mode must exclude unauthorized requesters. Provide all material recipient/subject/body terms before approval. |

Additional reproduced problems: unsupported tools are marked done; two live runners duplicate reversible work; string constraints are accepted and split into characters; empty plans silently complete. Details and exact source locations are in the three specialist reports. The current stubs prevent real email, so these tests did not cause external side effects.

Specialist reports: [core durability](review-core.md), [Slack and AG-UI](review-slack-ui.md), [datasets and integrations](review-datasets-integrations.md).

## The two-minute demonstration

Use Slack beside a three-column evidence view: **Progress / Human decision / Side-effect evidence**. Keep a stable work-order ID visible and display each Trigger attempt separately. The view supplied in this branch already replays real local core behavior.

| Time | Beat | What the viewer should see |
|---|---|---|
| 0:00–0:20 | One grounded customer brief; explicit “do not promise a credit.” | Source, planned work, model-vs-fixture provenance; outbox zero. |
| 0:20–0:40 | Research and draft persist. Audience chooses the interruption point. | Completed steps and their outputs remain in the work order. |
| 0:40–1:00 | Kill only the demo worker; restart/resume. | A new attempt, same work order; completed steps skipped; receipts still zero. |
| 1:00–1:20 | An unauthorized actor tries approval. | Refusal names the actual authorized person; no ledger approval or receipt. |
| 1:20–1:40 | Named approver accepts the exact proposal. | Approval actor followed by a verified receipt; a single matching artifact. |
| 1:40–2:00 | Repeat the original approval. | Same receipt, unchanged artifact count. Final state is reconstructed from storage. |

For a single-send beat, use a deliberately single-commit scenario. The existing planner fixture also includes `crm.update`; approving that produces two total stub artifacts, one of each tool. Count the current work order and tool, not the entire shared outbox, and do not narrate a global count of two as “two emails.”

The provider-accepts-before-ledger-write window is the strongest stretch beat. Inject this deterministically in an isolated adapter test rather than relying on lucky timing. Show “outcome unknown,” then reconcile to the original receipt. The existing local kill test covers an intact landed-but-unrecorded artifact; slow-call and corrupt-artifact variants still fail.

## Innovations grounded in the product

| Idea | Why it helps | Smallest credible version |
|---|---|---|
| Audience-controlled interruption | Demonstrates recoverability under an unexpected interruption. | Pick a stored step checkpoint; kill only that run's owned worker. Expand to provider windows after correctness fixes. |
| Replayable evidence trail | Makes the result inspectable after the live demo, including failures. | Export source hash, plan/proposal revision, actor, attempts, and receipts; replay never invokes tools. This branch supplies a six-checkpoint local version. |
| Approval as a precise change review | Makes human authority meaningful instead of a generic “Approve” button. | Show exact recipient, subject, body, constraints, and proposed external changes. Bind approval to a proposal digest; edits invalidate it. |
| Show deliberate inaction | Proves the safety boundary has product value. | Dataset request says internal draft only; injected “send now” yields no external proposal. Display the real model response and actual tool effects side by side. |
| Same request, model unavailable | Separates durable execution from inference availability. | Resume a saved plan with the provider disconnected. For a new request, visibly block or select an explicit fixture; no silent cross-customer fallback. |
| Provider capability contracts | Makes integration extensible without trusting arbitrary tool descriptions. | Map internal tools to pinned provider names and schemas, risk class, key limits, and reconciliation contract. Reject unsupported actions. |
| Multiple commits with partial completion | Shows generality beyond one email. | Two synthetic commits: stop after the first, resume only the second, then replay both approvals. Offboarding can follow after tool semantics are implemented. |

The BANKING77 sample adds six real support utterances with nine synthetic policy/adversarial wrappers. It currently exposes that tools ignore the task data. It should become a small acceptance corpus once arguments and drafts are grounded, rather than being described as an integrated dataset benchmark. See [dataset provenance and commands](../scenarios/review/README.md).

## AG-UI and the Slack surface

Yes: use AG-UI to project durable state into the browser. Keep Slack's native approval card and backend committer. A model tool event describes an invocation; only stored provider evidence proves an external effect. AG-UI defines run/step events, snapshots, deltas, and custom events that can carry this projection. This is an architectural recommendation, not a capability already implemented here. [AG-UI event definitions](https://docs.ag-ui.com/concepts/events).

Suggested mapping: attempt → `RUN_STARTED`; reversible work → `STEP_STARTED/FINISHED`; reconnect → `STATE_SNAPSHOT`; committed domain change → state delta/custom event; proposal/approval/reconciliation → domain-specific custom event. A completed worker phase with pending approval is not a completed business job. Keep this distinction in both surfaces.

For production, emit domain events in the same transaction as state changes and replay by cursor. Do not stream raw SQL polling or log text indefinitely. The supplied viewer polls for review convenience and is explicitly a prototype. Browser reload, reconnection, or AG-UI state patches must never invoke the committer.

The first Slack screen should show the action and target, all material terms, constraints, actual approvers, and a link to evidence. Use textual statuses: the managed connector does not guarantee accent colors, and long sections are truncated by the installed renderer. Keep a short summary but make the entire immutable proposal accessible before approving. The [Slack section reference](https://docs.slack.dev/reference/block-kit/blocks/section-block/) specifies the 3,000-character text limit.

The current custom handler correctly ends the worker phase at approval. Do not replace it with a long human wait inside a delivery. Named components alone do not persist action snapshots; use a durable Channels store. See the [Channels callback contract](https://docs.copilotkit.ai/reference/channels/types/JSXCallbacks) and the tested findings in [the Slack report](review-slack-ui.md).

## Make routed LLM calls explainable

Current `structuredCall()` returns parsed content and drops response metadata. Persist a call record keyed by `workOrderId`, `planRevision`, `attemptId`, and purpose (`plan_steps` or `extract_constraints`), including start/end time, requested model, actual returned model/provider, generation ID, token/cost metadata, validation result, and fallback reason. Record provenance as `model`, `fixture`, or `reused`; do not infer it from whether a key exists.

OpenRouter routing can legitimately choose a provider for a requested model. Store the returned provider rather than guessing from the model name. Its generation lookup exposes provider, timing, usage, and request identifiers if additional investigation is needed. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation).

The live probe in this branch captures exactly that useful metadata for four real requests. The viewer shows these under **Model probes · separate experiment** so they cannot be mistaken for calls from the local kill replay. Inspectable inputs, decisions and evidence suffice; private model reasoning is not needed.

## Integrations and the path to scale

The configured Ambiguous server is reachable. Its advertised `send_email` tool includes native `Idempotency-Key` / `idempotency_key`, a 255-character maximum, and same-payload reuse versus conflicting-payload rejection. This changes the premise in D9. The repo's internal `mail.send` name needs an explicit adapter to `send_email`; use the provider contract and retain reconciliation as recovery evidence. These semantics were documented and advertised, not tested by sending email. See [capability discovery](review-ambiguous-capabilities.json) and [the provider's documentation index](https://www.ambiguous.ai/llms.txt).

The newly merged `src/mirror/ambiguous.ts` already maps document operations to the actual provider names. This is a document adapter, not a real mail adapter. Connect mirror notifications outside core and keep failures independent of commit truth. Per-process coalescing cannot prevent two processes from creating separate documents for one work order; the map also cannot recover an accepted create whose response was lost. A durable mirror operation record and reconciliation are needed before claiming cross-process mirror uniqueness. Its configured-endpoint behavior and error classification also need explicit tests.

Do not expose all 856 discovered tools to the model. Map a small local allowlist to validated provider operations. A tool called `create_task` is an external mutation even if it is easy to delete later; replay safety and approval policy are separate questions. MCP annotations are hints, not a trusted authority boundary. [MCP tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

The present topology is a same-machine listener and dev worker sharing SQLite and JSONL. It cannot become a distributed deployment merely by giving multiple hosts the same `STATE_DIR` string. Preserve the product boundary while evolving the implementation:

1. **Demo topology:** pin Node/runtime, state directory, scenario and adapter mode; serialize one active workflow attempt and finish the correctness fixes.
2. **Shared transactional storage:** normalize work orders, steps, proposals, approvals, attempts and receipts; include tenant/workspace identity and version checks. Index work-order and receipt lookups. A PostgreSQL implementation is a reasonable next step when listener and workers separate.
3. **Fenced execution:** claim a work order with an attempt ID; reject stale state writes; maintain provider idempotency independently. Retry classes distinguish definitely rejected, confirmed applied, and unknown outcome.
4. **Reliable notifications:** transactionally record outgoing UI/domain events, deliver after commit, retry delivery independently. A Slack outage must neither resend an email nor erase its receipt.
5. **Scale measurement:** stage 1, 10, then 100 concurrent work orders against controlled stubs. Measure queue wait, end-to-end latency, SQLite/DB lock time, active deliveries, reconciliation lag and duplicate artifacts. Derive capacity from those results; eight managed delivery slots are not a product scale claim.

Keep the current small core; do not add an agent orchestration framework to solve storage and provider semantics. For observability integrations, start with correlated structured events and an optional OpenTelemetry exporter. GenAI conventions are evolving; pin the convention version instead of hardcoding whatever an older tutorial used. [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).

The dependency audit warrants targeted updates and retesting, especially network packages and build-tool archive dependencies. Do not apply `npm audit fix --force` indiscriminately: this snapshot suggests a major Trigger downgrade for part of the tree. There was no dependency mutation during review.

## Delivery order

First patch identity validation, terminal receipt protection, unknown-outcome policy, and truthful Slack cards. Next connect actual request data to frozen tool arguments and make fixture provenance explicit. Then persist callbacks, restore continuation after a reused receipt, and implement the narrow provider adapter using its native idempotency contract. Finally add durable event streaming/AG-UI and expand scenarios.

Use [the verification runbook](review-verification.md) for commands and final demo gates. Baseline checks passing does not erase the intentionally failing review probes. This branch leaves those findings visible and adds review tools, fixtures, and evidence; it does not claim the production fixes are implemented.

Follow-up: after explicit Slack authorization, a new live mention reached planning, persistence and the Starting card; the worker had not executed either step at the recorded observation. The prior receipt/retry cards were also directly inspected. See [live Slack UI evidence](review-live-slack.md) for the actual thread links and precise limits of that verification.
