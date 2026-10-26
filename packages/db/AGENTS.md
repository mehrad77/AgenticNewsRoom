# @anr/db

Postgres access for the TypeScript services and the SQL migrations for the whole platform (Python services share the same database and never migrate it).

- Migrations: plain SQL in `migrations/`, applied with dbmate (`pnpm db:migrate` migrates `anr` and the integration-test database `anr_test`; new file with `pnpm --filter @anr/db migrate:new <name>`). Use the `add-migration` skill.
- Roles: `anr_migrator` owns tables; `anr_app` runs under forced row-level security; `anr_system` runs cross-newsroom jobs (config sync, the publisher's sweep). Production creates them from env passwords with `anr-roles` (`infra/postgres/`).
- Every tenant table has `newsroom_id`, RLS enabled and forced, a `using` + `with check` policy on `(select anr.current_newsroom_id())`, and composite foreign keys `(newsroom_id, x_id)`. `tenancy.ts` lists the problems; its test fails `pnpm check` on any.
- App code reaches tenant data only through `withNewsroom()`. `anr.current_newsroom_id()` raises outside it.
- Also here: `sealCredentials()`/`openCredentials()` (channel credentials under the platform key), `recordAudit()` and `auditedUpdate()` (the append-only audit log; `auditedUpdate()` redacts secret columns such as `credentials`), and the pg-boss schema migration.
- Tests named `*.db.test.ts` run against `anr_test` and need `pnpm db:up && pnpm db:migrate`; they fail, never skip, without it.
