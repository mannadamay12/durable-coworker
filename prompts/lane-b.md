You are lane B of a four-way parallel hackathon build. Hard stop 15:30, merge at 15:05.

Repo: ~/Documents/Develop/durable-coworker

First, in this order:
  git checkout lane/b-approval-card
  read CLAUDE.md, LANES.md, PRD.md sections 5/7/8, and src/core/contract.ts

You own `src/channel/**` and `notes/lane-b.md`. NOTHING ELSE. Other agents are editing
other directories right now; touching their files costs the team the merge.

## Your job: the Slack approval surface and authorization

`src/channel/listener.tsx` already works end to end for a smoke task (mention starts a
Trigger.dev job, kill and resume proven). Replace the smoke behaviour with the real one.

On @mention:
1. `runId`/`threadRef` = sha256(thread.conversationKey).slice(0,12). See D17: Channels
   does not expose Slack thread_ts. Do not go looking for it.
2. `findWorkOrder` / `createWorkOrder` from `src/core/index.js`. Approvers are Slack user
   IDs seeded from `message.actor.id` at creation, plus anything in an optional
   `APPROVERS` env var (comma separated). Approvers are authorization, not decoration.
3. Trigger the job, await the run (see D21 below), then post a card showing the step list
   with status per step.
4. If `pendingApproval(wo)` returns a step, post an approval card: the step, the drafted
   output, the extracted constraints as chips, and Approve / Deny buttons.

On Approve click:
- call `commit(woId, stepId, actor)` where actor is the clicking user's `actor.id`
- `NotAuthorizedError` -> post a card naming who *can* approve. Anyone can click. Only an
  approver moves a step. This rejection is a demo beat, make it legible.
- success -> post a receipt card with the `externalId`
- `result.reused === true` -> the card must say already committed and show the same
  externalId. This is the single most important beat in the video after the kill. A
  second click must never produce a second send.

On Deny click: `deny(...)`, then a card reading "Stopped by <user>. <woId> blocked at
<stepId>." No silent continuation.

## Traps already paid for, do not rediscover

- **D21.** A `Thread` is writable ONLY while its delivery is open. The delivery seals the
  moment your handler returns, and any later `thread.post` throws
  `ChannelDeliveryOperationsClosedError`. So: stay inside the handler until you have
  posted. A button click arrives as its OWN new delivery with a fresh writable thread, so
  the commit path posts from inside the click handler. Do not try to post from the
  Trigger.dev task; it has no Slack connection.
- Register every card component in `createChannel({ components })`. That is what lets a
  click rebind its handler.
- `thread.awaitChoice()` deadlocks on managed Slack (`supportsBlockingChoice` is false).
  Post and return; the click comes back separately.
- Managed Slack has no slash commands and no modal submissions. Do not design around a
  modal.
- Inbound `message.ref.id` can be `""`. Guard before `thread.update`.
- Components come from `@copilotkit/channels/ui`: Message (accent prop), Header, Section,
  Markdown, Field, Fields, Context, Actions, Button (style primary/danger), Divider.
  tsconfig already has the right jsxImportSource.

## If core is not ready yet

`src/core/index.ts` functions throw "not implemented (lane A)". That is expected. Code
against the signatures, and render the thrown error as a visible card rather than
crashing the listener. Lane A lands before the merge.

## Done means

`npm run typecheck` clean, committed in small commits, `notes/lane-b.md` written with
anything you cut or discovered, and `git diff --name-only f8fa75e...HEAD` shows only
files under src/channel/ and notes/.

Do not refactor anything outside your lane. There is no time and no second commit.
