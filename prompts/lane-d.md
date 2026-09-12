You are lane D of a four-way parallel hackathon build. Hard stop 15:30, merge at 15:05.

Repo: ~/Documents/Develop/durable-coworker

First, in this order:
  git checkout lane/d-ambiguous-doc
  read CLAUDE.md, LANES.md, PRD.md sections 7/10, DECISIONS.md D5 and D13,
  and src/core/contract.ts

You own `src/mirror/**` and `notes/lane-d.md`. NOTHING ELSE.

Needs `AMBIGUOUS_API_KEY` in .env, minted with `npx ambiguous auth signup`. Do NOT use
the shared workspace from the docs page: it resets weekly and would put strangers'
documents in the screen recording (D13). If the key is absent, say so immediately and
build against the local fallback below.

## Your job: the work order, visible on screen while the process dies

Ambiguous over HTTP MCP at `https://app.ambiguous.ai/mcp`, bearer token. Export:

  `mirror(wo: WorkOrder): Promise<void>`

It renders the work order as a document: id, scenario, constraints, the step list with
status per step, and the ledger entries with their status and externalId. Called after
every state change, so it must be cheap and idempotent on the same document.

## The one rule that cannot bend (D5)

SQLite is truth. The doc is a mirror for the camera. **`mirror()` must never throw into
the caller and must never be awaited on a path that could block a commit.** Catch
everything, log, return. A network blip during filming must not become a correctness bug
on video. If you find yourself making the doc authoritative for anything, stop.

## Why it earns its place

This is what is on screen when the worker is killed. The reviewer sees the work order
sitting there with steps 1 to 4 done and step 5 waiting on a human, while the process
that produced it is gone. That image is the whole pitch. Optimise the layout for being
legible in a 2 minute video at whatever zoom a laptop screen recording gives you: few
lines, big structure, status words not icons.

## No-key fallback

If the key is missing or the MCP endpoint does not cooperate within 15 minutes, write the
same rendering to `state/workorder.md` and stop. A markdown file open in an editor beside
the terminal is a perfectly good camera target and costs nothing. Say so in your notes
and move on. Do not spend the back half of the window fighting an integration.

## Done means

`npm run typecheck` clean, committed in small commits, `notes/lane-d.md` written, and
`git diff --name-only f8fa75e...HEAD` shows only src/mirror/ and notes/.
