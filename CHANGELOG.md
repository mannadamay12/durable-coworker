# Changelog

Append a line when a milestone lands or a cut gets made. Newest at the top.
Keep entries short enough to skim at 15:00 when writing the submission description.

Format: `HH:MM — what changed — what it unblocks or what it cost`

---

## Build day

- `--:--` — Repo scaffolded: CLAUDE.md, PRD.md, DECISIONS.md, CHANGELOG.md, .claude commands — working agreement is fixed, build can start

---

## Gates, tick these off

- [ ] `node -v` reports 22 or later
- [ ] `INTELLIGENCE_API_KEY` and `CHANNEL_CODE` obtained, Channel configured
- [ ] `TRIGGER_SECRET_KEY` obtained, `npx trigger.dev@latest init` run
- [ ] `OPENAI_API_KEY` present, one successful call made
- [ ] Ambiguous key minted via `npx ambiguous auth signup` (not the shared demo workspace)
- [ ] Smoke test passes: worker killed, re-triggered, resumes at the right step, Slack bot still alive
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
