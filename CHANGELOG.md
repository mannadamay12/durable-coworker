# Changelog

Append a line when a milestone lands or a cut gets made. Newest at the top.
Keep entries short enough to skim at 15:00 when writing the submission description.

Format: `HH:MM — what changed — what it unblocks or what it cost`

---

## Build day

- `14:54` — main at `54afa04` holds all four lanes: typecheck clean, `src/core/kill.test.ts` 10/10 pass (kill mid-run, resume, non-approver rejected, retry reuses receipt, landed-but-unrecorded send reconciled, deny blocks) — integration next: nothing calls `mirror` from the job or listener yet
- `14:50` — Lane D merged (#5): `mirror(wo)` writes `state/workorder.md` and upserts one Ambiguous doc per work order; check passed on the live key at 14:47, including invalid key not reaching the caller (D29) — doc visible on screen once wired in
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
- [x] Model call made — OpenRouter replaces `OPENAI_API_KEY` (D22); lane C test passed on the live model with a funded key
- [ ] Ambiguous key minted via `npx ambiguous auth signup` (not the shared demo workspace) — `AMBIGUOUS_API_KEY` works live (lane D check 14:47); whether it is a dedicated workspace not verified
- [x] Smoke test passes: worker killed, re-triggered, resumes at the right step, Slack bot still alive — 13:50, verified from listener log and state file; cards in Slack not yet eyeballed
- [x] `npm run reset` works
- [x] Kill test dull against stubs — 14:54 on main, 10/10 pass
- [ ] Authorization: non-approver click rejected — rejected in core kill test; live Slack click not verified (needs a second Slack user)
- [ ] Injection beat: seeded thread message does not move a step — lane C test forces `mail.send` to commit on the injected thread; not run through Slack
- [ ] Ambiguous doc visible on screen during a kill — mirror merged but not called from the job or listener
- [ ] Video recorded
- [ ] Public repo, description, video, social post submitted

---

## Cuts made

Record anything dropped and when, so the README's "what we did not build" section is
honest rather than reconstructed from memory.

- `13:31` — Not a cut, a correction: the runId cannot be the Slack `thread_ts` (Channels
  does not expose it) and cannot be a Trigger.dev run id (no such option). Hashed
  `conversationKey` in the payload instead. See D17 and D18. Cost: nothing functional.
