// Checks a live database against the tenancy rules: `pnpm --filter @anr/db tenancy:check`.
// Run after migrations at deploy and after a restore.
import { createPool, loadRootEnv } from "./index.ts";
import { findTenancyProblems } from "./tenancy.ts";

loadRootEnv();
const pool = createPool(process.env.DATABASE_MIGRATION_URL);
try {
  const problems = await findTenancyProblems(pool);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log("✓ tenancy: every tenant table has forced row-level security");
} finally {
  await pool.end();
}
