// The lead pool at the desk (D190): what a source brought in, and fetching a source now instead of
// at its next interval. Leads stay internal input for editors, never shown to readers (charter).
import { type IngestSourceJob, QUEUES } from "@anr/core";
import { type Client, onClient, type PersonActor, recordAudit } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

export interface LeadFilters {
  source?: string;
  since?: string;
  q?: string;
  limit?: number;
}

export function leadFilters(query: Record<string, string | undefined>): LeadFilters {
  const f: LeadFilters = {};
  if (query.source !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(query.source)) throw new DeskError(400, "source: a slug");
    f.source = query.source;
  }
  if (query.since !== undefined) {
    if (Number.isNaN(Date.parse(query.since))) throw new DeskError(400, "since: a date or time");
    f.since = new Date(query.since).toISOString();
  }
  if (query.q !== undefined) {
    if (query.q.length > 200) throw new DeskError(400, "q: at most 200 characters");
    f.q = query.q;
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new DeskError(400, "limit: 1 to 200");
    f.limit = n;
  }
  return f;
}

/** Leads newest first: headline, summary and where they came from, not their text. */
export async function listLeads(client: Client, f: LeadFilters) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.source) add("s.slug = ?", f.source);
  if (f.since) add("l.fetched_at >= ?", f.since);
  if (f.q) add("(l.headline ilike '%' || ? || '%' or l.summary ilike '%' || ? || '%')", f.q);
  params.push(f.limit ?? 50);
  const { rows } = await client.query<{ fetched_at: Date; first_created: Date | null }>(
    `select l.id, l.uri, l.headline, l.summary, l.language, l.tier, s.slug as source,
            l.first_created, l.fetched_at
     from leads l left join sources s on s.id = l.source_id
     ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
     order by l.fetched_at desc limit $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    first_created: r.first_created?.toISOString() ?? null,
    fetched_at: r.fetched_at.toISOString(),
  }));
}

/**
 * Queues one source's fetch now, as its schedule would (D190). Only a source whose terms a person
 * has read (D17) and that brings leads; one fetch per source at a time.
 */
export async function fetchSource(
  client: Client,
  boss: Pick<PgBoss, "send">,
  actor: PersonActor,
  sourceId: string,
) {
  const { rows } = await client.query<{
    newsroom_id: string;
    slug: string;
    use: string;
    terms_checked: string | null;
  }>(
    `select newsroom_id, slug, use, terms_checked::text from sources
     where id = $1 and removed_at is null`,
    [sourceId],
  );
  const source = rows[0];
  if (!source) throw new DeskError(404, "no such source");
  if (!source.terms_checked)
    throw new DeskError(409, "nobody has read this source's terms yet; it is never fetched (D17)");
  if (source.use !== "leads")
    throw new DeskError(409, `a source with use ${source.use} is not fetched on a schedule`);
  const job: IngestSourceJob = { newsroomId: source.newsroom_id, sourceId };
  const id = await boss.send(QUEUES.ingestSource, job, {
    db: onClient(client),
    singletonKey: sourceId,
  });
  await recordAudit(client, { actor, action: "fetch", entity: "sources", entityId: sourceId });
  return { id: sourceId, slug: source.slug, queued: id !== null };
}
