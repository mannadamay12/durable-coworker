# Dataset import

14:27 — Copied the 10 original dataset files into datasets/ — makes the scenario pack available in the project.

Source: /Users/ad12/Downloads/durable-coworker/datasets/

All copies match the originals by SHA-256. All eight JSON files parse successfully.

This import preserves the supplied fixtures; it does not add a runtime loader. Before using them in the live workflow, align the customer scenario, map synthetic approver IDs to real Slack accounts, and normalize the recovery fixtures to the core contract. Some recovery fixture IDs currently differ from the work-order prefix in their ledger keys.
