// Media items at the desk (D16, D119). A member adds an image by URL; ingestion fetches it and
// reads its Photo Metadata. A free Wikimedia Commons licence is recorded by code; a press kit's
// press-use terms are recorded here by a person, with the credit. A recorded licence never changes.
import { type IngestMediaJob, QUEUES } from "@anr/core";
import { auditedUpdate, type Client, onClient } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { DeskError } from "./errors.ts";

type Actor = { kind: "person"; userId: string };

export interface MediaItem {
  id: string;
  source_url: string;
  file_url: string;
  lead_id: string | null;
  lead_headline: string | null;
  description: string | null;
  creator: string | null;
  credit_line: string | null;
  copyright_notice: string | null;
  web_statement: string | null;
  licensor: string | null;
  digital_source_type: string | null;
  licence: string | null;
  licence_kind: "press-kit" | "commons" | null;
  licence_url: string | null;
  licence_recorded_at: string | null;
  created_at: string;
}

const COLUMNS = `m.id, m.source_url, m.file_url, m.lead_id, l.headline as lead_headline, m.description,
  m.creator, m.credit_line, m.copyright_notice, m.web_statement, m.licensor, m.digital_source_type,
  m.licence, m.licence_kind, m.licence_url, m.licence_recorded_at, m.created_at`;

/** Unlicensed first (they need a person), then newest. */
export async function listMedia(client: Client): Promise<MediaItem[]> {
  const { rows } = await client.query<MediaItem>(
    `select ${COLUMNS} from media m left join leads l on l.id = m.lead_id
     order by m.licence is not null, m.created_at desc limit 200`,
  );
  return rows;
}

export const isHttpUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const COMMONS = /^https:\/\/commons\.wikimedia\.org\//;

/** Queues ingestion's fetch; the item appears once it is read, or a `media-failed` notice. */
export async function addMedia(
  client: Client,
  boss: Pick<PgBoss, "send">,
  actor: Actor,
  input: { url: string; sourceUrl?: string; leadId?: string },
  // An image reaches a piece only through its lead (read_lead), so it needs one.
): Promise<{ queued: true }> {
  if (!isHttpUrl(input.url)) throw new DeskError(400, "url: an http(s) address");
  if (!COMMONS.test(input.url) && !(input.sourceUrl && isHttpUrl(input.sourceUrl)))
    throw new DeskError(400, "source_url: the press kit's page");
  if (!input.leadId) throw new DeskError(400, "lead_id: the lead the image goes with");
  const { rowCount } = await client.query("select from leads where id = $1", [input.leadId]);
  if (!rowCount) throw new DeskError(404, "no such lead");
  const { rows } = await client.query<{ id: string }>("select anr.current_newsroom_id() as id");
  const job: IngestMediaJob = {
    newsroomId: rows[0]?.id as string,
    url: input.url,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    leadId: input.leadId,
    addedBy: actor.userId,
  };
  await boss.send(QUEUES.ingestMedia, job, { db: onClient(client) });
  return { queued: true };
}

export interface PressKit {
  /** The kit's words for the use it allows, such as "Press use with credit". */
  licence: string;
  /** The page that states those terms. */
  termsUrl: string;
  /** Needed when the image's own metadata carries none. */
  credit?: string;
}

/** A person records that an artist's or label's press kit allows press use (D16). */
export async function recordPressKit(
  client: Client,
  actor: Actor,
  id: string,
  kit: PressKit,
  now: Date = new Date(),
): Promise<MediaItem> {
  const { rows } = await client.query<{
    licence: string | null;
    source_url: string;
    credit_line: string | null;
  }>("select licence, source_url, credit_line from media where id = $1 for update", [id]);
  const row = rows[0];
  if (!row) throw new DeskError(404, "no such media item");
  if (row.licence)
    throw new DeskError(409, "its licence is recorded; add the image again for another");
  if (COMMONS.test(row.source_url))
    throw new DeskError(409, "a Commons image takes its licence from Commons");
  const credit = kit.credit?.trim() || row.credit_line;
  if (!credit) throw new DeskError(400, "credit: the image's metadata carries none");
  await auditedUpdate(client, actor, "record-licence", "media", id, {
    licence: kit.licence,
    licence_kind: "press-kit",
    licence_url: kit.termsUrl,
    licence_recorded_by: actor.userId,
    licence_recorded_at: now,
    credit_line: credit,
  });
  const { rows: item } = await client.query<MediaItem>(
    `select ${COLUMNS} from media m left join leads l on l.id = m.lead_id where m.id = $1`,
    [id],
  );
  return item[0] as MediaItem;
}
