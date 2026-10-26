import { afterAll, describe, expect, it } from "vitest";
import { findTenancyProblems } from "./tenancy.ts";
import { testPools } from "./testing.ts";

const pools = testPools();
afterAll(() => pools.end());

describe("findTenancyProblems", () => {
  it("finds none in the migrated schema", async () => {
    expect(await findTenancyProblems(pools.migrator)).toEqual([]);
  });

  it("reports each way a table can break tenancy", async () => {
    // DDL is transactional in Postgres: build broken tables in a scratch schema, then roll back.
    const client = await pools.migrator.connect();
    try {
      await client.query("begin");
      await client.query(`
        create schema scratch;
        create table scratch.no_rls (id int, newsroom_id uuid);
        create table scratch.not_forced (id int, newsroom_id uuid);
        alter table scratch.not_forced enable row level security;
        create policy p on scratch.not_forced
          using (newsroom_id = (select anr.current_newsroom_id()))
          with check (newsroom_id = (select anr.current_newsroom_id()));
        create table scratch.loose (id int, newsroom_id uuid);
        alter table scratch.loose enable row level security;
        alter table scratch.loose force row level security;
        create policy tenant on scratch.loose
          using (newsroom_id = (select anr.current_newsroom_id()))
          with check (newsroom_id = (select anr.current_newsroom_id()));
        create policy open_read on scratch.loose for select using (true);
        create table scratch.or_true (id int, newsroom_id uuid);
        alter table scratch.or_true enable row level security;
        alter table scratch.or_true force row level security;
        create policy tenant on scratch.or_true
          using (newsroom_id = (select anr.current_newsroom_id()) or true)
          with check (newsroom_id = (select anr.current_newsroom_id()) or true);
        create table scratch.some_roles (id int, newsroom_id uuid);
        alter table scratch.some_roles enable row level security;
        alter table scratch.some_roles force row level security;
        create policy tenant on scratch.some_roles to anr_system
          using (newsroom_id = (select anr.current_newsroom_id()))
          with check (newsroom_id = (select anr.current_newsroom_id()));
        create table scratch.forgot_newsroom (id int);
        create view scratch.definer_view as select * from scratch.loose;
      `);
      expect(await findTenancyProblems(client, "scratch")).toEqual([
        "view definer_view must be created with (security_invoker = true)",
        "table forgot_newsroom has no newsroom_id and is not a listed platform table",
        "policy open_read on loose does not read with anr.current_newsroom_id()",
        "policy open_read on loose does not check writes with anr.current_newsroom_id()",
        "table no_rls does not enable row level security",
        "table no_rls does not force row level security",
        "table no_rls has no row-level security policy",
        "table not_forced does not force row level security",
        "policy tenant on or_true does not read with anr.current_newsroom_id()",
        "policy tenant on or_true does not check writes with anr.current_newsroom_id()",
        "policy tenant on some_roles applies to some roles only",
      ]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
