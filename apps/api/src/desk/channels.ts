// Channels are data, not config (invariant 7): the Editor-in-Chief adds them here. Credentials are
// sealed with the platform key before they reach Postgres and are never read back out.
import { CHANNEL_KINDS, type ChannelCheckJob, LANGUAGES, QUEUES } from "@anr/core";
import {
  auditedUpdate,
  type Client,
  onClient,
  type PlatformKey,
  recordAudit,
  sealCredentials,
} from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

interface Row {
  id: string;
  kind: string;
  language: string;
  external_id: string | null;
  status: string;
  has_credentials: boolean;
  checked_at: Date | string | null;
  check_result: unknown;
}

const COLUMNS = `id, kind, language, external_id, status, credentials is not null as has_credentials,
  checked_at, check_result`;

const out = (r: Row): Row => ({
  ...r,
  checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : r.checked_at,
});

export async function listChannels(client: Client): Promise<Row[]> {
  const { rows } = await client.query<Row>(
    `select ${COLUMNS} from channels order by kind, language, created_at`,
  );
  return rows.map(out);
}

export interface NewChannel {
  kind: string;
  language: string;
  external_id?: string;
  credentials?: Record<string, string>;
}

/** What each kind needs before the publisher can use it. */
function requirements(c: NewChannel): string | null {
  if (!(CHANNEL_KINDS as readonly string[]).includes(c.kind)) return "unknown channel kind";
  if (!(LANGUAGES as readonly string[]).includes(c.language)) return "unknown language";
  if (c.kind === "telegram") {
    if (!c.external_id?.trim()) return "a Telegram channel needs its chat id or @username";
    if (!c.credentials?.bot_token?.trim()) return "a Telegram channel needs its bot token";
  }
  return null;
}

export async function addChannel(
  client: Client,
  actor: Actor,
  platform: PlatformKey,
  input: NewChannel,
): Promise<Row> {
  const problem = requirements(input);
  if (problem) throw new DeskError(400, problem);
  const { rows } = await client.query<{ id: string; newsroom_id: string }>(
    `insert into channels (newsroom_id, kind, language, external_id)
     values (anr.current_newsroom_id(), $1, $2, $3) returning id, newsroom_id`,
    [input.kind, input.language, input.external_id?.trim() || null],
  );
  const row = rows[0];
  if (!row) throw new Error("channel not created");
  const secrets = Object.fromEntries(
    Object.entries(input.credentials ?? {}).map(([k, v]) => [k, v.trim()]),
  );
  if (Object.keys(secrets).length > 0) {
    // Bound to this newsroom and channel: a sealed blob opens nowhere else.
    const sealed = sealCredentials(
      secrets,
      { newsroomId: row.newsroom_id, channelId: row.id },
      platform,
    );
    await client.query("update channels set credentials = $2 where id = $1", [row.id, sealed]);
  }
  // The audit log cannot be purged, so it records that credentials exist, never what they are.
  await recordAudit(client, {
    actor,
    action: "add-channel",
    entity: "channels",
    entityId: row.id,
    after: {
      kind: input.kind,
      language: input.language,
      external_id: input.external_id ?? null,
      credentials: Object.keys(secrets).length > 0 ? "[redacted]" : null,
    },
  });
  return channel(client, row.id);
}

export async function setChannelStatus(
  client: Client,
  actor: Actor,
  id: string,
  status: string,
): Promise<Row> {
  if (status !== "active" && status !== "disabled") throw new DeskError(400, "unknown status");
  const { rows } = await client.query("select 1 from channels where id = $1", [id]);
  if (rows.length === 0) throw new DeskError(404, "no such channel");
  // auditedUpdate redacts the credentials column in the before and after it records.
  await auditedUpdate(
    client,
    actor,
    status === "active" ? "enable-channel" : "disable-channel",
    "channels",
    id,
    {
      status,
      updated_at: new Date(),
    },
  );
  return channel(client, id);
}

async function channel(client: Client, id: string): Promise<Row> {
  const { rows } = await client.query<Row>(`select ${COLUMNS} from channels where id = $1`, [id]);
  if (!rows[0]) throw new DeskError(404, "no such channel");
  return out(rows[0]);
}

/** Asks the publisher to check the channel (D101); only it talks to channels. */
export async function requestCheck(client: Client, boss: Pick<PgBoss, "send">, id: string) {
  const { rows } = await client.query<{ newsroom_id: string }>(
    "select newsroom_id from channels where id = $1",
    [id],
  );
  if (!rows[0]) throw new DeskError(404, "no such channel");
  const job: ChannelCheckJob = { newsroomId: rows[0].newsroom_id, channelId: id };
  await boss.send(QUEUES.channelCheck, job, { db: onClient(client) });
  return { id, status: "check-queued" };
}

/**
 * Replaces every credential of a channel, such as a revoked bot token, sealed to the same
 * newsroom and channel, then asks the publisher to check it (D101). The old ones are gone.
 */
export async function replaceCredentials(
  client: Client,
  actor: Actor,
  platform: PlatformKey,
  boss: Pick<PgBoss, "send">,
  id: string,
  credentials: Record<string, string>,
): Promise<Row> {
  const current = await channel(client, id);
  const secrets = Object.fromEntries(
    Object.entries(credentials)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v),
  );
  if (current.kind === "telegram" && !secrets.bot_token)
    throw new DeskError(400, "a Telegram channel needs its bot token");
  if (Object.keys(secrets).length === 0) throw new DeskError(400, "no credentials given");
  const { rows } = await client.query<{ newsroom_id: string }>(
    "select newsroom_id from channels where id = $1",
    [id],
  );
  const sealed = sealCredentials(
    secrets,
    { newsroomId: rows[0]?.newsroom_id ?? "", channelId: id },
    platform,
  );
  // auditedUpdate redacts the credentials column: the log says they changed, never to what.
  await auditedUpdate(client, actor, "replace-credentials", "channels", id, {
    credentials: sealed,
    checked_at: null,
    check_result: null,
    updated_at: new Date(),
  });
  await requestCheck(client, boss, id);
  return channel(client, id);
}
