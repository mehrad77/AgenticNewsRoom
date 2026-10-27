// What an editor follows up on: the review sample of auto-published publications (D94) and the
// notices code leaves for the Editor-in-Chief.
import { auditedUpdate, type Client } from "@anr/db";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

const SAMPLE = `
  select s.id, s.publication_id as publication, p.title, p.language, s.sampled_at, s.outcome,
         s.note, s.reviewed_at, s.issue_url, s.filed_at
  from sample_reviews s join publications p on p.id = s.publication_id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;
const sample = (r: { sampled_at: Date; reviewed_at: Date | null; filed_at: Date | null }) => ({
  ...r,
  sampled_at: r.sampled_at.toISOString(),
  reviewed_at: iso(r.reviewed_at),
  filed_at: iso(r.filed_at),
});

export async function listSamples(client: Client) {
  const { rows } = await client.query(
    `${SAMPLE} order by s.outcome is not null, s.sampled_at desc limit 200`,
  );
  return rows.map(sample);
}

/**
 * Records an editor's review of a sampled publication. A miss says what the gate should have
 * caught; misses are what new checks and policy rules are made from.
 */
export async function reviewSample(
  client: Client,
  actor: Actor,
  id: string,
  outcome: string,
  note?: string,
) {
  if (outcome !== "ok" && outcome !== "miss") throw new DeskError(400, "outcome is ok or miss");
  const text = note?.trim() || null;
  if (outcome === "miss" && !text)
    throw new DeskError(400, "a miss needs a note: what should have been caught");
  const { rows } = await client.query<{ outcome: string | null }>(
    "select outcome from sample_reviews where id = $1 for update",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such sample");
  if (rows[0].outcome) throw new DeskError(409, "already reviewed");
  await auditedUpdate(client, actor, "review-sample", "sample_reviews", id, {
    outcome,
    note: text,
    reviewed_by: actor.userId,
    reviewed_at: new Date(),
  });
  const { rows: out } = await client.query(`${SAMPLE} where s.id = $1`, [id]);
  return sample(out[0]);
}

/**
 * Records the issue a miss was filed as (D102). Checks are code and policy rules are config, so
 * both change through the repository; the issue is where that change starts and links back here.
 */
export async function fileIssue(client: Client, actor: Actor, id: string, url: string) {
  if (!/^https:\/\/\S+$/.test(url) || url.length > 500)
    throw new DeskError(400, "the issue's https URL");
  const { rows } = await client.query<{ outcome: string | null }>(
    "select outcome from sample_reviews where id = $1 for update",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such sample");
  if (rows[0].outcome !== "miss") throw new DeskError(409, "only a miss is filed");
  await auditedUpdate(client, actor, "file-issue", "sample_reviews", id, {
    issue_url: url,
    filed_at: new Date(),
  });
  const { rows: out } = await client.query(`${SAMPLE} where s.id = $1`, [id]);
  return sample(out[0]);
}

export async function listNotices(client: Client) {
  const { rows } = await client.query<{ created_at: Date; read_at: Date | null }>(
    `select id, kind, key, detail, created_at, read_at from notices
     order by read_at is not null, created_at desc limit 200`,
  );
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
    read_at: iso(r.read_at),
  }));
}

export async function readNotice(client: Client, id: string) {
  const { rowCount } = await client.query(
    "update notices set read_at = coalesce(read_at, now()) where id = $1",
    [id],
  );
  if (rowCount === 0) throw new DeskError(404, "no such notice");
  return { id, status: "read" };
}
