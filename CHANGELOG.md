# Changelog

Append a line when a milestone lands or a cut gets made. Newest at the top.
Keep entries short enough to skim at 15:00 when writing the submission description.

Format: `HH:MM — what changed — what it unblocks or what it cost`

---

## Build day

- `13:31` — Smoke test green on static checks: typecheck clean, 13/13 kill-matcher cases pass — Slack→Trigger→kill→resume path is wired and ready for the live run; branch `smoke/slack-trigger-kill-resume`
- `13:05` — Verified both SDKs against installed packages rather than docs: `agent` is optional on `createChannel` (no model needed for the smoke test), `onMention` and `thread.conversationKey` exist, `runs.subscribeToRun` exists — unblocked the listener without guessing API shapes
- `--:--` — Repo scaffolded: CLAUDE.md, PRD.md, DECISIONS.md, CHANGELOG.md, .claude commands — working agreement is fixed, build can start

---

## Gates, tick these off

- [x] `node -v` reports 22 or later (22.23.2)
- [x] `CPK_INTELLIGENCE_API_KEY` and `CHANNEL_CODE` obtained, Channel `angie` configured
- [x] `TRIGGER_SECRET_KEY` + project ref `proj_rghkywrsmyalnxjbareu` in `trigger.config.ts`
- [ ] `npx trigger.dev@latest login` run — REQUIRED, the secret key does not auth the dev CLI
- [ ] `OPENAI_API_KEY` present, one successful call made
- [ ] Ambiguous key minted via `npx ambiguous auth signup` (not the shared demo workspace)
- [ ] Smoke test passes: worker killed, re-triggered, resumes at the right step, Slack bot still alive — code ready, live run pending (see SMOKE.md)
- [ ] `npm run reset` works
- [ ] Kill test dull against stubs
- [ ] Authorization: non-approver click rejected
- [ ] Injection beat: seeded thread message does not move a step
- [ ] Ambiguous doc visible on screen during a kill
- [ ] Video recorded
- [ ] Public repo, description, video, social post submitted

---

## Cuts made

Record anything dropped and when, so the README's "what we did not build" section is
honest rather than reconstructed from memory.

- `13:31` — Not a cut, a correction: the runId cannot be the Slack `thread_ts` (Channels
  does not expose it) and cannot be a Trigger.dev run id (no such option). Hashed
  `conversationKey` in the payload instead. See D17 and D18. Cost: nothing functional.
