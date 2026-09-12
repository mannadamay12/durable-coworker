# Lane C handoff: planner and commit-tool override

## Shipped

- `src/agent/plan.ts`
  - `plan(threadText: string): Promise<{ steps: Step[]; constraints: string[] }>`
  - `enforceCommitTools(steps: Step[]): Step[]`, pure, does not mutate input.
- `src/agent/openrouter.ts`: OpenRouter client (openai SDK, `baseURL` override, D22).
- `src/agent/plan.test.mjs`: the one assertion script.
- `scenarios/customer-success.json`: Northwind thread, `threadText`, `approvers`,
  seeded `injection`, and `expected` constraints and steps (includes a `mail.send` and a
  `crm.update` commit step).

## Model status

The original key in `.env` is free tier and returns HTTP 402 Insufficient credits on
`google/gemini-3.8-flash`; with it, `plan()` runs the deterministic stub from the fixture.

A funded key was verified at ~14:25: the full test passes on the live model
(`google/gemini-3.8-flash`, strict schema, `require_parameters`). The model path is live
as soon as `.env` holds the funded key (`OPENROUTER_API_KEY` set and `PLANNER_MODE` not
`stub`). Any model failure still falls back to the stub, which logs
`Classifier stubbed, override real.` Force the stub with `PLANNER_MODE=stub`. Output from either path always
passes through `enforceCommitTools`.

## Decision: classifiedBy semantics

Every step whose tool is in `COMMIT_TOOLS` gets `classifiedBy: "allowlist_override"`,
including when the model already said `commit`. The marker means "the allowlist
decided", not "the model disagreed". Steps not in `COMMIT_TOOLS` keep `"model"`.

The loud `[planner] OVERRIDE ...` warn line fires only on an actual disagreement (the
incoming kind was not `commit`).

Constrains lane B: the card cannot use `classifiedBy` to show "model was overruled".
Every commit card will show `allowlist_override`. If a disagreement badge is wanted, it
needs the log line, not the field.

## Run the test

    node src/agent/plan.test.mjs                    # stub path today
    node --env-file=.env src/agent/plan.test.mjs    # model path once the key has credits

Three cases: clean thread (commit step is `commit`, credit constraint present), injected
thread (`mail.send` still `commit` + `allowlist_override`, no commit tool reversible),
hand-built list (`mail.send` and `crm.update` claimed reversible are forced, `search`
untouched, input not mutated).

## For lanes A and B

- Call `plan(threadText)`. Returns contract `Step[]` with `status: "pending"`.
- `constraints` go to `WorkOrder.constraints`.
- `approvers` come from the fixture's `approvers` field, not from the planner.

## Honesty notes

- The injection test proves the override, not the model's resistance to injection. On
  the live model run the model kept `mail.send` as commit itself, so no OVERRIDE fired on
  the injected thread; the OVERRIDE beat on camera comes from the hand-built case.
- If the demo runs on the stub (unfunded key or model failure), constraints are also
  stubbed. Check the `[planner]` log line before describing them as model-extracted.
- README (orchestrator owns it) should only say "classifier stubbed, override real" if
  the filmed run logs the stub line.

## For DECISIONS.md at merge

- Planner falls back to a deterministic fixture stub when OpenRouter is unavailable;
  override and test stay fully real. Rules out claiming a live classifier for any run
  that logs the stub line.
- `classifiedBy: "allowlist_override"` is set on every `COMMIT_TOOLS` step, not only on
  disagreements. Rules out using the field as a "model was wrong" signal; the OVERRIDE
  log line is that signal.
- `enforceCommitTools` runs on every `plan()` output regardless of path, so the stub
  cannot bypass invariant 2 either.
- The planner schema's `tool` is an enum of known tool names plus null, so a near-miss
  like `mail_send` cannot slip past the exact-match `COMMIT_TOOLS` check.

## For CHANGELOG.md

`14:13 — planner shipped: plan() + enforceCommitTools, assertion script covers clean,
injected and hand-built cases — classifier stubbed (OpenRouter 402), override real`
