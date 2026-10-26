// Applies the migrations to the integration-test database (anr_test) on the dev server.
import { execFileSync } from "node:child_process";
import { loadRootEnv, testDatabaseUrl } from "../src/testing.ts";

loadRootEnv();
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error("DATABASE_MIGRATION_URL is not set; copy .env.example to .env");
// dbmate reads DATABASE_URL; passing it in the environment keeps the password out of `ps`.
execFileSync("dbmate", ["--migrations-dir", "migrations", "--no-dump-schema", "up"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl(url) },
});
