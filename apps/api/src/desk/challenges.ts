// Readers' challenges and corrections (charter: editorial safeguards 3; D114–D116). A reader's
// challenge is acknowledged within 24 hours and answered within 48; an upheld one becomes a
// correction on every affected publication and a check on the claim that was wrong.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  type ChallengeDeadlineJob,
  challengeDeadlines,
  challengeSteps,
  type PublishCorrectionJob,
  QUEUES,
} from "@anr/core";
import { auditedUpdate, type Client, onClient, type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };
type Boss = Pick<PgBoss, "send">;

/** Challenges per (UTC) day: from one reader to a newsroom, to one piece, and to a newsroom. */
export const PER_READER_PER_DAY = 5;
export const PER_PUBLICATION_PER_DAY = 20;
export const PER_NEWSROOM_PER_DAY = 200;

/** A reader's network: the address, or its /64 for IPv6, which one household can rotate within. */
export function readerNetwork(address: string): string {
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const groups = [...head.split(":"), ...Array(8).fill("0"), ...tail.split(":")].filter(Boolean);
  return `${groups.slice(0, 4).join(":")}::/64`;
}

let daily: { day: string; secret: Buffer } | undefined;

/**
 * The rate key (D114): an HMAC of the reader's network under a random secret kept in memory for
 * one UTC day and then dropped, so yesterday's keys cannot be linked to anyone, even with the
 * platform key. A restart starts a new secret (and new counts).
 */
export function readerKey(address: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  if (daily?.day !== day) daily = { day, secret: randomBytes(32) };
  return createHmac("sha256", daily.secret).update(readerNetwork(address)).digest("hex");
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest();

/** The reader's address behind the site's proxy: the last X-Forwarded-For entry (D110). */
export function readerAddress(forwarded: string | undefined, fallback = "unknown"): string {
  const last = forwarded?.split(",").at(-1)?.trim();
  return last || fallback;
}

export interface ChallengeInput {
  newsroom: string;
  publicationId: string;
  text: string;
  sourceUrl?: string;
  address: string;
}

/**
 * A reader's challenge to a published piece: stored with its owner and deadlines, and the four
 * reminder and deadline jobs queued in the same transaction (D114).
 */
export async function submitChallenge(
  pool: Pool,
  boss: Boss,
  input: ChallengeInput,
  now: Date = new Date(),
) {
  const { rows: newsrooms } = await pool.query<{ id: string }>(
    "select id from newsrooms where slug = $1 and removed_at is null",
    [input.newsroom],
  );
  const newsroom = newsrooms[0];
  if (!newsroom) throw new DeskError(404, "no such newsroom");
  return withNewsroom(pool, newsroom.id, async (client) => {
    const { rows } = await client.query<{ owner: string }>(
      `select n.corrections_owner as owner from publications p join newsrooms n on n.id = p.newsroom_id
       where p.id = $1 and p.status in ('published', 'corrected')`,
      [input.publicationId],
    );
    const owner = rows[0]?.owner;
    if (!owner) throw new DeskError(404, "no such publication");
    const key = readerKey(input.address, now);
    // One count at a time per newsroom, so parallel posts cannot all pass the limit.
    await client.query("select pg_advisory_xact_lock(hashtext('challenges:' || $1))", [
      newsroom.id,
    ]);
    const { rows: counts } = await client.query<{
      reader: number;
      publication: number;
      newsroom: number;
    }>(
      `select count(*) filter (where reader_key = $1)::int as reader,
              count(*) filter (where publication_id = $2)::int as publication,
              count(*)::int as newsroom
       from challenges where created_at >= date_trunc('day', $3::timestamptz at time zone 'UTC') at time zone 'UTC'`,
      [key, input.publicationId, now],
    );
    const c = counts[0];
    if (
      c &&
      (c.reader >= PER_READER_PER_DAY ||
        c.publication >= PER_PUBLICATION_PER_DAY ||
        c.newsroom >= PER_NEWSROOM_PER_DAY)
    )
      throw new DeskError(429, "too many challenges today; please try again tomorrow");
    const token = randomBytes(24).toString("base64url");
    const deadlines = challengeDeadlines(now);
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into challenges (newsroom_id, publication_id, reader_text, source_url, owner,
                               acknowledge_by, answer_by, token_hash, reader_key, created_at)
       values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        input.publicationId,
        input.text,
        input.sourceUrl ?? null,
        owner,
        deadlines.acknowledgeBy,
        deadlines.answerBy,
        tokenHash(token),
        key,
        now,
      ],
    );
    const id = inserted[0]?.id as string;
    for (const s of challengeSteps(deadlines)) {
      const job: ChallengeDeadlineJob = {
        newsroomId: newsroom.id,
        challengeId: id,
        step: s.step,
        at: s.at,
      };
      await boss.send(QUEUES.challengeDeadline, job, {
        db: onClient(client),
        startAfter: s.when,
        singletonKey: `${id}:${s.step}:${s.at}`,
      });
    }
    return {
      id,
      token,
      acknowledge_by: deadlines.acknowledgeBy.toISOString(),
      answer_by: deadlines.answerBy.toISOString(),
    };
  });
}

