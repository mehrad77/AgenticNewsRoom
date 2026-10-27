// Development only: the API on the integration-test database (anr_test), signed in to the desk as
// ANR_DESK_DEV_EMAIL (default dev@anr.test). `pnpm --filter @anr/api dev:test` → :8788.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadRootEnv, testDatabaseUrl } from "@anr/db/testing";

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; copy .env.example to .env");
const DATABASE_URL = testDatabaseUrl(url);
if (!new URL(DATABASE_URL).pathname.endsWith("/anr_test"))
  throw new Error("refusing: not anr_test");
// Test data only: without a platform key, one for this process, so channels can be added here.
// Credentials sealed with it open nowhere else, which is all a test database needs.
let platform = process.env.ANR_PLATFORM_KEY;
if (!platform) {
  platform = randomBytes(32).toString("base64");
  console.warn("[api:test] ANR_PLATFORM_KEY is empty: using a key for this process only");
}
spawn("node", ["--watch", "src/server.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL,
    PORT: process.env.API_TEST_PORT ?? "8788",
    ANR_ROOT_DOMAIN: "localhost",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    ANR_DESK_DEV_EMAIL: process.env.ANR_DESK_DEV_EMAIL || "dev@anr.test",
    ANR_PLATFORM_KEY: platform,
  },
}).on("exit", (code) => process.exit(code ?? 0));
