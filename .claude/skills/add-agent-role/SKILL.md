---
name: add-agent-role
description: Add or change an ANR agent graph (planner, desk, renderer, fact-checker, item matcher, summariser) in apps/agents. Use when building an agent's LangGraph.js graph, its prompt or its tools.
---

# Add or change an agent role

Agents curate and write. They never decide the agenda, never publish, and never check their own facts. Read `docs/technical-design.md#agent-runs` first.

## Rules

- **One run = one pg-boss job = one graph = one submit.** A graph never waits for a person: approvals, holds and schedules are Postgres rows.
- **Four tools only:** read a lead, search the newsroom's lead pool, request a source (ingestion fetches, stores and returns the lead; capped per run; private and internal addresses refused; unknown sites get tier 3), submit. No web access, no send, no other writes.
- **Role, not model.** Get the model from `ModelRouter.resolve(role, ctx)` (`apps/agents/src/router.ts`). For the fact-checker pass `writerModel` from the story's Agent run. A new role needs an entry in `config/models.yaml`, its schema (`packages/schemas/json/models.schema.json`) and `AGENT_ROLES` in `packages/core/src/vocabulary.ts`.
- **Prompts** = platform role prompt + newsroom `style.md` + format `guide.md`, versioned in the repo. Keep the total under 5 KB.
- **Validation.** Validate the submit against the format's schema (generated zod in `@anr/schemas`). On failure, return the errors to the graph once; a second failure holds the assignment for an editor.
- **Budgets.** Respect the format's per-run token cap and the newsroom's monthly spend cap (writing pauses at the cap; checks keep a reserved budget).
- **Logging.** Write an Agent run row for every model call: role, model, prompt version, input hash, tokens, cost.

## Tests

Unit-test each node with a fake model; test the graph end to end with recorded model responses. Then `pnpm check`.