const CHALLENGE = `
  select k.id, k.publication_id as publication, p.title, p.language, p.path, k.reader_text,
         k.source_url, k.owner, k.created_at, k.acknowledge_by, k.answer_by, k.acknowledged_at,
         k.acknowledgement, k.answered_at, k.answer, k.outcome, k.issue_url, k.filed_at,
         (coalesce(k.acknowledged_at, now()) > k.acknowledge_by
          or coalesce(k.answered_at, now()) > k.answer_by) as overdue
  from challenges k join publications p on p.id = k.publication_id`;

type Row = Record<string, unknown> & {
  created_at: Date;
  acknowledge_by: Date;
  answer_by: Date;
  acknowledged_at: Date | null;
  answered_at: Date | null;
  filed_at: Date | null;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const challenge = (r: Row) => ({
  ...r,
  created_at: r.created_at.toISOString(),
  acknowledge_by: r.acknowledge_by.toISOString(),
  answer_by: r.answer_by.toISOString(),
  acknowledged_at: iso(r.acknowledged_at),
  answered_at: iso(r.answered_at),
  filed_at: iso(r.filed_at),
});

export async function listChallenges(client: Client) {
  const { rows } = await client.query<Row>(
    `${CHALLENGE} order by k.answered_at is not null, k.answer_by, k.created_at desc limit 200`,
  );
  return rows.map(challenge);
}

/** The story a publication went out with: its first rendition's. */
const STORY = `(select r.story_id from publication_renditions pr join renditions r on r.id = pr.rendition_id
                where pr.publication_id = $1 and pr.position = 1)`;

/**
 * Published publications whose stories hold `roots` or a copy of one (an episode's, D107):
 * what a correction of those claims covers.
 */
const LINEAGE = (roots: string, statuses = "'published', 'corrected'") => `
  with recursive down (id, story_id) as (
    select c.id, c.story_id from claims c where c.id in (${roots})
    union all
    select c.id, c.story_id from claims c join down on c.copied_from = down.id
  )
  select distinct p.id, p.title, p.language, p.path from publications p
  join publication_renditions pr on pr.publication_id = p.id
  join renditions r on r.id = pr.rendition_id
  where r.story_id in (select story_id from down) and p.status in (${statuses})
  order by p.language, p.path`;

/** The original of a claim: followed up `copied_from` to the claim a desk wrote. */
const ROOTS = (claims: string) => `
  with recursive up (id, copied_from) as (
    select id, copied_from from claims where id in (${claims})
    union all
    select c.id, c.copied_from from claims c join up on c.id = up.copied_from
  )
  select id from up where copied_from is null`;

export async function getChallenge(client: Client, id: string) {
  const { rows } = await client.query<Row & { publication: string }>(
    `${CHALLENGE} where k.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new DeskError(404, "no such challenge");
  const { rows: claims } = await client.query<{
    id: string;
    ref: string;
    kind: string;
    text: string;
  }>(`select id, ref, kind, text from claims where story_id = ${STORY} order by created_at, ref`, [
    row.publication,
  ]);
  // Which languages a correction of each claim needs a notice in (the uphold's own rule).
  const languages = async (claimId: string) => {
    const { rows: pubs } = await client.query<{ language: string }>(LINEAGE(ROOTS("$1::uuid")), [
      claimId,
    ]);
    return [...new Set(pubs.map((p) => p.language))].sort();
  };
  const claimLanguages = await Promise.all(claims.map((k) => languages(k.id)));
  const { rows: affected } = await client.query(
    LINEAGE(ROOTS(`select id from claims where story_id = ${STORY}`)),
    [row.publication],
  );
  const { rows: corrections } = await client.query<{ published_at: Date | null }>(
    `select k.publication_id as publication, p.language, k.notice, k.published_at
     from corrections k join publications p on p.id = k.publication_id
     where k.challenge_id = $1 order by p.language`,
    [id],
  );
  const { rows: lesson } = await client.query<{ lesson: string }>(
    `select k.detail->>'lesson' as lesson from checks k
     where k.kind = 'correction' and k.detail->>'challenge' = $1 limit 1`,
    [id],
  );
  return {
    ...challenge(row),
    lesson: lesson[0]?.lesson ?? null,
    claims: claims.map((k, i) => ({
      ref: k.ref,
      kind: k.kind,
      text: k.text,
      languages: claimLanguages[i] ?? [],
    })),
    affected,
    corrections: corrections.map((c) => ({ ...c, published_at: iso(c.published_at) })),
  };
}

/** Locks an open challenge; answered ones cannot change. */
async function openChallenge(client: Client, id: string) {
  const { rows } = await client.query<{ acknowledged_at: Date | null; answered_at: Date | null }>(
    "select acknowledged_at, answered_at from challenges where id = $1 for update",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DeskError(404, "no such challenge");
  if (row.answered_at) throw new DeskError(409, "already answered");
  return row;
}

/** An answer acknowledges too, if nobody did yet. */
const acknowledging = (row: { acknowledged_at: Date | null }, actor: Actor, now: Date) =>
  row.acknowledged_at ? {} : { acknowledged_at: now, acknowledged_by: actor.userId };

export async function acknowledgeChallenge(
  client: Client,
  actor: Actor,
  id: string,
  note: string | undefined,
  now: Date = new Date(),
) {
  const row = await openChallenge(client, id);
  if (row.acknowledged_at) throw new DeskError(409, "already acknowledged");
  await auditedUpdate(client, actor, "acknowledge", "challenges", id, {
    ...acknowledging(row, actor, now),
    acknowledgement: note?.trim() || null,
  });
  return getChallenge(client, id);
}

export async function rejectChallenge(
  client: Client,
  actor: Actor,
  id: string,
  answer: string,
  now: Date = new Date(),
) {
  const row = await openChallenge(client, id);
  await auditedUpdate(client, actor, "reject", "challenges", id, {
    ...acknowledging(row, actor, now),
    outcome: "rejected",
    answer,
    answered_at: now,
    answered_by: actor.userId,
  });
  return getChallenge(client, id);
}

export interface Uphold {
  answer: string;
  /** The ref of the claim that was wrong, in the challenged piece's story. */
  claim: string;
  /** What the gate should have caught. */
  lesson: string;
  notices: Record<string, string>;
}

/**
 * Upholds a challenge (D115, D116): a `correction` check fails the original of the claim that was
 * wrong, so the gate fails it and every copy from now on; each published publication holding it
 * gets a correction notice in its language; the publisher publishes them.
 */
export async function upholdChallenge(
  client: Client,
  boss: Boss,
  actor: Actor,
  id: string,
  u: Uphold,
  now: Date = new Date(),
) {
  const row = await openChallenge(client, id);
  const { rows: pub } = await client.query<{ publication: string; newsroom: string }>(
    "select publication_id as publication, newsroom_id as newsroom from challenges where id = $1",
    [id],
  );
  const publication = pub[0]?.publication as string;
  const { rows: named } = await client.query<{ id: string }>(
    `select id from claims where story_id = ${STORY} and ref = $2`,
    [publication, u.claim],
  );
  const claim = named[0];
  if (!claim) throw new DeskError(400, `the piece's story has no claim ${u.claim}`);
  const { rows: roots } = await client.query<{ id: string }>(ROOTS("$1::uuid"), [claim.id]);
  const root = roots[0]?.id ?? claim.id;
  const { rows: affected } = await client.query<{ id: string; language: string }>(
    LINEAGE("$1::uuid"),
    [root],
  );
  const notice = (language: string) => u.notices[language]?.trim();
  const missing = [...new Set(affected.map((p) => p.language))].filter((l) => !notice(l));
  if (missing.length > 0)
    throw new DeskError(400, `a correction notice is needed in ${missing.join(", ")}`);

  const { rows: check } = await client.query<{ id: string }>(
    `insert into checks (newsroom_id, claim_id, kind, name, result, detail)
     values (anr.current_newsroom_id(), $1, 'correction', 'correction', 'fail', $2) returning id`,
    [root, JSON.stringify({ challenge: id, ref: u.claim, lesson: u.lesson })],
  );
  for (const p of affected) {
    await client.query(
      `insert into corrections (newsroom_id, publication_id, challenge_id, check_id, notice)
       values (anr.current_newsroom_id(), $1, $2, $3, $4)`,
      [p.id, id, check[0]?.id, notice(p.language)],
    );
  }
  // Not yet out: a scheduled piece holding the claim is pulled back, and a held one shows why;
  // ones still being written meet the gate's `corrected-claim` check.
  const { rows: pending } = await client.query<{ id: string; status: string }>(
    `select x.id, p.status from (${LINEAGE("$1::uuid", "'with-editor', 'scheduled'")}) x
     join publications p on p.id = x.id for update of p`,
    [root],
  );
  for (const p of pending) {
    await client.query(
      `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
       values (anr.current_newsroom_id(), $1, 'policy', 'corrected-claim', 'fail', $2)`,
      [p.id, JSON.stringify({ challenge: id, ref: u.claim })],
    );
    if (p.status === "scheduled")
      await auditedUpdate(client, actor, "pull-back", "publications", p.id, {
        status: "with-editor",
        updated_at: now,
      });
  }
  await auditedUpdate(client, actor, "uphold", "challenges", id, {
    ...acknowledging(row, actor, now),
    outcome: "upheld",
    answer: u.answer,
    answered_at: now,
    answered_by: actor.userId,
  });
  const job: PublishCorrectionJob = { newsroomId: pub[0]?.newsroom as string, challengeId: id };
  await boss.send(QUEUES.publishCorrection, job, { db: onClient(client), singletonKey: id });
  return getChallenge(client, id);
}

/** Records the issue an upheld challenge's lesson was filed as (as for sample misses, D102). */
export async function fileChallengeIssue(client: Client, actor: Actor, id: string, url: string) {
  if (!/^https:\/\/\S+$/.test(url)) throw new DeskError(400, "url: the issue's https address");
  const { rows } = await client.query<{ outcome: string | null }>(
    "select outcome from challenges where id = $1 for update",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such challenge");
  if (rows[0].outcome !== "upheld") throw new DeskError(409, "only an upheld challenge is filed");
  await auditedUpdate(client, actor, "file-issue", "challenges", id, {
    issue_url: url,
    filed_at: new Date(),
  });
  return getChallenge(client, id);
}
