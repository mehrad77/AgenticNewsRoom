// Sources at the desk: each source's health, failing first, and, since D192, adding, changing and
// removing sources and recording their terms, validated by the files' rules, rescheduled and
// audited in one transaction.
import {
  SOURCE_COLUMNS,
  type Source,
  type SourceRow,
  sourceFromRow,
  sourceSchedule,
  sourcesProblems,
  sourcesYaml,
} from "@anr/config";
import { QUEUES } from "@anr/core";
import { type Client, type PersonActor, recordAudit } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

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

/** What a source write needs beyond the transaction: pg-boss, to reschedule the source. */
export interface SourceWrites {
  boss: Pick<PgBoss, "schedule" | "unschedule">;
}

const FIELDS = [
  "kind",
  "url",
  "publisher",
  "tier",
  "every",
  "use",
  "terms_note",
  "pages",
  "vouches",
];

async function newsroom(client: Client) {
  const { rows } = await client.query<{ id: string; slug: string; timezone: string }>(
    "select id, slug, timezone from newsrooms where id = anr.current_newsroom_id()",
  );
  return rows[0] as { id: string; slug: string; timezone: string };
}

async function rows(client: Client): Promise<SourceRow[]> {
  const { rows } = await client.query<SourceRow>(
    `select ${SOURCE_COLUMNS} from sources where removed_at is null order by slug`,
  );
  return rows;
}

/** The newsroom's sources as they would be, checked by the rules of sources.yaml (D192). */
function validate(slug: string, sources: Source[]) {
  const problems = sourcesProblems(sources, `newsrooms/${slug}/sources.yaml`);
  if (problems.length > 0) throw new DeskError(400, "the source is not valid", problems);
}

/** Makes the source's fetch schedule what its row asks for, in the same transaction. */
async function reschedule(
  client: Client,
  boss: SourceWrites["boss"],
  n: { id: string; timezone: string },
  row: SourceRow | null,
  id: string,
) {
  const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
  const schedule = row && sourceSchedule(n.id, n.timezone, { ...sourceFromRow(row), id: row.id });
  if (schedule)
    await boss.schedule(schedule.queue, schedule.cron, schedule.data, {
      tz: schedule.tz,
      key: schedule.key,
      missed: schedule.missed,
      db,
    });
  else await boss.unschedule(QUEUES.ingestSource, id, { db });
}

async function write(
  client: Client,
  w: SourceWrites,
  actor: PersonActor,
  action: string,
  change: (sources: Source[]) => { sources: Source[]; slug: string },
) {
  const n = await newsroom(client);
  const before = await rows(client);
  const { sources, slug } = change(before.map(sourceFromRow));
  validate(n.slug, sources);
  const wanted = sources.find((s) => s.id === slug);
  const old = before.find((r) => r.slug === slug);
  let id: string;
  if (!wanted) {
    if (!old) throw new DeskError(404, "no such source");
    await client.query(
      `update sources set removed_at = now(), updated_at = now(), edited_at = now(), edited_by = $2
       where id = $1`,
      [old.id, actor.userId],
    );
    id = old.id;
  } else {
    const { rows: written } = await client.query<{ id: string }>(
      `insert into sources (newsroom_id, slug, kind, url, publisher, tier, fetch_every, use,
         terms_checked, terms_note, fetch_pages, vouches, edited_at, edited_by)
       values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6::interval, $7, $8, $9, $10, $11, now(), $12)
       on conflict (newsroom_id, slug) do update set kind = excluded.kind, url = excluded.url,
         publisher = excluded.publisher, tier = excluded.tier, fetch_every = excluded.fetch_every,
         use = excluded.use, terms_checked = excluded.terms_checked, terms_note = excluded.terms_note,
         fetch_pages = excluded.fetch_pages, vouches = excluded.vouches, updated_at = now(),
         removed_at = null, edited_at = now(), edited_by = excluded.edited_by
       returning id`,
      [
        wanted.id,
        wanted.kind,
        wanted.url,
        wanted.publisher ?? null,
        wanted.tier,
        intervalOf(wanted.every),
        wanted.use ?? "leads",
        wanted.terms_checked ?? null,
        wanted.terms_note ?? null,
        wanted.pages ?? true,
        wanted.vouches ?? [],
        actor.userId,
      ],
    );
    id = written[0]?.id as string;
  }
  const after = (await rows(client)).find((r) => r.id === id) ?? null;
  await reschedule(client, w.boss, n, after, id);
  await recordAudit(client, {
    actor,
    action,
    entity: "sources",
    entityId: id,
    before: old ? sourceFromRow(old) : undefined,
    after: after ? sourceFromRow(after) : undefined,
  });
  return after
    ? { ...sourceFromRow(after), source_id: id }
    : { id: slug, source_id: id, removed: true };
}

