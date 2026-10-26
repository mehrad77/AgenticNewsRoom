// Channel credentials (bot tokens and the like), sealed with the platform key before they reach
// Postgres. Envelope encryption: each credential gets its own random data key; the platform key
// only wraps data keys, so rotating it re-wraps 32-byte keys and never touches a credential.
// Everything happens here, in Node: the platform key is never sent to the database.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_BYTES = 4;
/** Wrapped data key: iv + encrypted key + tag. */
const WRAPPED_BYTES = IV_BYTES + KEY_BYTES + TAG_BYTES;

/** Where a sealed credential belongs; bound in as associated data, so it opens nowhere else. */
export interface CredentialOwner {
  newsroomId: string;
  channelId: string;
}

export interface PlatformKey {
  key: Buffer;
  /** First bytes of the key's SHA-256, stored with each credential to name the key it needs. */
  id: Buffer;
}

/** Reads ANR_PLATFORM_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). */
export function platformKey(value = process.env.ANR_PLATFORM_KEY): PlatformKey {
  if (!value) throw new Error("ANR_PLATFORM_KEY is not set");
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) throw new Error("ANR_PLATFORM_KEY must be 32 bytes, base64");
  return { key, id: createHash("sha256").update(key).digest().subarray(0, KEY_ID_BYTES) };
}

const aad = (owner: CredentialOwner, part: string) =>
  Buffer.from(`anr:${part}:v${VERSION}:${owner.newsroomId}:${owner.channelId}`);

function encrypt(key: Buffer, plaintext: Buffer, associated: Buffer): Buffer {
  // A fresh random IV for every encryption: reusing one with the same key breaks GCM.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associated);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function decrypt(key: Buffer, sealed: Buffer, associated: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(associated);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * Seals a credential object for `channels.credentials`.
 * Layout: version (1) | key id (4) | wrapped data key (60) | iv + ciphertext + tag.
 */
export function sealCredentials(
  credentials: Record<string, string>,
  owner: CredentialOwner,
  platform: PlatformKey,
): Buffer {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const wrapped = encrypt(platform.key, dataKey, aad(owner, "key"));
    const body = encrypt(dataKey, Buffer.from(JSON.stringify(credentials)), aad(owner, "data"));
    return Buffer.concat([Buffer.from([VERSION]), platform.id, wrapped, body]);
  } finally {
    dataKey.fill(0);
  }
}

/** Opens a sealed credential; throws if it was changed or belongs to another channel. */
export function openCredentials(
  sealed: Buffer,
  owner: CredentialOwner,
  platform: PlatformKey,
): Record<string, string> {
  if (sealed[0] !== VERSION) throw new Error(`unknown credential format ${sealed[0]}`);
  const keyId = sealed.subarray(1, 1 + KEY_ID_BYTES);
  if (!keyId.equals(platform.id))
    throw new Error("credential was sealed with another platform key");
  const start = 1 + KEY_ID_BYTES;
  const dataKey = decrypt(
    platform.key,
    sealed.subarray(start, start + WRAPPED_BYTES),
    aad(owner, "key"),
  );
  try {
    const body = decrypt(dataKey, sealed.subarray(start + WRAPPED_BYTES), aad(owner, "data"));
    return JSON.parse(body.toString("utf8")) as Record<string, string>;
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wraps a credential's data key under a new platform key; the credential itself is untouched. */
export function rewrapCredentials(
  sealed: Buffer,
  owner: CredentialOwner,
  from: PlatformKey,
  to: PlatformKey,
): Buffer {
  const start = 1 + KEY_ID_BYTES;
  if (!sealed.subarray(1, start).equals(from.id)) throw new Error("credential is not under `from`");
  const dataKey = decrypt(
    from.key,
    sealed.subarray(start, start + WRAPPED_BYTES),
    aad(owner, "key"),
  );
  try {
    const wrapped = encrypt(to.key, dataKey, aad(owner, "key"));
    return Buffer.concat([
      Buffer.from([VERSION]),
      to.id,
      wrapped,
      sealed.subarray(start + WRAPPED_BYTES),
    ]);
  } finally {
    dataKey.fill(0);
  }
}
