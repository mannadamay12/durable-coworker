# Social post drafts

## X / Bluesky (short)

Built a Slack coworker where the model never holds the send button.

It researches and drafts freely, then stops for a named human before anything
irreversible. Kill the worker mid-job, restart it, and it resumes without re-sending the
email.

[video] github.com/mannadamay12/durable-coworker

## LinkedIn (long)

Agents keep their plan and progress in the context window. When the process dies, the
only recovery is to run the job again, and that is unsafe once a step has already emailed
a customer.

For this hackathon we built Durable Coworker: an agent triggered from a Slack thread that
separates three questions most designs merge.

- Where was I? A persisted step list.
- Did the world already change? A ledger keyed by idempotency key.
- Did a human already say yes? An approval from an allowlisted Slack user.

The model never has an irreversible tool in its toolset. It can only propose a commit with
frozen arguments. A plain function with no model in it executes after approval, and a
retry of a committed key returns the existing receipt instead of sending again.

This is at-least-once with a dedupe ledger, not exactly-once. There is a window between a
provider accepting a send and the ledger recording it; we embed the key in the artifact so
recovery is an exact match rather than a guess.

Built with CopilotKit Channels, Trigger.dev, OpenRouter and Ambiguous.

[video] github.com/mannadamay12/durable-coworker
