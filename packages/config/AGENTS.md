# @anr/config

Loads and validates the repo's `config/` tree: JSON Schema per file (from `@anr/schemas`) plus cross-file rules (series formats exist, languages are the newsroom's, channel templates exist, podcast hosts per language, two distinct fact-checker models).

- `pnpm config:check` runs it; CI fails on any problem.
- `syncConfig()` (`pnpm config:sync`, run at deploy as `anr_system`) upserts formats, newsrooms, beats, sources and series on their slugs, so ids never change; items that leave the config are soft-deleted (`removed_at`), a removed newsroom's beats, sources and series with it, and revived with the same id. In the same transaction it makes the pg-boss schedules on the config-owned queues exactly what config asks for (`schedules.ts`): a source only once `terms_checked` is set, daily assignments at `assignment_at`, all in the newsroom's timezone.
- `*.db.test.ts` run against `anr_test` (`pnpm db:up && pnpm db:migrate`).
- New config rule → add it to `validate.ts` with a test in `validate.test.ts`.
- Sync soft-deletes every newsroom not in `config/`, with its beats, sources and series. In `anr_test` that includes other packages' test newsrooms, so database tests that read `removed_at` run after `@anr/config#test` (their `turbo.json`).
