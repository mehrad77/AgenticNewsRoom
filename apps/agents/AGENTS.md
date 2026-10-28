# @anr/agents

The agents worker: LangGraph.js graphs for the planner, desk, renderer, fact-checker, item matcher and summariser. Each run is one pg-boss job, one graph, one submit.

Hard limits (charter; see `docs/technical-design.md#agent-runs`):
- An agent has exactly four tools: read a lead, search its newsroom's lead pool, request a new source (through ingestion), submit. No web access, no send, no other writes.
- A graph never waits for a human; approvals, holds and schedules are Postgres rows.
- Agents name a role; `src/router.ts` picks the role's chain from the models file (`ANR_MODELS`), and `@anr/models` calls it. The fact-checker's chain never contains a family that wrote the story.
- Submits are validated against the format's JSON Schema; one retry with the errors, then the assignment is held.
- Every model call writes an Agent run row (role, the provider and model that answered, prompt version, input hash, tokens, cost). Pass the run's first answering model as `sticky` to later calls.

Summariser (`src/summariser/`): new leads get an Agent run and an `agent-run` job in one transaction; the graph validates the model's JSON (beats only from the newsroom's slugs) with one retry (D63). Model keys come from the environment (`GEMINI_API_KEY`); without one the worker leaves summariser jobs queued. Calls are paced by `ANR_SUMMARISER_RPM` and a 429 re-queues the job for later (D66); and `resumeSummaries()` re-queues unfinished ones at start and after each ingest run. Tests use `FakeListChatModel`.

Jobs: `ingest-source` calls the ingestion service (`src/ingest.ts`, `ANR_INGESTION_URL`); a 404 or 422 refusal ends the job, anything else failing is retried. Database tests (`*.db.test.ts`, including `pipeline.db.test.ts`, which spawns the Python service in replay mode) run against `anr_test`.

Desk and gate (milestone 3, D73–D81):
- `tools/`: the four tools; a test pins their names. Models are bound to `researchTools()`; code calls `submitTool()` after validation.
- `prompts/`: role prompts and `assemblePrompt()` (role + style section for the language + format guide, at most 5 KB, version = content hash).
- `model.ts`: `meteredModel()` sums tokens and cost over a run, records every answering family and stops at the format's `run_tokens`. `budget.ts`: monthly spend, the check reserve and notices.
- `assign.ts`: the 16:00 daily assignment. `desk/`: the desk graph, validation and submit. `renderer/`: other languages of a story. `dispatch.ts` routes `agent-run` jobs by the run's role.
- `gate/`: the `gate` job per story (verifier service at `ANR_VERIFIER_URL`, disclosure via `@anr/render`, fact-checker and item matcher via `verdict.ts`, `policy.ts`), and `sweep.ts`, which holds publications still unfinished 30 minutes before their slot. Policy passes only when every expected check exists and passed.
- `gate/gate.db.test.ts` spawns the Python verifier against `anr_test`, like `pipeline.db.test.ts` spawns ingestion.

Planner (milestone 5, D103–D104):
- `planner/tick.ts`: the daily `plan` job starts the planner runs that are due. A run's `task` says what it works on, and its key keeps it from starting twice.
- `planner/run.ts`: the run, with validation in `validate.ts` and its context in `context.ts`.
- Its submit stores themes (`editorial_cycles`) or a pick plus its `pick-deadline` job.
- `planner/deadline.ts` skips an unchosen pick. A chosen one is assigned by `assignPick()` in `assign.ts`.

Use the `add-agent-role` skill for a new role. Commands: `pnpm --filter @anr/agents test`, `pnpm --filter @anr/agents dev` (needs `pnpm db:up`).
