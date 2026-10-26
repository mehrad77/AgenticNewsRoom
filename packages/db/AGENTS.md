# @anr/db

Postgres access for the TypeScript services and the SQL migrations for the whole platform (Python services share the same database and never migrate it).

- Migrations: plain SQL in `migrations/`, applied with dbmate (`pnpm db:migrate`, new file with `pnpm --filter @anr/db migrate:new <name>`). Use the `add-migration` skill.
- Roles: `anr_migrator` owns tables; `anr_app` runs under forced row-level security; `anr_system` runs cross-newsroom jobs (config sync, the publisher's sweep).
- Every tenant table has `newsroom_id`, RLS enabled and forced, and `using` + `with check` policies on `current_setting('anr.newsroom_id')`. CI will fail a tenant table without a policy (milestone 1).
- App code reaches tenant data only through `withNewsroom()`.
