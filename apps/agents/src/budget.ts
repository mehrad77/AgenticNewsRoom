// Monthly model spend per newsroom (D76). Writing roles stop at the cap minus the check reserve;
// checks may spend the reserve, so a draft written before the cap can still be checked. The
// Editor-in-Chief gets a notice at 80% and at the writing limit, once a month each.
import type { AgentRole } from "@anr/core";
import { type BudgetState, type Client, writingLimit } from "@anr/db";

export { type Budget, type BudgetState, budgetState, writingLimit } from "@anr/db";

/** Roles whose runs the reserve is kept for: the gate's model checks. */
export const CHECK_ROLES: readonly AgentRole[] = ["fact-checker", "item-matcher"];
export const WARNING_SHARE = 0.8;

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

/** Whether a run of this role may start now. A run that has started may finish (its token cap bounds it). */
export function mayStart(role: AgentRole, s: BudgetState): BudgetVerdict {
  const limit = CHECK_ROLES.includes(role) ? s.monthlyUsd : writingLimit(s);
  if (s.spentUsd < limit) return { ok: true };
  return {
    ok: false,
    reason: `the newsroom has spent $${s.spentUsd.toFixed(2)} of its $${limit.toFixed(2)} ${
      CHECK_ROLES.includes(role) ? "monthly budget" : "writing budget"
    } for ${s.month}`,
  };
}

/** Writes the month's 80% and cap notices once each, when spend has reached them. */
export async function noticeBudget(client: Client, s: BudgetState): Promise<void> {
  const detail = { month: s.month, spent_usd: s.spentUsd, monthly_usd: s.monthlyUsd };
  const notices: string[] = [];
  if (s.monthlyUsd > 0 && s.spentUsd >= WARNING_SHARE * s.monthlyUsd)
    notices.push("budget-warning");
  if (s.spentUsd >= writingLimit(s)) notices.push("budget-cap");
  for (const kind of notices) {
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), $1, $2, $3)
       on conflict (newsroom_id, kind, key) do nothing`,
      [kind, s.month, JSON.stringify(detail)],
    );
  }
}
