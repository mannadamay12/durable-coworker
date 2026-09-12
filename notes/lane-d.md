# Lane D handoff: work order mirror

## Shipped

- `src/mirror/index.ts`
  - `mirror(wo: WorkOrder): Promise<void>`, never rejects.
  - `mirrorSoon(wo: WorkOrder): void`, fire-and-forget. Commit paths use this.
  - `renderWorkOrder(wo: WorkOrder): string`, re-exported from `render.ts`.
- `src/mirror/ambiguous.ts`: plain-fetch MCP client for `https://app.ambiguous.ai/mcp`
  (stateless, no initialize handshake), plus `upsertDoc`.
- `src/mirror/render.ts`: markdown rendering. Headline status word, constraints, step
  table, ledger table with approver and externalId.
- `src/mirror/mirror.check.ts`: the one assertion script.

## Behaviour

- Every call writes `state/workorder.md` (atomic rename). This is the no-key fallback and
  a camera target on its own.
- With `AMBIGUOUS_API_KEY` set and `MIRROR_MODE` not `file`, it also upserts one
  Ambiguous doc per work order. The doc id is stored in `state/mirror-docs.json`, read
  fresh on each call so a resumed process updates the same doc.
- Unchanged renders are not re-sent. Calls per work order are serialised and collapse to
  the latest state, so concurrent calls cannot create a duplicate doc.
- If the stored doc was deleted or trashed, a new one is created.
- All failures are logged as `[mirror] ...` and swallowed (D5).

## Not wired in

Nothing outside `src/mirror/` calls `mirror` yet; lane D owns only `src/mirror/**`.
Whoever integrates should call `mirrorSoon(wo)` after each state change in the job and the
approval handler. Do not `await mirror()` on a commit path.

## Run the check

    node --env-file=.env --import tsx src/mirror/mirror.check.ts

Uses an isolated temp `STATE_DIR`. Without a key it checks the file only. With a key it
also checks the live doc, then deletes the doc it created.

Verified 14:47 against live Ambiguous: fresh, WAITING ON HUMAN, one doc id under
concurrent mirrors, COMMITTED with externalId updated in place, invalid key does not
reject and still writes the file. `tsc --noEmit` clean.

## Honesty notes

- The doc can lag SQLite and can be stale if the last upsert failed. It is never read back.
- The check does not cover a process kill mid-upsert; a doc created but not yet recorded
  in `mirror-docs.json` would leave an orphan doc on the next call.

## For DECISIONS.md at merge

- The mirror writes `state/workorder.md` on every call, key or not. Rules out a demo that
  depends on Ambiguous being reachable.
- Doc ids live in `state/mirror-docs.json`, not SQLite, so core stays free of Ambiguous
  (invariant 7). `npm run reset` clears it with the rest of `state/`, so each take gets a
  fresh doc.

## For CHANGELOG.md

`14:47 — work order mirror shipped: state/workorder.md plus live Ambiguous doc, check passes on live key — not yet called from the job or listener`
