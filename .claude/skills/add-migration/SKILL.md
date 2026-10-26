---
name: add-migration
description: Write an ANR Postgres migration (new table, column, index, policy or function). Use for any database schema change; it enforces the tenancy and row-level-security rules.
---

# Add a migration

Migrations are plain SQL in `packages/db/migrations/`, applied with dbmate.

1. `pnpm --filter @anr/db migrate:new <snake_case_name>` and write both `-- migrate:up` and `-- migrate:down`.
2. Name entities with the charter's vocabulary (`docs/charter.md#vocabulary`, `docs/technical-design.md#data-model`).
3. **Every tenant table** (anything belonging to one newsroom):

   ```sql
   newsroom_id uuid not null references newsroom(id),
   ...
   alter table <t> enable row level security;
   alter table <t> force row level security;
   create policy <t>_tenant on <t>
     using (newsroom_id = current_setting('anr.newsroom_id')::uuid)
     with check (newsroom_id = current_setting('anr.newsroom_id')::uuid);
   grant select, insert, update, delete on <t> to anr_app;
   ```

   Tables are owned by `anr_migrator`. `anr_app` is under forced RLS; `anr_system` (config sync, the publisher's sweep) bypasses it. CI fails a tenant table without a policy.
4. Index `newsroom_id` (usually as the first column of a composite index).
5. Status columns use the values in `packages/core/src/vocabulary.ts` (a `check` constraint or enum).
6. Never store channel credentials unencrypted; they are encrypted with the platform key.
7. `pnpm db:up && pnpm db:migrate`, then `pnpm check`. Update the data-model table in `docs/technical-design.md` if entities or key fields changed.
