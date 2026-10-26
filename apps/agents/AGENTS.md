# @anr/agents

The agents worker: LangGraph.js graphs for the planner, desk, renderer, fact-checker, item matcher and summariser. Each run is one pg-boss job, one graph, one submit.

Hard limits (charter; see `docs/technical-design.md#agent-runs`):
- An agent has exactly four tools: read a lead, search its newsroom's lead pool, request a new source (through ingestion), submit. No web access, no send, no other writes.
- A graph never waits for a human; approvals, holds and schedules are Postgres rows.
- Agents name a role; `src/router.ts` picks the model from `config/models.yaml`. The fact-checker's model always differs from the writer's.
- Submits are validated against the format's JSON Schema; one retry with the errors, then the assignment is held.
- Every model call writes an Agent run row (role, model, prompt version, input hash, tokens, cost).

Use the `add-agent-role` skill for a new role. Commands: `pnpm --filter @anr/agents test`, `pnpm --filter @anr/agents dev` (needs `pnpm db:up`).
