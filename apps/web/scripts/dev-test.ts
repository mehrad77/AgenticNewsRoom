// Development only: the web app on the integration-test database (anr_test), never dev `anr`, so a
// preview cannot show or count anything real. `pnpm --filter @anr/web dev:test` → :4410.
import { spawn } from "node:child_process";
import { loadRootEnv, testDatabaseUrl } from "@anr/db/testing";

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; copy .env.example to .env");
const DATABASE_URL = testDatabaseUrl(url);
if (!new URL(DATABASE_URL).pathname.endsWith("/anr_test"))
  throw new Error("refusing: not anr_test");
const port = process.env.WEB_TEST_PORT ?? "4410";
spawn("pnpm", ["exec", "astro", "dev", "--port", port], {
  stdio: "inherit",
  // The API's own test instance (`pnpm --filter @anr/api dev:test`) serves the desk.
  env: {
    ...process.env,
    DATABASE_URL,
    WEB_PORT: port,
    ANR_API_URL: process.env.ANR_API_URL ?? "http://127.0.0.1:8788",
  },
}).on("exit", (code) => process.exit(code ?? 0));
