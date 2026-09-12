---
description: Pre-submission check. Run at 15:00, not 15:25.
---

Verify the submission is complete and honest. Report pass or fail per item, do not fix
anything unless asked.

## The two beats that must work

- [ ] Kill the worker mid-run, restart, resume at the correct step, no duplicated work
- [ ] Retry a committed send, outbox still has exactly one row

If either fails, stop and report. Nothing else matters.

## Artifacts

- [ ] Public GitHub repo, pushed, readable without auth
- [ ] Two-minute video recorded, shows the ledger row and idempotency key on screen
- [ ] Written description: leads with the stance, not the mechanism
- [ ] Social post drafted, tags the sponsors

## Honesty pass over the README and description

- [ ] No "exactly-once" claim anywhere. It is at-least-once with a dedupe ledger.
- [ ] No statistics we cannot source
- [ ] States plainly that human-in-the-loop pausing exists in the Channels starter, and
      that our contribution is what happens when the pause is interrupted
- [ ] The at-least-once window is described, not hidden
- [ ] No sponsor mapping table
- [ ] "What we did not build" section matches the cuts recorded in CHANGELOG.md

## Framing check

Read the title and first two lines as a reviewer who has thirty seconds and has already
seen forty submissions. Does it say what is new, or does it say "durable execution"?

The stance is: the agent never holds the send button.