const UNITS: Record<string, string> = { m: "minutes", h: "hours", d: "days" };
const intervalOf = (every: string) => `${every.slice(0, -1)} ${UNITS[every.slice(-1)] ?? "?"}`;

/** Adds a source (D192). Its terms are recorded apart, by the person who read them. */
export async function addSource(
  client: Client,
  w: SourceWrites,
  actor: PersonActor,
  input: Record<string, unknown>,
) {
  if ("terms_checked" in input)
    throw new DeskError(400, "record that you read the terms with setSourceTerms, after adding it");
  const slug = typeof input.id === "string" ? input.id : "";
  return write(client, w, actor, "add-source", (sources) => {
    if (sources.some((s) => s.id === slug)) throw new DeskError(409, `source ${slug} exists`);
    return { sources: [...sources, input as Source], slug };
  });
}

/** Changes a source's fields; its slug stays, and its terms are set apart. */
export async function updateSource(
  client: Client,
  w: SourceWrites,
  actor: PersonActor,
  id: string,
  input: Record<string, unknown>,
) {
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k));
  if (unknown.length > 0)
    throw new DeskError(400, `cannot change ${unknown.join(", ")} here (terms: setSourceTerms)`);
  const slug = await slugOf(client, id);
  return write(client, w, actor, "edit-source", (sources) => ({
    sources: sources.map((s) => {
      if (s.id !== slug) return s;
      const next = { ...s, ...input } as Record<string, unknown>;
      // A field set to null goes back to its default.
      for (const [k, v] of Object.entries(input)) if (v === null) delete next[k];
      return next as Source;
    }),
    slug,
  }));
}

export async function removeSource(
  client: Client,
  w: SourceWrites,
  actor: PersonActor,
  id: string,
) {
  const slug = await slugOf(client, id);
  return write(client, w, actor, "remove-source", (sources) => ({
    sources: sources.filter((s) => s.id !== slug),
    slug,
  }));
}

/**
 * Records that the acting person read the source's terms today (D17), or withdraws it. Only for a
 * person who has read them; it is what lets ingestion fetch the source.
 */
export async function setSourceTerms(
  client: Client,
  w: SourceWrites,
  actor: PersonActor,
  id: string,
  input: Record<string, unknown>,
) {
  if (typeof input.read !== "boolean") throw new DeskError(400, "read: true or false");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000))
    throw new DeskError(400, "note: at most 2,000 characters");
  const slug = await slugOf(client, id);
  const { rows: today } = await client.query<{ today: string }>(
    "select (now() at time zone 'utc')::date::text as today",
  );
  const result = await write(
    client,
    w,
    actor,
    input.read ? "terms-read" : "terms-withdrawn",
    (sources) => ({
      sources: sources.map((s) => {
        if (s.id !== slug) return s;
        const { terms_checked: _, ...rest } = s;
        return {
          ...rest,
          ...(input.read === true && { terms_checked: today[0]?.today }),
          ...(typeof input.note === "string" && input.note && { terms_note: input.note }),
        } as Source;
      }),
      slug,
    }),
  );
  await client.query(
    "update sources set terms_checked_by = $2, terms_checked_at = $3 where id = $1",
    [id, input.read ? actor.userId : null, input.read ? new Date() : null],
  );
  return result;
}

async function slugOf(client: Client, id: string) {
  const { rows } = await client.query<{ slug: string }>(
    "select slug from sources where id = $1 and removed_at is null",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such source");
  return rows[0].slug;
}

/** The newsroom's sources as the text of its sources.yaml (D192). */
export async function exportSources(client: Client): Promise<string> {
  return sourcesYaml((await rows(client)).map(sourceFromRow));
}
