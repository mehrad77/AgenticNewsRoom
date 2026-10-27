// Integration-test support: tests run against the `anr_test` database on the dev server, with
// the same three roles as production. Imported by tests only (`@anr/db/testing`).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRootEnv } from "./env.ts";
import { createPool, type Pool } from "./index.ts";

export { loadRootEnv };

export const TEST_DATABASE = "anr_test";
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** The same server and role as `url`, on the integration-test database. */
export function testDatabaseUrl(url: string): string {
  const u = new URL(url);
  u.pathname = `/${TEST_DATABASE}`;
  return u.toString();
}

const envUrl = (name: string): string => {
  loadRootEnv();
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set; copy .env.example to .env`);
  return testDatabaseUrl(url);
};

export interface TestPools {
  /** anr_app: under forced row-level security. */
  app: Pool;
  /** anr_system: bypasses row-level security. */
  system: Pool;
  /** anr_migrator: owns the tables, under forced row-level security too. */
  migrator: Pool;
  end(): Promise<void>;
}

export function testPools(): TestPools {
  const app = createPool(envUrl("DATABASE_URL"));
  const system = createPool(envUrl("DATABASE_SYSTEM_URL"));
  const migrator = createPool(envUrl("DATABASE_MIGRATION_URL"));
  return {
    app,
    system,
    migrator,
    end: async () => {
      await Promise.all([app.end(), system.end(), migrator.end()]);
    },
  };
}

/**
 * Fails with a clear message unless `anr_test` is reachable and has every migration applied.
 * Used as vitest globalSetup: database tests fail, never skip, without a database.
 */
export async function assertTestDatabaseReady(): Promise<void> {
  const fix = "start it with `pnpm db:up && pnpm db:migrate`";
  const client = new pg.Client({ connectionString: envUrl("DATABASE_MIGRATION_URL") });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`Postgres test database unreachable (${(error as Error).message}); ${fix}`);
  }
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]);
    const { rows } = await client
      .query<{ version: string }>("select version from schema_migrations")
      .catch(() => ({ rows: [] as { version: string }[] }));
    const applied = new Set(rows.map((r) => r.version));
    const missing = files.filter((v) => v && !applied.has(v));
    if (missing.length > 0) {
      throw new Error(`${TEST_DATABASE} is missing migrations ${missing.join(", ")}; ${fix}`);
    }
  } finally {
    await client.end();
  }
}

/** Inserts a newsroom with a unique slug and a budget no test reaches (as anr_system); returns its id. */
export async function createTestNewsroom(system: Pool, prefix = "t"): Promise<string> {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const { rows } = await system.query<{ id: string }>(
    `insert into newsrooms
       (slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner, planning, policy)
     values ($1, $1, '{"en": "Test"}', '{en}', 'UTC', 'Editor', 'Editor', '{}',
             '{"budget": {"monthly_usd": 1000, "check_reserve_usd": 0}}')
     returning id`,
    [slug],
  );
  const row = rows[0];
  if (!row) throw new Error("newsroom insert returned no row");
  return row.id;
}
