// Publishes one scheduled publication whose slot has come (docs/technical-design.md#publishing):
// renders each channel's parts, sends them in order with a Post row per part, then puts the piece
// on the site. Only code publishes; no model is called here.
import { type Language, pageUrl, type SiteAddress } from "@anr/core";
import {
  auditedUpdate,
  type Client,
  openCredentials,
  type PlatformKey,
  type Pool,
  withNewsroom,
} from "@anr/db";
import {
  channelKinds,
  type createRenderer,
  editedByPerson,
  seriesVoicesNote,
  sitePath,
  templateContext,
} from "@anr/render";
import { type ChannelAdapter, type ChannelTarget, SendError } from "./channels/types.ts";
import { holdPublication } from "./hold.ts";
import { type MediaDeps, prepareMedia } from "./media.ts";

export type { ChannelAdapter };

export const PUBLISHER = { kind: "code", name: "publisher" } as const;

/** Share of auto-published publications an editor reviews afterwards (charter: approval). */
export const SAMPLE_RATE = 0.1;

/** How long past its slot a rate-limited or unreachable channel is retried before a hold. */
export const RETRY_WINDOW_MS = 60 * 60_000;

export interface PublishDeps {
  pool: Pool;
  renderer: ReturnType<typeof createRenderer>;
  /** By channel kind; a kind without an adapter cannot be sent to. */
  adapters: Partial<Record<string, ChannelAdapter>>;
  platform: PlatformKey;
  /** Writes and signs the images a publication shows (D120); without it, such a piece is held. */
  media?: MediaDeps;
  rootDomain: string;
  devPort?: number;
  now?: () => Date;
  random?: () => number;
}

export type PublishOutcome = "published" | "held" | "retry" | "busy" | "not-due";

interface PublicationRow {
  id: string;
  status: string;
  slot: Date;
  language: Language;
  updated_at: Date;
  series_slug: string;
  channels: Record<string, string[]>;
  format: string;
  subdomain: string;
  languages: Language[];
  timezone: string;
}

interface PostRow {
  id: string;
  channel_id: string;
  part: number;
  status: "pending" | "sent" | "unknown" | "failed";
  body: string;
  attempted_at: Date | null;
}

interface Plan {
  publication: PublicationRow;
  site: SiteAddress;
  rendition: Record<string, unknown>;
  renditionIds: string[];
  targets: { target: ChannelTarget; posts: PostRow[] }[];
}

/** Runs `fn` while holding this publication's session lock, or returns "busy". */
async function locked(
  pool: Pool,
  publicationId: string,
  fn: () => Promise<PublishOutcome>,
): Promise<PublishOutcome> {
  const client = await pool.connect();
  const key = `publish:${publicationId}`;
  let broken: Error | undefined;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
      [key],
    );
    if (!rows[0]?.ok) return "busy";
    try {
      return await fn();
    } finally {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch((error: Error) => {
          broken = error;
        });
    }
  } finally {
    // A connection that could not unlock is destroyed, which releases the lock.
    client.release(broken);
  }
}

/** Every string a reader sees in a rendition body, for site search. */
function searchText(body: unknown): string {
  const skip = new Set(["kind", "claim_ids", "lead_id", "id"]);
  const out: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (key && skip.has(key)) return;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(body);
  return out.join("\n");
}

type Prepared = { kind: "plan"; plan: Plan } | { kind: "done"; outcome: PublishOutcome };

/**
 * One transaction: checks the publication may go out, settles any part a crash left in flight,
 * and writes a pending Post row with its text for every part not yet recorded.
 */
