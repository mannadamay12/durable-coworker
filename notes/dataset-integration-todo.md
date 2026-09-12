# Dataset integration TODO

- [x] Capture the supplied dataset edits on a branch and merge current main (PR #8), preserving its hardening fixes.
- [x] Wire explicit dataset selection into Slack with conversation identity and trusted synthetic-to-real actor mapping.
- [x] Make dataset assets available to bundled Trigger workers and verify away from the source checkout.
- [x] Validate dataset structure, references, recipients, tools and approvers; extend injection checks.
- [x] Document the actual CLI/Slack/recovery flows and their limits.
- [x] Run combined dataset, planner, receipt, Slack, mirror and kill/resume checks.
- [ ] Pull the final main changes, publish and merge the reviewed branch.

Worktree: `/Users/ad12/Documents/Develop/durable-coworker-datasets`, branch `codex/dataset-integration`.
The original main worktree is being used by another agent; its uncommitted files are preserved.
