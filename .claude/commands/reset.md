---
description: Wipe all demo state so the next take starts clean.
---

Reset everything a demo take touches, then confirm what was cleared.

1. Delete the SQLite database at `state/ledger.db` and recreate the schema.
2. Truncate the local outbox.
3. Delete or recreate the Ambiguous work-order doc and its tasks for the active
   scenario.
4. Clear any Trigger.dev run artifacts under `state/`.
5. Re-seed the active scenario fixture from `scenarios/`.

Then print a one-screen summary: scenario name, work order id, step count, ledger row
count (must be 0), outbox row count (must be 0).

If `npm run reset` does not exist yet, build it now. This is not optional tooling. We
will film six to ten takes and a take that starts with a committed ledger produces a
demo that does not work.
