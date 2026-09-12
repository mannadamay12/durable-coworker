# Parallel lanes, 14:00 to 15:05

Four branches off `contract/frozen-seam`. Merge window 15:05 to 15:15. Video 15:15.

## The rule that makes this work

**Own only your files. Touch nothing else.** A conflict at 15:10 costs more than the
feature you were building.

| Lane | Owns, exclusively | Branch |
|---|---|---|
| A core | `src/core/**` (not contract.ts), `src/tools/**`, `src/trigger/**`, `src/cli.ts` | `lane/a-core-committer` |
| B slack | `src/channel/**` | `lane/b-approval-card` |
| C agent | `src/agent/**`, `scenarios/**` | `lane/c-planner` |
| D mirror | `src/mirror/**` | `lane/d-ambiguous-doc` |

## Nobody edits these

`src/core/contract.ts` (frozen), `src/core/index.ts` signatures (lane A fills bodies
only), `package.json`, `package-lock.json`, `.env`, `trigger.config.ts`,
`DECISIONS.md`, `CHANGELOG.md`, `CLAUDE.md`, `PRD.md`, `SMOKE.md`, `LANES.md`.

Every dependency any lane needs is already installed: `openai`, `better-sqlite3`,
`@types/better-sqlite3`, plus the Channels and Trigger.dev packages. If you think you
need another one, you are solving the wrong problem.

## Instead of editing the shared docs

Write `notes/<your-lane>.md`. One file per lane, you own it, no conflicts. Put in it:
decisions that constrain others, anything you cut, and anything you discovered that
contradicts the contract. These get merged into DECISIONS.md and CHANGELOG.md at 15:05.

## Definition of done, every lane

1. `npm run typecheck` clean on your branch.
2. Committed. Small commits, not one big one.
3. `notes/<lane>.md` written.
4. You did not modify a file another lane owns: check with
   `git diff --name-only main...HEAD` before your last commit.

## Known traps, already paid for

- **D21:** a `Thread` is writable only while its delivery is open. Any `thread.post`
  after the handler returns throws `ChannelDeliveryOperationsClosedError`. A button
  click arrives as its own new delivery with a fresh writable thread.
- **D18:** Trigger.dev `idempotencyKey` returns the *original* run's handle, and a
  cancelled run keeps its key. Never use it for resume. Logical id in the payload.
- **D17:** Channels does not expose Slack `thread_ts`. Use `thread.conversationKey`.
- Dev runs default to a 10-minute TTL. Pass `ttl: 0`.
- `devWatchdog.js` sits under `.../dist/esm/dev/`. Do not match a bare `dev` segment.
