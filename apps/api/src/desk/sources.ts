// Source health for the editor's desk: each source's last fetch and recent leads, failing first.
// Read-only: sources are config, and `terms_checked` is set in sources.yaml, never here.
import type { Client } from "@anr/db";

export async function sourceHealth(client: Client) {
  const { rows } = await client.query<{ last_fetched_at: Date | null }>(
    `select s.id, s.slug, s.kind, s.url, s.publisher, s.tier, s.use,
            s.terms_checked::text as terms_checked, f.last_fetched_at, f.last_status::int as last_status,
            f.last_error, coalesce(f.consecutive_failures, 0) as consecutive_failures,
            (select count(*)::int from leads l
             where l.source_id = s.id and l.fetched_at > now() - interval '7 days') as leads_7d
     from sources s left join source_fetch_state f on f.source_id = s.id
     where s.removed_at is null
     order by coalesce(f.consecutive_failures, 0) desc, s.terms_checked is null desc, s.slug`,
  );
  return rows.map((r) => ({ ...r, last_fetched_at: r.last_fetched_at?.toISOString() ?? null }));
}
