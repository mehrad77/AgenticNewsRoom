# Development

How the repo is laid out and how to work in it. Agents: [`AGENTS.md`](../AGENTS.md) is the short version with the invariants.

## Requirements

Node 24, pnpm 11, Python 3.13, uv, Docker. Versions are pinned in `.nvmrc`, `package.json` (`packageManager`, `engines`) and `.python-version`.

## Layout

```
apps/
  api/          Hono API for people; openapi.yaml is the contract
  web/          Astro SSR: reader sites + editor's desk, routed by host
  agents/       LangGraph.js agents worker, model router, daily assignment, the gate
  publisher/    renders, sends, records; podcast audio
services/
  ingestion/    Python: sources → stored leads
  verifier/     Python: the gate's code checks (POST /verify)
packages/
  core/         vocabulary types, language → direction
  config/       loads and validates config/
  models/       model catalog, provider clients, fallback gateway
  render/       channel templates rendered with LiquidJS (publisher and the gate's disclosure check)
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
| `cp .env.example .env` | Dev settings; if port 5432 is taken, set `ANR_PG_PORT` and the database URLs to another port |
| `pnpm check`                       | Everything CI runs: Biome, ruff, Redocly, typecheck (tsc, mypy), tests (vitest, pytest), `config:check`, codegen drift. Database tests (`*.db.test.ts`) need `pnpm db:up && pnpm db:migrate` and fail without them |
| `pnpm gen`                         | Regenerate zod and pydantic from JSON Schema, and API types from `openapi.yaml`                                        |
| `pnpm format`                      | Apply Biome formatting (Python: `uv run ruff format .`)                                                                |
| `pnpm db:up` / `pnpm db:down`      | Start or stop Postgres 17 in Docker                                                                                    |
| `pnpm db:migrate`                  | Apply SQL migrations to `anr` and to `anr_test`, the database the integration tests use (reads `DATABASE_MIGRATION_URL` from `.env`) |
| `pnpm db:roles` | Re-apply the role passwords from `.env` to a running Postgres |
| `pnpm config:sync` | Load `config/` into Postgres (as at deploy) |
| `infra/backup/drill-local.sh` | Rehearse backup, WAL replay and restore locally |
| `pnpm dev`                         | Run every app and service in watch mode                                                                                |
| `pnpm --filter @anr/<name> <task>` | One package's `dev`, `test`, `lint` or `typecheck`, TypeScript or Python                                               |
| `pnpm schemas:view` | Browse every JSON Schema as a tree at http://localhost:4400 |
| `pnpm models:probe [free]` | One tool-call ping to every model in the role chains of the active models file; real calls |

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

## Free models

Development needs no paid model. Set `ANR_MODELS=free` in `.env` and the agents use `config/models.free.yaml`: each role tries a chain of free-tier models and falls through to the next when one is rate-limited, down or retired (D72). A provider without a key is skipped, so start with any of them; more keys mean fewer exhausted chains. Then run `pnpm models:probe free`: `✓` works, `·` is rate-limited, down or has no key, `✗` means the models file needs a change (the model is gone, refuses tool calls, or the key is wrong).

Free tiers change often; the probe, not memory, decides which models stay in the file. Gemini outside the EEA, UK and Switzerland, and Mistral's free plan, may use prompts for training: use public text only. Production never uses this file; `infra/deploy.sh` refuses `ANR_MODELS=free`.

| Provider | Getting a key | Env vars | Free tier |
| --- | --- | --- | --- |
| Gemini | [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**. Leave billing off for that Cloud project. | `GEMINI_API_KEY` | Limits per model, shown in AI Studio |
| Groq | [console.groq.com](https://console.groq.com) → **API Keys** → **Create API Key** | `GROQ_API_KEY` | About 30 requests/min, 1,000/day and 200k tokens/day on `gpt-oss-120b`; your limits are under **Settings → Limits** |
| OpenRouter | [openrouter.ai](https://openrouter.ai) → **Settings → Keys** → **Create Key**. Under **Settings → Privacy**, allow the providers of free models, or most `:free` models refuse. | `OPENROUTER_API_KEY` | 20 requests/min and 50/day per account; 1,000/day after a one-time $10 credit |
| Mistral | [console.mistral.ai](https://console.mistral.ai) → verify a phone number → **Subscriptions → Experiment for free** → **API Keys** (the key is shown once). One free plan per phone number. | `MISTRAL_API_KEY` | Unpublished; see the admin panel |
| NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com) → sign in → open any model → **Get API Key** (`nvapi-…`) | `NVIDIA_API_KEY` | For prototyping; about 40 requests/min, shown in the top bar |
