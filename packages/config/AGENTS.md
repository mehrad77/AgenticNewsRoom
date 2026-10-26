# @anr/config

Loads and validates the repo's `config/` tree: JSON Schema per file (from `@anr/schemas`) plus cross-file rules (series formats exist, languages are the newsroom's, channel templates exist, podcast hosts per language, two distinct fact-checker models).

- `pnpm config:check` runs it; CI fails on any problem.
- Syncing config to Postgres (stable ids, soft deletes, pg-boss schedule reconciliation) is milestone 1 work and belongs here.
- New config rule → add it to `validate.ts` with a test in `validate.test.ts`.
