# Remaining work at `014ecc8`

Checked 2026-09-12 16:15 after pulling PR #8 and #9. `npm run verify` 11 / 11 pass.

## Blocks a live Slack demo

- [ ] Set `DATASET_SLACK_USERS` in `.env` (two distinct real Slack IDs for `U_MAYA`, `U_LEO`).
- [ ] Rehearse the hardened listener live once: `take this THREAD-ACME-OUTAGE` through
      approve and retry. Nothing after PR #8/#9 has run through Slack.
- [ ] Explain or reproduce the 15:02 take where the worker never claimed the job.
- [ ] Second Slack account for the non-approver click beat.
- [ ] Ambiguous doc on screen during a kill; confirm the key is a dedicated workspace.

## Slack UI polish (from `notes/review-live-slack.md`)

- [ ] Plain-language step names instead of `done` / `reversible` / raw ids.
- [ ] Summary line: work N/M, approval state, receipts by tool.
- [ ] Replace buttons on decided cards with the recorded outcome.
- [ ] Bounded body preview plus a way to view the full frozen proposal.

## Known edge-case failures (diagnostic probes)

- [ ] Lease expiry while a provider call is still in flight can send twice.
- [ ] Direct-core duplicate or separator step ids alias a ledger row.
- [ ] Quoted marker in another action counts as a receipt.
- [ ] Torn JSONL outbox tail hides the next artifact.
- [ ] Unregistered reversible tool recorded as done.
- [ ] Concurrent runners execute a reversible step twice.
- [ ] Mirror: 6 strict probe failures (endpoint/protocol handling, cross-process doc uniqueness).

## Submission

- [ ] Review `SUBMISSION.md`, `DEMO.md`, `SOCIAL.md`.
- [ ] Record video (CLI fallback take is ready now; Slack take after rehearsal).
- [ ] Post description, video, social post. Repo is already public.