async function prepare(
  deps: PublishDeps,
  client: Client,
  id: string,
  now: Date,
): Promise<Prepared> {
  const { rows } = await client.query<PublicationRow>(
    `select p.id, p.status, p.slot, p.language, p.updated_at, s.slug as series_slug,
            coalesce(s.config->'channels', '{}') as channels, f.slug as format,
            n.subdomain, n.languages, n.timezone
     from publications p
     join series s on s.id = p.series_id
     join formats f on f.id = s.format_id
     join newsrooms n on n.id = p.newsroom_id
     where p.id = $1
     for update of p`,
    [id],
  );
  const p = rows[0];
  if (p?.status !== "scheduled" || p.slot > now) return { kind: "done", outcome: "not-due" };
  const hold = async (name: string, detail: unknown): Promise<Prepared> => {
    await holdPublication(client, id, { name, result: "fail", detail });
    return { kind: "done", outcome: "held" };
  };

  // After a restore, a slot already past due may have gone out before the backup ended (D90).
  const { rows: restore } = await client.query<{ at: Date | null }>(
    "select max(restored_at) as at from restores",
  );
  const restoredAt = restore[0]?.at;
  if (restoredAt && p.slot <= restoredAt && p.updated_at < restoredAt)
    return hold("restored", { restored_at: restoredAt, slot: p.slot });

  const { rows: posts } = await client.query<PostRow>(
    `select id, channel_id, part, status, body, attempted_at from posts
     where publication_id = $1 order by channel_id, part`,
    [id],
  );
  // A part whose call started but never recorded a result may have been delivered (D89).
  const inFlight = posts.filter((x) => x.status === "pending" && x.attempted_at !== null);
  for (const post of inFlight) {
    await client.query(
      `update posts set status = 'unknown', updated_at = now(),
         error = '{"failure": "unknown", "message": "interrupted during the send"}'
       where id = $1`,
      [post.id],
    );
    post.status = "unknown";
  }
  const unknown = posts.filter((x) => x.status === "unknown");
  if (unknown.length > 0)
    return hold("post-unknown", { posts: unknown.map((x) => ({ id: x.id, part: x.part })) });

  const { rows: renditions } = await client.query<{ id: string; body: Record<string, unknown> }>(
    `select r.id, r.body from publication_renditions pr
     join renditions r on r.id = pr.rendition_id
     where pr.publication_id = $1 order by pr.position`,
    [id],
  );
  const first = renditions[0];
  if (!first) return hold("no-rendition", {});
  const media = await prepareMedia(
    client,
    deps.media,
    renditions.map((r) => r.body),
  );
  if (media.kind === "hold") return hold(media.name, media.detail);

  const site = {
    subdomain: p.subdomain,
    rootDomain: deps.rootDomain,
    languages: p.languages,
    devPort: deps.devPort,
  };
  const base = {
    publication: p,
    site,
    rendition: first.body,
    renditionIds: renditions.map((r) => r.id),
  };
  const kinds = channelKinds(p.channels, p.language);
  const { rows: channels } = await client.query<{
    id: string;
    kind: string;
    external_id: string | null;
    credentials: Buffer | null;
  }>(
    `select id, kind, external_id, credentials from channels
     where kind = any($1) and language = $2 and status = 'active' order by created_at`,
    [kinds, p.language],
  );

  // A series may name a channel the newsroom has not set up: skipped, the editor told once (D91).
  for (const kind of kinds.filter((k) => !channels.some((c) => c.kind === k))) {
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), 'no-channel', $1, $2)
       on conflict (newsroom_id, kind, key) do nothing`,
      [
        `${kind}:${p.language}`,
        JSON.stringify({ kind, language: p.language, series: p.series_slug }),
      ],
    );
  }

  const edited = await editedByPerson(client, id, base.renditionIds);
  let voicesNote: string | undefined;
  if (p.format === "podcast-episode") {
    // Nothing goes out before the audio made from this version of the script (D109): audio made
    // after the publication last changed (its approval, or an edit before it).
    const { rowCount: ready } = await client.query(
      "select from episodes where publication_id = $1 and rendition_id = $2 and created_at >= $3",
      [id, first.id, p.updated_at],
    );
    if (!ready) {
      if (now.getTime() - p.slot.getTime() <= RETRY_WINDOW_MS)
        return { kind: "done", outcome: "retry" };
      return hold("audio-missing", { reason: "no audio was made for the approved script" });
    }
    voicesNote = await seriesVoicesNote(client, deps.renderer, p.series_slug, p.language);
  }
  const context = await templateContext(client, {
    voicesNote,
    publicationId: id,
    rendition: first.body,
    edited,
    site,
    language: p.language,
    seriesSlug: p.series_slug,
    slot: p.slot,
    timezone: p.timezone,
  });
  const newsroomId = await currentNewsroom(client);
  const targets: Plan["targets"] = [];
  for (const channel of channels) {
    if (!deps.adapters[channel.kind]) return hold("channel-unsupported", { kind: channel.kind });
    let credentials: Record<string, string> = {};
    try {
      if (channel.credentials)
        credentials = openCredentials(
          channel.credentials,
          { newsroomId, channelId: channel.id },
          deps.platform,
        );
    } catch (error) {
      return hold("channel-credentials", { channel: channel.id, error: (error as Error).message });
    }
    const target = {
      id: channel.id,
      kind: channel.kind,
      externalId: channel.external_id,
      credentials,
    };
    let parts: string[];
    try {
      parts = await deps.renderer.renderParts(p.format, channel.kind, p.language, context);
    } catch (error) {
      return hold("render", { channel: channel.id, error: (error as Error).message });
    }
    // Invariant 8: nothing goes out without the label, whatever the template does.
    const label = await deps.renderer.disclosureLabel(p.language, edited);
    if (!parts.every((x) => x.includes(label)))
      return hold("disclosure", { channel: channel.id, missing_label: label });
    let own = posts.filter((x) => x.channel_id === channel.id);
    const same = own.length === parts.length && own.every((x, i) => x.body === parts[i]);
    if (own.length > 0 && !same) {
      // The text changed since the parts were stored (an editor's edit after a hold). Parts never
      // tried are replaced; once one went out, a person decides (D89).
      if (own.some((x) => x.status === "sent"))
        return hold("changed-after-send", { channel: channel.id });
      await client.query("delete from posts where publication_id = $1 and channel_id = $2", [
        id,
        channel.id,
      ]);
      own = [];
    }
    if (own.length === 0) {
      // Each part's text is stored before any call; a retry sends exactly these bytes.
      for (const [i, body] of parts.entries()) {
        const part = i + 1;
        const { rows: inserted } = await client.query<PostRow>(
          `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body)
           values (anr.current_newsroom_id(), $1, $2, $3, $4, $5)
           returning id, channel_id, part, status, body, attempted_at`,
          [id, channel.id, part, `${id}:${channel.id}:${part}`, body],
        );
        if (inserted[0]) own.push(inserted[0]);
      }
    }
    targets.push({ target, posts: own });
  }
  return { kind: "plan", plan: { ...base, targets } };
}

async function currentNewsroom(client: Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>("select anr.current_newsroom_id() as id");
  return rows[0]?.id ?? "";
}

/** Sends every unsent part in order; stops at the first that does not go out. */
async function send(
  deps: PublishDeps,
  newsroomId: string,
  id: string,
  plan: Plan,
  now: Date,
): Promise<PublishOutcome | null> {
  for (const { target, posts } of plan.targets) {
    const adapter = deps.adapters[target.kind];
    if (!adapter) continue;
    for (const post of posts) {
      if (post.status === "sent") continue;
      // Committed before the call: from here a crash leaves evidence the part may have gone out.
      // Only while the publication is still scheduled: an editor may have held it mid-send.
      const started = await withNewsroom(deps.pool, newsroomId, async (c) => {
        const { rowCount } = await c.query(
          `update posts set status = 'pending', attempted_at = now(), updated_at = now()
           where id = $1 and status in ('pending', 'failed')
             and exists (select 1 from publications where id = $2 and status = 'scheduled')`,
          [post.id, id],
        );
        return rowCount === 1;
      });
      if (!started) return "not-due";
      let messageId: string;
      try {
        messageId = await adapter.send(target, post.body);
      } catch (error) {
        const e =
          error instanceof SendError ? error : new SendError("unknown", (error as Error).message);
        return withNewsroom(deps.pool, newsroomId, async (c) => {
          const failed = e.failure === "unknown" ? "unknown" : "failed";
          await c.query(
            `update posts set status = $2, error = $3, updated_at = now(),
               attempted_at = case when $2 = 'failed' then null else attempted_at end
             where id = $1`,
            [
              post.id,
              failed,
              JSON.stringify({ failure: e.failure, message: e.message, retry_after: e.retryAfter }),
            ],
          );
          // A rate limit or an unreachable channel: the next sweep tries again, the slot is kept,
          // until it is an hour late; then a person decides.
          const late = now.getTime() - plan.publication.slot.getTime() > RETRY_WINDOW_MS;
          if (e.failure === "retry" && !late) return "retry";
          await holdPublication(c, id, {
            name:
              e.failure === "unknown"
                ? "post-unknown"
                : e.failure === "retry"
                  ? "channel-unreachable"
                  : "channel-rejected",
            result: "fail",
            detail: { channel: target.id, part: post.part, error: e.message },
          });
          return "held";
        });
      }
      await recordSent(deps, newsroomId, post.id, messageId);
    }
  }
  return null;
}

/**
 * Stores a delivered part. Retried, since the message is out and its id is the only way to find
 * it; if the database stays away the row is later held as unknown, never re-sent, and the log
 * keeps the id for the editor.
 */
async function recordSent(
  deps: PublishDeps,
  newsroomId: string,
  postId: string,
  messageId: string,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await withNewsroom(deps.pool, newsroomId, (c) =>
        c.query(
          `update posts set status = 'sent', external_id = $2, sent_at = now(), error = null,
             updated_at = now()
           where id = $1`,
          [postId, messageId],
        ),
      );
      return;
    } catch (error) {
      if (attempt >= 3) {
        console.error(
          `[publisher] post ${postId} went out as message ${messageId} but was not recorded`,
        );
        throw error;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Puts the publication on the site: status, path, search text; samples it for review. */
async function finish(deps: PublishDeps, client: Client, plan: Plan, now: Date) {
  const { publication: p, site } = plan;
  const { rows } = await client.query<{ status: string }>(
    "select status from publications where id = $1 for update",
    [p.id],
  );
  if (rows[0]?.status !== "scheduled") return "not-due" as const;
  // The same path the channel posts link to (templateContext).
  const path = await sitePath(client, {
    publicationId: p.id,
    language: p.language,
    seriesSlug: p.series_slug,
    slot: p.slot,
    timezone: p.timezone,
  });
  const url = pageUrl(site, p.language, path);
  const { rows: siteChannels } = await client.query<{ id: string }>(
    "select id from channels where kind = 'site' and language = $1 and status = 'active'",
    [p.language],
  );
  for (const channel of siteChannels) {
    await client.query(
      `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body,
                          status, external_id, sent_at)
       values (anr.current_newsroom_id(), $1, $2, 1, $3, '', 'sent', $4, $5)
       on conflict (publication_id, channel_id, part) do nothing`,
      [p.id, channel.id, `${p.id}:${channel.id}:1`, url, now],
    );
  }
  const title = (plan.rendition as { title?: unknown }).title;
  await auditedUpdate(client, PUBLISHER, "publish", "publications", p.id, {
    status: "published",
    published_at: now,
    updated_at: now,
    path,
    title: typeof title === "string" ? title : null,
    search_text: searchText(plan.rendition),
    edited: await editedByPerson(client, p.id, plan.renditionIds),
  });
  // Auto-published means no person approved it; those are sampled for review afterwards.
  const { rows: approved } = await client.query(
    `select 1 from audit_log where entity = 'publications' and entity_id = $1
       and actor_kind = 'person' and action = 'approve' limit 1`,
    [p.id],
  );
  if (approved.length === 0 && (deps.random ?? Math.random)() < SAMPLE_RATE) {
    await client.query(
      `insert into sample_reviews (newsroom_id, publication_id, sampled_at)
       values (anr.current_newsroom_id(), $1, $2) on conflict do nothing`,
      [p.id, now],
    );
  }
  return "published" as const;
}

export async function publishOne(
  deps: PublishDeps,
  newsroomId: string,
  publicationId: string,
): Promise<PublishOutcome> {
  const now = () => (deps.now ?? (() => new Date()))();
  return locked(deps.pool, publicationId, async () => {
    const prepared = await withNewsroom(deps.pool, newsroomId, (c) =>
      prepare(deps, c, publicationId, now()),
    );
    if (prepared.kind === "done") return prepared.outcome;
    const stopped = await send(deps, newsroomId, publicationId, prepared.plan, now());
    if (stopped) return stopped;
    return withNewsroom(deps.pool, newsroomId, (c) => finish(deps, c, prepared.plan, now()));
  });
}
