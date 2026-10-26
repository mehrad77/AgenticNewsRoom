// Row-level security against a real Postgres, as the roles production uses (never a superuser,
// which ignores RLS and would make every assertion pass vacuously).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool, withNewsroom } from "./index.ts";
import { createTestNewsroom, testDatabaseUrl, testPools } from "./testing.ts";

const pools = testPools();
let a: string;
let b: string;
let leadA: string;
let leadB: string;
let beatB: string;

const insertLead = (pool: Pool, newsroomId: string, uri: string) =>
  withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into leads (newsroom_id, uri, body, language, content_hash, tier)
       values ($1, $2, 'stored text', 'en', 'hash', 2) returning id`,
      [newsroomId, uri],
    );
    return rows[0]?.id ?? "";
  });

beforeAll(async () => {
  a = await createTestNewsroom(pools.system, "rls-a");
  b = await createTestNewsroom(pools.system, "rls-b");
  leadA = await insertLead(pools.app, a, "https://example.org/a");
  leadB = await insertLead(pools.app, b, "https://example.org/b");
  const { rows } = await pools.system.query<{ id: string }>(
    "insert into beats (newsroom_id, slug, status, media_topics) values ($1, 'labs', 'open', '{medtop:20001298}') returning id",
    [b],
  );
  beatB = rows[0]?.id ?? "";
});
afterAll(() => pools.end());

describe("anr_app inside withNewsroom", () => {
  it("reads its own newsroom's rows and none of another's", async () => {
    const ids = await withNewsroom(pools.app, a, async (c) => {
      const { rows } = await c.query<{ id: string }>("select id from leads");
      return rows.map((r) => r.id);
    });
    expect(ids).toContain(leadA);
    expect(ids).not.toContain(leadB);
  });

  it("cannot find another newsroom's row even by id", async () => {
    const count = await withNewsroom(pools.app, a, async (c) => {
      const { rowCount } = await c.query("select 1 from leads where id = $1", [leadB]);
      return rowCount;
    });
    expect(count).toBe(0);
  });

  it("updates and deletes nothing in another newsroom (USING filters silently)", async () => {
    const [updated, deleted] = await withNewsroom(pools.app, a, async (c) => {
      const u = await c.query("update leads set summary = 'hijacked' where id = $1", [leadB]);
      const d = await c.query("delete from leads where id = $1", [leadB]);
      return [u.rowCount, d.rowCount];
    });
    expect([updated, deleted]).toEqual([0, 0]);
    const { rows } = await pools.system.query("select summary from leads where id = $1", [leadB]);
    expect(rows).toEqual([{ summary: null }]);
  });

  it("cannot insert a row into another newsroom (WITH CHECK raises)", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        c.query(
          `insert into leads (newsroom_id, uri, body, language, content_hash, tier)
           values ($1, 'https://example.org/x', 't', 'en', 'h', 2)`,
          [b],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("cannot move its own row into another newsroom", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        c.query("update leads set newsroom_id = $1 where id = $2", [b, leadA]),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("cannot reference another newsroom's row (composite foreign key)", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        c.query("insert into lead_beats (newsroom_id, lead_id, beat_id) values ($1, $2, $3)", [
          a,
          leadA,
          beatB,
        ]),
      ),
    ).rejects.toThrow(/foreign key constraint/);
  });
});

describe("outside withNewsroom", () => {
  it("anr_app gets an error, not an empty result", async () => {
    await expect(pools.app.query("select count(*) from leads")).rejects.toThrow(
      "anr.newsroom_id is not set",
    );
  });

  it("the owner is under forced RLS too", async () => {
    await expect(pools.migrator.query("select count(*) from leads")).rejects.toThrow(
      "anr.newsroom_id is not set",
    );
  });

  it("anr_system bypasses RLS for cross-newsroom jobs", async () => {
    const { rows } = await pools.system.query<{ id: string }>(
      "select id from leads where id = any($1)",
      [[leadA, leadB]],
    );
    expect(rows.map((r) => r.id).sort()).toEqual([leadA, leadB].sort());
  });
});

describe("a pooled connection", () => {
  it("does not carry the newsroom into the next transaction", async () => {
    // One connection, reused: the second checkout gets the very same backend.
    const url = process.env.DATABASE_URL ?? "";
    const pool = createPool(testDatabaseUrl(url));
    pool.options.max = 1;
    try {
      const pidInside = await withNewsroom(pool, a, async (c) => {
        const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
        return rows[0]?.pid;
      });
      const after = await pool.query<{ pid: number; setting: string | null }>(
        "select pg_backend_pid() as pid, current_setting('anr.newsroom_id', true) as setting",
      );
      expect(after.rows[0]?.pid).toBe(pidInside);
      // After a transaction-local setting ends, Postgres reads it back as '' (not null).
      expect(after.rows[0]?.setting).toBe("");
      await expect(pool.query("select count(*) from leads")).rejects.toThrow(
        "anr.newsroom_id is not set",
      );
    } finally {
      await pool.end();
    }
  });
});

describe("tables that never change", () => {
  it("a lead's stored text is frozen", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        c.query("update leads set body = 'rewritten' where id = $1", [leadA]),
      ),
    ).rejects.toThrow("a lead's stored text is frozen");
  });

  it("the audit log is append-only, for the app and for the owner", async () => {
    const id = await withNewsroom(pools.app, a, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into audit_log (actor_kind, actor_name, action, entity, entity_id)
         values ('code', 'test', 'touch', 'leads', $1) returning id`,
        [leadA],
      );
      return rows[0]?.id;
    });
    await expect(
      withNewsroom(pools.app, a, (c) =>
        c.query("update audit_log set action = 'x' where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withNewsroom(pools.migrator, a, (c) => c.query("delete from audit_log where id = $1", [id])),
    ).rejects.toThrow("audit_log is append-only");
  });
});
