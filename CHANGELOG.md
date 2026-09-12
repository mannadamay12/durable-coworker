# Changelog

Append a line when a milestone lands or a cut gets made. Newest at the top.
Keep entries short enough to skim at 15:00 when writing the submission description.

Format: `HH:MM — what changed — what it unblocks or what it cost`

---

## Build day

- `15:36` — Added recovery hardening after the merged Slack/mirror review: authoritative receipt returns, explicit planner validation/stub mode, unknown-outcome-safe Slack cards and continuation coalescing, mirror failure isolation and local-first snapshots; focused core/planner/mirror regressions pass — PR ready with remaining diagnostic failures documented
- `15:20` — Reviewed uncommitted main fixes after PR #6 with three parallel reviewers; core probes improve to 9 pass / 7 fail and offline planner to 5 / 14; typecheck and original checks pass — remaining delta findings and new Slack/mirror checks recorded in `notes/review-main-delta.md`
- `15:18` — Correctness pass: planner step ids sanitised (D30), `outcome_unknown` shown as pending not Finished and cannot overwrite a receipt (D31), stub customer now matches the scenario thread, mirror wired into the job (1s tick) and listener commit/deny (D32), Slack cards show full To/Subject/body, per-work-order receipt count, Queued notice after 10s, Paused vs Finished — typecheck clean, kill test 10/10, mirror check pass; not run live through Slack
- `15:11` — Synced review branch with local main `6cb8c6a` after pulling; preserved D23–D29 and separated passing baseline gates from failing edge-case probes; typecheck and 13 kill-matcher checks pass — review package prepared for PR and parallel implementation
- `15:04` — With explicit user authorization, interacted with Angie in native Slack and captured real UI; new Acme test reached Starting with a persisted two-step plan, but both steps remained pending and no tool/ledger activity was recorded — live initial-card verification added in `notes/review-live-slack.md`; worker completion and new approval unverified
- `14:54` — Pulled and reviewed `54afa04`, including the new standalone document mirror; worker/listener still have no mirror calls and rendered document omits draft outputs — integration and verification plan updated for the latest merge
- `14:54` — main at `54afa04` holds all four lanes: typecheck clean, `src/core/kill.test.ts` 10/10 pass (kill mid-run, resume, non-approver rejected, retry reuses receipt, landed-but-unrecorded send reconciled, deny blocks) — integration next: nothing calls `mirror` from the job or listener yet
- `14:50` — Lane D merged (#5): `mirror(wo)` writes `state/workorder.md` and upserts one Ambiguous doc per work order; check passed on the live key at 14:47, including invalid key not reaching the caller (D29) — doc visible on screen once wired in
- `14:49` — Three-agent review refreshed through `c564f70`; existing tests pass, but isolated core probes reproduce 9 failures and planner/data probes 16 failed checks (several share one fallback defect); Slack handler probes reproduce false completion/send messages — prioritized fixes and exact repros in `notes/demo-review.md`; review is not a correctness sign-off
- `14:48` — Added read-only evidence viewer and six-checkpoint local kill/approval/retry replay; desktop/mobile browser checks pass — persisted progress, decisions, receipts and separate captured model calls can be inspected together
- `14:46` — Four real OpenRouter responses across two scenarios, no fallback; 7 content/safety checks pass and 3 fail because tools use fixed customer data; six attributed BANKING77 utterances added — reproducible data-grounding review without external sends
- `14:45` — Read-only Ambiguous discovery succeeds and advertises native `send_email` idempotency; D23 updates D9's premise — real adapter can use provider keys after acceptance tests; no provider tool executed
- `14:32` — Lane B merged (#4): Slack approval card, commit and deny; live run 14:27 committed the email and CRM update once each, a second Approve on the send returned the existing receipt with nothing sent — non-approver click, Slack deny, and kill during a Slack run not verified live
- `14:22` — Lane C merged (#2): `plan()` plus `enforceCommitTools`; assertion script passes on the live OpenRouter model with a funded key; stub fallback logs `Classifier stubbed, override real.` (D27) — the injected-thread OVERRIDE beat comes from the hand-built case, the live model kept `mail.send` as commit itself
- `14:18` — Lane A merged (#3): core, ledger, committer, stubbed outbox, `workorder` Trigger.dev task, `cli.ts`, kill test; `node:sqlite` instead of `better-sqlite3` (D25) — every other lane can call core
- `13:50` — Smoke test PASSED live: mention started `c065c92cc2f9`, worker killed after step 3 (listener untouched), run CANCELED with `[1,2,3]` kept, worker restarted, re-mention in the same thread logged `RESUME (prior: 1,2,3)` and finished `[1,2,3,4,5]` in 2s vs 5s fresh — kill and resume proven; feature work unblocked
- `13:47` — Fixed closing cards never posting: the listener posted after the mention handler returned, when Channels has already sealed the delivery (`no longer accepts Thread operations`). Handler now awaits the run watch (D21) — Finished and Interrupted cards reach Slack
- `13:44` — First live take failed: `step N/5` lines never appear in `trigger dev` output (task `logger` goes to the dashboard), so the kill never fired and the run finished; closing card also failed — kill now keyed on `state/<runId>.json` instead
- `13:42` — `node_modules` had been installed on Linux (esbuild wrong-platform binary); reinstalled with `npm ci` on macOS; dev CLI logged in — both processes start
- `13:31` — Smoke test green on static checks: typecheck clean, 13/13 kill-matcher cases pass — Slack→Trigger→kill→resume path is wired and ready for the live run; branch `smoke/slack-trigger-kill-resume`
- `13:05` — Verified both SDKs against installed packages rather than docs: `agent` is optional on `createChannel` (no model needed for the smoke test), `onMention` and `thread.conversationKey` exist, `runs.subscribeToRun` exists — unblocked the listener without guessing API shapes
- `--:--` — Repo scaffolded: CLAUDE.md, PRD.md, DECISIONS.md, CHANGELOG.md, .claude commands — working agreement is fixed, build can start

---

## Gates, tick these off

- [x] `node -v` reports 22 or later (22.23.2)
- [x] `CPK_INTELLIGENCE_API_KEY` and `CHANNEL_CODE` obtained, Channel `angie` configured
- [x] `TRIGGER_SECRET_KEY` + project ref `proj_rghkywrsmyalnxjbareu` in `trigger.config.ts`
- [x] `npx trigger.dev@latest login` run — REQUIRED, the secret key does not auth the dev CLI
- [x] OpenRouter model path verified (D22); lane C passed on the live model and four real review responses have provenance and usage saved under `notes/`
- [ ] Ambiguous key minted via `npx ambiguous auth signup` (not the shared demo workspace) — `AMBIGUOUS_API_KEY` works live (lane D check 14:47); whether it is a dedicated workspace not verified
- [x] Smoke test passes: worker killed, re-triggered, resumes at the right step, Slack bot still alive — 13:50, verified from listener log and state file; cards from that take not eyeballed
- [x] `npm run reset` works
- [x] Core kill/resume baseline passes against stubs — 14:54 on main, 10/10 pass
- [ ] Durability edge cases pass — isolated review reproduces 9 failed checks, including slow attempts and corrupt artifacts; baseline success does not cover these cases
- [ ] Authorization: non-approver click rejected — rejected in core kill test; live Slack click not verified (needs a second Slack user)
- [ ] Injection beat: seeded thread message does not move a step — lane C test forces `mail.send` to commit on the injected thread; not run through Slack
- [ ] Ambiguous doc visible on screen during a kill — mirror now called from the job (1s) and listener at 15:18; not verified live
- [ ] Video recorded
- [ ] Public repo, description, video, social post submitted

---

## Cuts made

Record anything dropped and when, so the README's "what we did not build" section is
honest rather than reconstructed from memory.

- `13:31` — Not a cut, a correction: the runId cannot be the Slack `thread_ts` (Channels
  does not expose it) and cannot be a Trigger.dev run id (no such option). Hashed
  `conversationKey` in the payload instead. See D17 and D18. Cost: nothing functional.
- `15:18` — AG-UI companion viewer cut (D33). Queued/Running is logged, not shown as a live-edited card; only a Queued notice after 10s is posted. The stuck-pending worker was not reproduced, only surfaced.
