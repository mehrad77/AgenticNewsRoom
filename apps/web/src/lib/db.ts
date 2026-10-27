import { createPool, type Pool } from "@anr/db";

let pool: Pool | undefined;

/** The app role's pool (forced row-level security), created on first use. */
export function db(): Pool {
  pool ??= createPool(process.env.DATABASE_URL);
  return pool;
}
