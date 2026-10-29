// A reader's challenge (D114): the form on every piece posts here, and the site passes it to the
// API, which stores it with its deadline jobs. The reader's status page reads it back with the
// token from their link; the token is stored only as its hash.
import { createHash } from "node:crypto";
import { type Pool, withNewsroom } from "@anr/db";

export interface ChallengeForm {
  text: string;
  source_url?: string;
}

/** The form's fields; null for a bot (the hidden `website` field is filled in). */
export function challengeForm(form: FormData): ChallengeForm | null {
  if (String(form.get("website") ?? "") !== "") return null;
  const text = String(form.get("text") ?? "").trim();
  const source = String(form.get("source_url") ?? "").trim();
  return { text, ...(source && { source_url: source }) };
}

export type ChallengeSent =
  | { ok: true; id: string; token: string }
  | { ok: false; status: number; error: string };

/** Sends the challenge to the API with the reader's address and agent, for its rate limit only. */
export async function sendChallenge(
  apiBase: string,
  newsroom: string,
  publicationId: string,
  body: ChallengeForm,
  reader: { address: string; userAgent: string },
  fetchFn: typeof fetch = fetch,
): Promise<ChallengeSent> {
  const url = `${apiBase}/reader/newsrooms/${encodeURIComponent(newsroom)}/publications/${encodeURIComponent(publicationId)}/challenges`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": reader.address,
      "user-agent": reader.userAgent,
    },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { ok: false, status: 503, error: "unreachable" };
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    token?: string;
    error?: string;
  };
  if (res.status !== 201 || !json.id || !json.token)
    return { ok: false, status: res.status, error: json.error ?? `HTTP ${res.status}` };
  return { ok: true, id: json.id, token: json.token };
}

export interface ChallengeStatus {
  readerText: string;
  createdAt: Date;
  acknowledgeBy: Date;
  answerBy: Date;
  acknowledgedAt: Date | null;
  acknowledgement: string | null;
  answeredAt: Date | null;
  answer: string | null;
  outcome: "upheld" | "rejected" | null;
  publication: { title: string | null; path: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The challenge, if `token` is its own; nothing tells a wrong token from a missing challenge. */
export function challengeStatus(
  pool: Pool,
  newsroomId: string,
  id: string,
  token: string,
): Promise<ChallengeStatus | null> {
  if (!UUID.test(id) || !token) return Promise.resolve(null);
  const hash = createHash("sha256").update(token).digest();
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query(
      `select k.reader_text, k.created_at, k.acknowledge_by, k.answer_by, k.acknowledged_at,
              k.acknowledgement, k.answered_at, k.answer, k.outcome, p.title, p.path
       from challenges k join publications p on p.id = k.publication_id
       where k.id = $1 and k.token_hash = $2`,
      [id, hash],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      readerText: r.reader_text,
      createdAt: r.created_at,
      acknowledgeBy: r.acknowledge_by,
      answerBy: r.answer_by,
      acknowledgedAt: r.acknowledged_at,
      acknowledgement: r.acknowledgement,
      answeredAt: r.answered_at,
      answer: r.answer,
      outcome: r.outcome,
      publication: { title: r.title, path: r.path },
    };
  });
}
