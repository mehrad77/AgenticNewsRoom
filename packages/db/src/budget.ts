// A newsroom's monthly model budget and this month's spend (D76). The agents worker enforces it;
// the editor's desk shows it.
import type { Client } from "./index.ts";

export interface Budget {
  monthlyUsd: number;
  checkReserveUsd: number;
}

export interface BudgetState extends Budget {
  /** The calendar month in the newsroom's timezone, `YYYY-MM`. */
  month: string;
  spentUsd: number;
}

/** Spend this month, in the newsroom's own timezone, over every Agent run. */
export async function budgetState(client: Client): Promise<BudgetState> {
  const { rows } = await client.query<{
    policy: { budget?: { monthly_usd: number; check_reserve_usd: number } };
    month: string;
    spent: string;
  }>(
    `select n.policy, to_char(now() at time zone n.timezone, 'YYYY-MM') as month,
            coalesce((select sum(r.cost_usd) from agent_runs r
                      where r.started_at >= (date_trunc('month', now() at time zone n.timezone)
                                             at time zone n.timezone)), 0) as spent
     from newsrooms n where n.id = anr.current_newsroom_id()`,
  );
  const row = rows[0];
  if (!row) throw new Error("no current newsroom");
  const budget = row.policy.budget;
  // Config validation requires a budget; a newsroom synced before it existed writes nothing.
  return {
    monthlyUsd: budget?.monthly_usd ?? 0,
    checkReserveUsd: budget?.check_reserve_usd ?? 0,
    month: row.month,
    spentUsd: Number(row.spent),
  };
}

export function writingLimit(b: Budget): number {
  return Math.max(0, b.monthlyUsd - b.checkReserveUsd);
}
