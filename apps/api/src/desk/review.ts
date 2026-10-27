// The review queue and an editor's decisions on it. Every decision is an audited update in the
// same transaction as the change it records (approvals live in Postgres, invariant 10).
import { QUEUES, type RedraftJob } from "@anr/core";
import { auditedUpdate, type Client, onClient, recordAudit } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

interface CheckRow {
  id: string;
  kind: string;
  name: string;
  result: string;
  claim: string | null;
  item: string | null;
  detail: unknown;
  at: Date;
}

/** Checks about a publication, its renditions, or its renditions' stories' claims. */
const CHECKS = `
  select k.id, k.kind, k.name, k.result, cl.ref as claim, k.item, k.detail, k.at
  from checks k
  left join claims cl on cl.id = k.claim_id
  where (k.publication_id = $1
     or k.rendition_id in (select rendition_id from publication_renditions where publication_id = $1)
     or k.claim_id in (
       select c.id from claims c join renditions r on r.story_id = c.story_id
       join publication_renditions pr on pr.rendition_id = r.id where pr.publication_id = $1))`;

const check = (k: CheckRow) => ({ ...k, at: k.at.toISOString() });

/** Held publications, oldest slot first, each with every check that did not pass. */
export async function reviewQueue(client: Client) {
  const { rows } = await client.query<{
    id: string;
    series: string;
    slot: Date;
    language: "fa" | "en" | "tr";
    title: string | null;
    unknown_posts: number;
  }>(
    `select p.id, s.slug as series, p.slot, p.language,
            coalesce(p.title, r.body->>'title') as title,
            (select count(*)::int from posts x where x.publication_id = p.id and x.status = 'unknown') as unknown_posts
     from publications p
     join series s on s.id = p.series_id
     left join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
     left join renditions r on r.id = pr.rendition_id
     where p.status = 'with-editor'
     order by p.slot, p.language`,
  );
  const out = [];
  for (const p of rows) {
    const { rows: holds } = await client.query<CheckRow>(
      `${CHECKS} and k.result <> 'pass' order by k.at`,
      [p.id],
    );
    out.push({ ...p, slot: p.slot.toISOString(), holds: holds.map(check) });
  }
  return out;
}

export async function deskPublication(client: Client, id: string) {
  const { rows } = await client.query<{
    id: string;
    series: string;
    slot: Date;
    language: "fa" | "en" | "tr";
    status: string;
    rendition: Record<string, unknown> | null;
    story_id: string | null;
  }>(
    `select p.id, s.slug as series, p.slot, p.language, p.status, r.body as rendition, r.story_id
     from publications p
     join series s on s.id = p.series_id
     left join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
     left join renditions r on r.id = pr.rendition_id
     where p.id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) throw new DeskError(404, "no such publication");
  const { rows: claims } = await client.query(
    `select c.ref, c.kind, c.text, l.uri as lead, c.quoted_passage
     from claims c left join leads l on l.id = c.lead_id
     where c.story_id = $1 and c.ref is not null order by length(c.ref), c.ref`,
    [p.story_id],
  );
  const { rows: checks } = await client.query<CheckRow>(`${CHECKS} order by k.at`, [id]);
  const { rows: posts } = await client.query<{ sent_at: Date | null }>(
    `select x.id, x.channel_id as channel, ch.kind, x.part, x.status, x.external_id, x.body,
            x.error, x.sent_at
     from posts x join channels ch on ch.id = x.channel_id
     where x.publication_id = $1 order by ch.kind, x.part`,
    [id],
  );
  const { story_id: _, ...rest } = p;
  return {
    ...rest,
    slot: p.slot.toISOString(),
    claims,
    checks: checks.map(check),
    posts: posts.map((x) => ({ ...x, sent_at: x.sent_at?.toISOString() ?? null })),
  };
}

async function heldPublication(client: Client, id: string) {
  const { rows } = await client.query<{ status: string; assignment_id: string | null }>(
    "select status, assignment_id from publications where id = $1 for update",
    [id],
  );
  const p = rows[0];
  if (!p) throw new DeskError(404, "no such publication");
  if (p.status !== "with-editor") throw new DeskError(409, `the publication is ${p.status}`);
  return p;
}

/**
 * Approves a held publication: it is scheduled, and the publisher sends it at its slot, or at
 * once if the slot has passed. A post whose result is unknown must be resolved first.
 */
export async function approve(client: Client, actor: Actor, id: string) {
  await heldPublication(client, id);
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from posts where publication_id = $1 and status = 'unknown'",
    [id],
  );
  if ((rows[0]?.n ?? 0) > 0)
    throw new DeskError(409, "say first whether each post with an unknown result went out");
  await auditedUpdate(client, actor, "approve", "publications", id, {
    status: "scheduled",
    updated_at: new Date(),
  });
  return { id, status: "scheduled" };
}

/**
 * Returns a held publication's assignment to the desk (lifecycle: With an editor → Assigned): its
 * held publications go back to `assigned` and the agents worker starts a new desk run (D87, D96).
 */
export async function returnToDesk(
  client: Client,
  boss: Pick<PgBoss, "send">,
  actor: Actor,
  id: string,
  note: string,
) {
  const p = await heldPublication(client, id);
  if (!p.assignment_id) throw new DeskError(409, "the publication has no assignment");
  const { rows } = await client.query<{ id: string }>(
    "select id from publications where assignment_id = $1 and status = 'with-editor' order by language for update",
    [p.assignment_id],
  );
  for (const sibling of rows) {
    await auditedUpdate(client, actor, "return", "publications", sibling.id, {
      status: "assigned",
      updated_at: new Date(),
    });
  }
  await recordAudit(client, {
    actor,
    action: "return",
    entity: "assignments",
    entityId: p.assignment_id,
    after: { note, publications: rows.map((r) => r.id) },
  });
  const { rows: n } = await client.query<{ id: string }>("select anr.current_newsroom_id() as id");
  const job: RedraftJob = { newsroomId: n[0]?.id ?? "", assignmentId: p.assignment_id };
  await boss.send(QUEUES.redraft, job, { db: onClient(client) });
  return { id, status: "assigned" };
}

/** Settles a post whose result was unknown: it went out (sent), or it is sent again (failed). */
export async function resolvePost(
  client: Client,
  actor: Actor,
  postId: string,
  wentOut: boolean,
  externalId?: string,
) {
  const { rows } = await client.query<{ status: string }>(
    "select status from posts where id = $1 for update",
    [postId],
  );
  if (!rows[0]) throw new DeskError(404, "no such post");
  if (rows[0].status !== "unknown") throw new DeskError(409, `the post is ${rows[0].status}`);
  const changes = wentOut
    ? {
        status: "sent",
        external_id: externalId ?? null,
        sent_at: new Date(),
        updated_at: new Date(),
      }
    : { status: "failed", attempted_at: null, updated_at: new Date() };
  await auditedUpdate(client, actor, "resolve-post", "posts", postId, changes);
  return { id: postId, status: changes.status };
}
