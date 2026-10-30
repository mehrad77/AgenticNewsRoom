# AGENTS.md

Instructions for coding agents (and people) working in this repo. Read this first, then the doc for the area you touch.

## What this is

ANR (Agentic News Room): a platform for running publications where humans set the editorial direction, AI agents research and write, and code does everything mechanical. Design: [`docs/`](docs/README.md). Start with the [charter](docs/charter.md); its vocabulary is binding in code, data and conversation.

## Map

| Path                 | What                                                                        | Language         |
| -------------------- | --------------------------------------------------------------------------- | ---------------- |
| `apps/api`           | Hono API for people (the editor's desk); contract-first `openapi.yaml`      | TS               |
| `apps/web`           | Astro SSR: every newsroom's reader site + the editor's desk, routed by host | TS               |
| `apps/agents`        | LangGraph.js agents worker + model router                                   | TS               |
| `apps/publisher`     | Renders, sends to channels, records posts; podcast audio                    | TS               |
| `services/ingestion` | Sources → stored leads                                                      | Python           |
| `services/verifier`  | Code checks of the verifier gate                                            | Python           |
| `packages/core`      | Vocabulary types, language → direction                                      | TS               |
| `packages/config`    | Loads and validates `config/`                                               | TS               |
| `packages/models`    | Model catalog, provider clients, fallback gateway, `models:probe`           | TS               |
| `packages/schemas`   | JSON Schema source → generated zod + pydantic                               | TS/Python        |
| `packages/render`    | Channel templates rendered with LiquidJS (publisher and the gate)          | TS               |
| `packages/db`        | SQL migrations (dbmate), Postgres client, `withNewsroom()`                  | TS/SQL           |
| `packages/telemetry` | Planned in milestone 7b: OpenTelemetry setup for the TS apps and Python services | TS/Python |
| `config/`            | Models, formats, newsrooms (versioned configuration)                        | YAML/JSON/Liquid |
| `infra/`             | Docker Compose, Dockerfiles, Caddy, backups; planned in milestone 7a: `terraform/` (Cloudflare), `secrets/` (SOPS), `host/` (systemd and launchd profiles); in 7b: `observability/`, `drills/` | Shell/HCL |
| `tools/tts-eval`     | Local TTS comparison kit (Chatterbox, XTTS-v2, Dia) for English and Turkish | Python/HTML      |
| `tools/load`         | Planned in milestone 7b: k6 load tests against the reader site | JS |
| `docs/`              | Charter, technical design, first newsrooms, decisions, build plan, postmortems | Markdown |

Each app, service and package has its own short `AGENTS.md` with its boundaries.

## Commands

```bash
pnpm install && uv sync      # install everything (Node 24, pnpm 11, Python 3.13, uv)
cp .env.example .env         # dev settings (set ANR_PG_PORT and the URLs if 5432 is taken)
pnpm db:up                   # Postgres 17 in Docker (dev)
pnpm db:migrate              # apply SQL migrations to anr and the test database anr_test
pnpm check                   # lint, typecheck, test (database tests need db:up), config:check, codegen drift — must pass
pnpm gen                     # regenerate zod/pydantic from JSON Schema and API types from openapi.yaml
pnpm config:sync             # load config/ into Postgres
pnpm models:probe            # ping every model in the active models file (real calls)
pnpm dev                     # run every app and service in watch mode
pnpm --filter @anr/<pkg> test   # one package (TS or Python)
```

## Invariants

These come from the charter. A change that crosses one needs a charter change first; stop and say so.
1. **Only code publishes.** Agents never send to a channel, write HTML, record posts, or write anywhere except through `submit`.
2. **Agents have four tools:** read a lead, search the lead pool, request a source (via ingestion), submit. No web access.
3. **Source-grounded.** Every factual claim cites a stored lead and a passage from its frozen text.
4. **The writer never checks its own facts.** The fact-checker's model family differs from every family that wrote the story (`apps/agents/src/router.ts`).
5. **The gate can hold, never approve.** Any failed, partial, errored or timed-out check sends the publication to a person.
6. **Tenancy in the database.** Every tenant table has `newsroom_id` with forced row-level security; app code uses `withNewsroom()`.
7. **Channels and secrets are never config.** Channels are data in Postgres (credentials encrypted); secrets are only the env vars in `.env.example`.
8. **AI disclosure cannot be turned off.** Every channel template renders `config/formats/_partials/disclosure.liquid`.
9. **A new newsroom is configuration only.** If adding one needs code, the platform is missing a feature; build it generically.
10. **Approvals live in Postgres.** A graph never waits for a human.

## Definition of done

- `pnpm check` passes.
- Docs describe the result. `docs/` holds settled design only; if something is undecided, open a GitHub issue rather than writing it into the docs. Record new decisions in `docs/decisions.md`.
- Build-plan tasks you finished are ticked in `docs/build-plan.md`.
- Conventional commits (`feat(api): …`, `fix(verifier): …`, `docs: …`).

## Conventions

- TypeScript: ESM, strict, `noUncheckedIndexedAccess`, import local files with the `.ts` extension, Biome for lint and format, vitest next to the code (`*.test.ts`).
- Python: 3.13, uv workspace, ruff (lint + format), mypy strict, pytest in `tests/`.
- Generated code (`src/generated/`, `anr_schemas/{config,formats}/`) is never edited by hand.
- Logic lives in plain modules with tests; framework files (`.astro`, route handlers, workers) stay thin.
- Skills for repeatable work are in `.claude/skills/` (`add-newsroom`, `add-format`, `add-migration`, `add-agent-role`, `charter-check`); they are plain Markdown any agent can follow.
