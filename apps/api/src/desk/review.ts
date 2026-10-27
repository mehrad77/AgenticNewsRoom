// The review queue and an editor's decisions on it. Every decision is an audited update in the
// same transaction as the change it records (approvals live in Postgres, invariant 10).
import { QUEUES, type RedraftJob, type TextField, withText } from "@anr/core";
import { auditedUpdate, type Client, onClient, recordAudit } from "@anr/db";
import { DRAFT_SCHEMAS } from "@anr/schemas";
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

/** Within this many minutes of their last open, a person's re-open is not recorded again. */
export const OPEN_DEDUPE_MINUTES = 10;

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

/**
 * One publication for the desk. Opening a held one is recorded, so the time from opening to
 * deciding can be measured (editor minutes, D99).
 */
export async function deskPublication(client: Client, actor: Actor, id: string) {
  const { rows } = await client.query<{
    id: string;
    series: string;
    slot: Date;
    language: "fa" | "en" | "tr";
    status: string;
    rendition: Record<string, unknown> | null;
    story_id: string | null;
    assignment_id: string | null;
  }>(
    `select p.id, s.slug as series, p.slot, p.language, p.status, r.body as rendition, r.story_id,
            p.assignment_id
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
  const { rows: runs } = await client.query<{ cost_usd: string | null; started_at: Date }>(
    `select id, role, provider, model, outcome, cost_usd, tokens_in, tokens_out, started_at
     from agent_runs
     where assignment_id = $1
        or story_id in (select r.story_id from publication_renditions pr
                        join renditions r on r.id = pr.rendition_id where pr.publication_id = $2)
     order by started_at`,
    [p.assignment_id, id],
  );
  if (p.status === "with-editor") await recordOpen(client, actor, id);
  const { story_id: _, assignment_id: __, ...rest } = p;
  const costs = runs.map((r) => (r.cost_usd === null ? null : Number(r.cost_usd)));
  return {
    ...rest,
    slot: p.slot.toISOString(),
    claims,
    checks: checks.map(check),
    posts: posts.map((x) => ({ ...x, sent_at: x.sent_at?.toISOString() ?? null })),
    runs: runs.map((r, i) => ({
      ...r,
      cost_usd: costs[i] ?? null,
      started_at: r.started_at.toISOString(),
    })),
    cost_usd: costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
  };
}

async function recordOpen(client: Client, actor: Actor, id: string) {
  const { rows } = await client.query(
    `select 1 from audit_log
     where entity = 'publications' and entity_id = $1 and action = 'open'
       and actor_user_id = $2 and at > now() - make_interval(mins => $3)`,
    [id, actor.userId, OPEN_DEDUPE_MINUTES],
  );
  if (rows.length === 0)
    await recordAudit(client, { actor, action: "open", entity: "publications", entityId: id });
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

/**
 * Changes text of a held publication's first rendition (D97). Only reader-facing strings change;
 * the result must still match the format's schema. A person's edit is what turns the label into
 * "edited by a person" and the IPTC source type into compositeSynthetic. Once a part went out, or
 * may have, the text is fixed: the parts already on the channel would no longer match.
 */
export async function editPublication(
  client: Client,
  actor: Actor,
  id: string,
  changes: TextField[],
) {
  await heldPublication(client, id);
  const { rows: out } = await client.query<{ n: number }>(
    "select count(*)::int as n from posts where publication_id = $1 and status in ('sent', 'unknown')",
    [id],
  );
  if ((out[0]?.n ?? 0) > 0)
    throw new DeskError(409, "a part has gone out, or may have: the text can no longer change");
  const { rows } = await client.query<{ id: string; body: unknown; format: string }>(
    `select r.id, r.body, f.slug as format from publication_renditions pr
     join renditions r on r.id = pr.rendition_id join formats f on f.id = r.format_id
     where pr.publication_id = $1 and pr.position = 1`,
    [id],
  );
  const rendition = rows[0];
  if (!rendition) throw new DeskError(409, "the publication has no text yet");
  let body: unknown;
  try {
    body = withText(rendition.body, changes);
  } catch (e) {
    throw new DeskError(400, (e as Error).message);
  }
  const parsed = DRAFT_SCHEMAS[rendition.format]?.safeParse({ rendition: body });
  if (parsed && !parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeskError(
      400,
      `the text no longer fits the format: ${issue?.path.slice(1).join("/")} ${issue?.message}`,
    );
  }
  if (JSON.stringify(body) === JSON.stringify(rendition.body)) return { id, status: "with-editor" };
  await auditedUpdate(client, actor, "edit", "renditions", rendition.id, {
    body: JSON.stringify(body),
  });
  await client.query("update publications set updated_at = now() where id = $1", [id]);
  return { id, status: "with-editor" };
}

/**
 * Takes a scheduled publication back before its slot (D100): it returns to the review queue with
 * the editor's note as its reason. Mid-send, the publisher stops before the next part.
 */
export async function pullBack(client: Client, actor: Actor, id: string, note: string) {
  const { rows } = await client.query<{ status: string }>(
    "select status from publications where id = $1 for update",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such publication");
  if (rows[0].status !== "scheduled")
    throw new DeskError(
      409,
      `only a scheduled publication can be pulled back; it is ${rows[0].status}`,
    );
  await client.query(
    `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
     values (anr.current_newsroom_id(), $1, 'policy', 'pulled-back', 'fail', $2)`,
    [id, JSON.stringify({ note })],
  );
  await auditedUpdate(client, actor, "pull-back", "publications", id, {
    status: "with-editor",
    updated_at: new Date(),
  });
  return { id, status: "with-editor" };
}

/** Publications whose slot is within `days`, not yet published, soonest first. */
export async function schedule(client: Client, days: number) {
  const { rows } = await client.query<{ slot: Date }>(
    `select p.id, s.slug as series, p.slot, p.language, p.status,
            coalesce(p.title, r.body->>'title') as title
     from publications p
     join series s on s.id = p.series_id
     left join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
     left join renditions r on r.id = pr.rendition_id
     where p.status in ('assigned', 'drafted', 'with-editor', 'scheduled')
       and p.slot >= now() - interval '1 hour' and p.slot < now() + make_interval(days => $1)
     order by p.slot, p.language`,
    [days],
  );
  return rows.map((r) => ({ ...r, slot: r.slot.toISOString() }));
}
