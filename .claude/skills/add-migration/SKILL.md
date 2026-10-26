---
name: add-migration
description: Write an ANR Postgres migration (new table, column, index, policy or function). Use for any database schema change; it enforces the tenancy and row-level-security rules.
---

# Add a migration

Migrations are plain SQL in `packages/db/migrations/`, applied with dbmate, one transaction per file. Never edit a migration that has been applied anywhere; add a new one.

1. `pnpm --filter @anr/db migrate:new <snake_case_name>` and write both `-- migrate:up` and `-- migrate:down`. Write every statement out; do not call helper functions that generate DDL, so replaying history never depends on a function's current definition.
2. Name entities with the charter's vocabulary (`docs/charter.md#vocabulary`, `docs/technical-design.md#data-model`). Tables are plural snake_case (`publications`, `checks`); ids are `uuid default gen_random_uuid()`.
3. **Every tenant table** (anything belonging to one newsroom):

   ```sql
   create table things (
     id uuid primary key default gen_random_uuid(),
     newsroom_id uuid not null references newsrooms (id),
     parent_id uuid not null,
     ...
     unique (newsroom_id, id),
     -- Composite: foreign-key checks bypass RLS, so this is what keeps a reference in-newsroom.
     foreign key (newsroom_id, parent_id) references parents (newsroom_id, id)
   );
   alter table things enable row level security;
   alter table things force row level security;
   create policy things_tenant on things
     using (newsroom_id = (select anr.current_newsroom_id()))
     with check (newsroom_id = (select anr.current_newsroom_id()));
   grant select, insert, update, delete on things to anr_app, anr_system;
   ```

   Tables are owned by `anr_migrator`, which is under forced RLS too. `anr_app` runs inside `withNewsroom()`; `anr_system` (config sync, the publisher's sweep) bypasses RLS but still needs grants. Configuration tables (synced from `config/`) are `select` only for `anr_app`. A view over tenant data needs `with (security_invoker = true)`.
4. Platform tables without `newsroom_id` (`newsrooms`, `formats`, `users`) are listed in `PLATFORM_TABLES` in `packages/db/src/tenancy.ts`; a new one needs a reason there.
5. Index `newsroom_id` (usually as the first column of a composite index; `unique (newsroom_id, id)` already gives one).
6. Status and kind columns use the values in `packages/core/src/vocabulary.ts` as a `check` constraint; `vocabulary.db.test.ts` compares them.
7. Never store channel credentials unencrypted; they are sealed with the platform key (`sealCredentials()`).
8. `pnpm db:up && pnpm db:migrate`, then `pnpm check` (the tenancy check and RLS tests run against `anr_test`). Update the data-model table in `docs/technical-design.md` if entities or key fields changed.
