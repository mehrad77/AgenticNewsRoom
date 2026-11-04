// Personal tokens (D191): a person gives one to an agent of their own, which then acts as them
// through the API and the MCP server (D189). Only the token's SHA-256 hash is stored; the token is
// shown once, when it is issued. Issuing and revoking happen only in a desk session signed in
// through Access (the routes check that), so a token can never mint another.
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "@anr/db";
import { DeskError } from "./errors.ts";

export const TOKEN_PREFIX = "anr_";
export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 365;
/** How often a token's last use is written, at most. */
const LAST_USED_EVERY_SECONDS = 60;

const TOKEN = /^anr_[A-Za-z0-9_-]{43}$/;

export interface TokenRow {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest();

/** The token in an `Authorization: Bearer` header, or null when there is none. */
export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** The user and token a valid, unexpired and unrevoked token stands for; null for anything else. */
export async function tokenUser(
  pool: Pool,
  token: string,
): Promise<{ userId: string; email: string; tokenId: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows } = await pool.query<{ id: string; user_id: string; email: string; stale: boolean }>(
    `select t.id, t.user_id, u.email,
            t.last_used_at is null or t.last_used_at < now() - make_interval(secs => $2) as stale
     from personal_tokens t join users u on u.id = t.user_id
     where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now()`,
    [hash(token), LAST_USED_EVERY_SECONDS],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.stale)
    await pool.query("update personal_tokens set last_used_at = now() where id = $1", [row.id]);
  return { userId: row.user_id, email: row.email, tokenId: row.id };
}

const COLUMNS = "id, name, created_at, expires_at, last_used_at, revoked_at";

export async function listTokens(pool: Pool, userId: string): Promise<TokenRow[]> {
  const { rows } = await pool.query<TokenRow>(
    `select ${COLUMNS} from personal_tokens where user_id = $1 order by created_at desc`,
    [userId],
  );
  return rows;
}

/** Every person's tokens, for the platform admin. */
export async function allTokens(pool: Pool): Promise<(TokenRow & { email: string })[]> {
  const { rows } = await pool.query<TokenRow & { email: string }>(
    `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, u.email
     from personal_tokens t join users u on u.id = t.user_id
     order by t.created_at desc`,
  );
  return rows;
}

/** Issues a token; the returned `token` is the only time it is ever shown. */
export async function issueToken(
  pool: Pool,
  userId: string,
  input: Record<string, unknown>,
): Promise<TokenRow & { token: string }> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 80) throw new DeskError(400, "name: 1 to 80 characters");
  const days = input.days ?? DEFAULT_TOKEN_DAYS;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS)
    throw new DeskError(400, `days: a whole number from 1 to ${MAX_TOKEN_DAYS}`);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const { rows } = await pool.query<TokenRow>(
    `insert into personal_tokens (user_id, name, token_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4))
     returning ${COLUMNS}`,
    [userId, name, hash(token), days],
  );
  return { ...(rows[0] as TokenRow), token };
}

/** Revokes a token: the person's own, or, with `userId` null, anyone's (the platform admin). */
export async function revokeToken(
  pool: Pool,
  userId: string | null,
  id: string,
): Promise<TokenRow> {
  const { rows } = await pool.query<TokenRow>(
    `update personal_tokens set revoked_at = coalesce(revoked_at, now())
     where id = $1 and ($2::uuid is null or user_id = $2)
     returning ${COLUMNS}`,
    [id, userId],
  );
  const row = rows[0];
  if (!row) throw new DeskError(404, "no such token");
  return row;
}
