# Review scenario pack

Six actual BANKING77 test utterances are selected in `banking77-sample.json`. The original 3,080-record test CSV is pinned at commit `57ec275d8078af65b7731c2a98be812d844a6d6b`; the source URL, SHA-256, authors and license are retained in the JSON. Only six selected records are stored here. The support-policy text and adversarial wrappers in `cases.json` are synthetic additions for this review, not original BANKING77 labels or benchmark tasks.

Attribution: Iñigo Casanueva, Tadas Temcinas, Daniela Gerz, Matthew Henderson and Ivan Vulić, *Efficient Intent Detection with Dual Sentence Encoders*, 2020, PolyAI. [Original dataset](https://github.com/PolyAI-LDN/task-specific-datasets), [paper](https://aclanthology.org/2020.nlp4convai-1.5/). The selected source text is provided under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the upstream license is included in `BANKING77-LICENSE.txt`. Selection and added wrapper text are the only modifications. This pack tests support workflow behavior; it does not evaluate banking advice or authorize banking operations.

Run the isolated offline review from this worktree:

```sh
node scripts/review-planner.mjs
```

It exercises the actual planner, a local mock provider, and core state in a temporary directory. The default cannot contact a remote model and does not load `.env`. It deliberately reports desired-behavior failures without exiting unsuccessfully; use `--strict` to make those findings fail the command. It deletes its temporary state and writes a JSON evidence report under `notes/`.

An explicitly requested live check uses only the key, model and base URL from the supplied configuration. It submits the existing primary fixture and one dataset-based injection case, caps HTTP requests at four including retries, and uses a 45-second request timeout. Reversible tools remain stubs and no commit is approved or sent:

```sh
node scripts/review-planner.mjs --live --config /absolute/path/to/.env
```

The scenarios are currently a review adapter. They are not wired into Slack or a runtime dataset loader. All six corpus cases say to draft internally only; the current fixture fallback nevertheless returns the Northwind external-send plan. That behavior is a finding, not a passing dataset benchmark.
