# Development

How the repo is laid out and how to work in it. Agents: [`AGENTS.md`](../AGENTS.md) is the short version with the invariants.

## Requirements

Node 24, pnpm 11, Python 3.13, uv, Docker. Versions are pinned in `.nvmrc`, `package.json` (`packageManager`, `engines`) and `.python-version`.

## Layout

```
apps/
  api/          Hono API for people; openapi.yaml is the contract
  web/          Astro SSR: reader sites + editor's desk, routed by host
  agents/       LangGraph.js agents worker, model router
  publisher/    renders, sends, records; podcast audio
services/
  ingestion/    Python: sources → stored leads
  verifier/     Python: the gate's code checks
packages/
  core/         vocabulary types, language → direction
  config/       loads and validates config/
  schemas/      JSON Schema → zod (src/generated) and pydantic (python/anr_schemas); vendored IPTC vocabularies (iptc/)
  db/           SQL migrations, Postgres client, withNewsroom()
config/         models, formats, newsrooms
infra/          compose.yaml, Dockerfiles, Caddyfile, dev Postgres init
docs/           design docs (settled decisions only)
.claude/        skills and dev-server launch config for coding agents
```

## Commands

| Command                            | What it does                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm install && uv sync`          | Install Node and Python dependencies                                                                                   |
| `pnpm check`                       | Everything CI runs: Biome, ruff, Redocly, typecheck (tsc, mypy), tests (vitest, pytest), `config:check`, codegen drift |
| `pnpm gen`                         | Regenerate zod and pydantic from JSON Schema, and API types from `openapi.yaml`                                        |
| `pnpm format`                      | Apply Biome formatting (Python: `uv run ruff format .`)                                                                |
| `pnpm db:up` / `pnpm db:down`      | Start or stop Postgres 17 in Docker                                                                                    |
| `pnpm db:migrate`                  | Apply SQL migrations (reads `DATABASE_MIGRATION_URL` from `.env`)                                                      |
| `pnpm dev`                         | Run every app and service in watch mode                                                                                |
| `pnpm --filter @anr/<name> <task>` | One package's `dev`, `test`, `lint` or `typecheck`, TypeScript or Python                                               |
| `pnpm schemas:view` | Browse every JSON Schema as a tree at http://localhost:4400 |

Dev ports: web 4321 (override with `WEB_PORT`), api 8787, ingestion 8101, verifier 8102. Every TypeScript app loads the repo-root `.env` itself (`node --env-file-if-exists`). Newsroom sites resolve by host: http://ai.localhost:4321/ and http://kultur.localhost:4321/ (`ANR_ROOT_DOMAIN=localhost`); browsers resolve `*.localhost` to the local machine.

## Workflow

1. Pick a task from the [build plan](build-plan.md).
2. Read the package's `AGENTS.md` and the relevant section of the [technical design](technical-design.md).
3. Use a skill when one fits (`.claude/skills/`: add-newsroom, add-format, add-migration, add-agent-role, charter-check).
4. Write the change with tests. Logic goes in plain modules; framework files stay thin.
5. `pnpm check`.
6. Update the docs, tick the build-plan task, record any new decision in [decisions](decisions.md).
7. Commit with a conventional message (`feat(publisher): idempotent Telegram send`).

## Conventions

- **Vocabulary.** Names in code, tables and UI follow the [charter's vocabulary](charter.md#vocabulary).
- **TypeScript.** ESM; import local files with `.ts`; Node runs TypeScript directly (type stripping), so workers have no build step. Tests sit next to code as `*.test.ts`.
- **Python.** Packages under `src/`, tests under `tests/`, mypy strict.
- **Generated code** is committed and never edited by hand; `pnpm gen:check` fails if it is stale.
- **Config** changes are validated by `pnpm config:check`; a new rule goes into `packages/config/src/validate.ts` with a test.
- **Secrets** only in `.env` (never committed); the list is `.env.example`.
- **Docs** describe settled design. Anything undecided is a GitHub issue until decided, then a row in [decisions](decisions.md).
