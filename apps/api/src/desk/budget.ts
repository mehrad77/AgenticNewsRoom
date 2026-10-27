// This month's model spend against the newsroom's budget (D76), for the editor's desk. Read-only:
// the agents worker enforces the budget with the same budgetState().
import { budgetState, type Client, writingLimit } from "@anr/db";

/** Where this month began, in the newsroom's timezone. */
const MONTH_START = `(select date_trunc('month', now() at time zone n.timezone) at time zone n.timezone
  from newsrooms n where n.id = anr.current_newsroom_id())`;

export async function budget(client: Client) {
  const state = await budgetState(client);
  const { rows: byRole } = await client.query<{ role: string; runs: number; cost_usd: string }>(
    `select role, count(*)::int as runs, coalesce(sum(cost_usd), 0) as cost_usd
     from agent_runs where started_at >= ${MONTH_START}
     group by role order by sum(cost_usd) desc nulls last, role`,
  );
  const { rows: runs } = await client.query<{ cost_usd: string | null; started_at: Date }>(
    `select id, role, provider, model, outcome, cost_usd, tokens_in, tokens_out, started_at
     from agent_runs where started_at >= ${MONTH_START}
     order by started_at desc limit 50`,
  );
  return {
    month: state.month,
    monthly_usd: state.monthlyUsd,
    check_reserve_usd: state.checkReserveUsd,
    writing_limit_usd: writingLimit(state),
    spent_usd: state.spentUsd,
    by_role: byRole.map((r) => ({ ...r, cost_usd: Number(r.cost_usd) })),
    runs: runs.map((r) => ({
      ...r,
      cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
      started_at: r.started_at.toISOString(),
    })),
  };
}
