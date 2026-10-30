// Object storage (D132): raw pages, episode audio, published images and the TTS cache. In R2's
// private buckets when one is set (production), else in a local directory (development). The
// site's /a/ and /m/ links redirect to presigned URLs, so no bucket is ever public.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
}

/** Keys are relative paths of lower-case letters, digits, dashes, dots and slashes. */
const KEY = /^[a-z0-9][a-z0-9./-]*$/;
function checkKey(key: string): string {
  if (!KEY.test(key) || key.includes("..")) throw new Error(`bad object key ${key}`);
  return key;
}

/** A directory standing in for a bucket, where none is set (development). */
export function localStore(dir: string): ObjectStore & { path(key: string): string } {
  const root = resolve(dir);
  const path = (key: string) => join(root, checkKey(key));
  return {
    path,
    async get(key) {
      const file = path(key);
      return existsSync(file) ? readFileSync(file) : null;
    },
    async put(key, data) {
      const file = path(key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    },
  };
}

type Env = Record<string, string | undefined>;

/**
 * A client for R2's S3 API with the apps' token (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; never the
 * backups bucket's, D149). ANR_S3_ENDPOINT points it at a local stand-in instead.
 */
export function r2Client(env: Env = process.env): S3Client {
  const endpoint = env.ANR_S3_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: "auto",
    endpoint,
    // Path-style URLs (endpoint/bucket/key) work on R2 and on any stand-in.
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    },
    // Checksums only where S3 requires one: R2 and stand-ins differ on the optional ones.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const notFound = (error: unknown) =>
  error instanceof NoSuchKey ||
  (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404);

/** A private bucket. */
export function s3Store(client: S3Client, bucket: string): ObjectStore {
  return {
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }));
        const bytes = await out.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async put(key, data, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: checkKey(key),
          Body: data,
          ContentType: contentType,
        }),
      );
    },
  };
}

/** How long a presigned link to audio or an image works (D132). */
export const PRESIGNED_SECONDS = 3600;

/** A link that reads one object without credentials until it expires. Computed locally. */
export function presignedUrl(client: S3Client, bucket: string, key: string): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }), {
    expiresIn: PRESIGNED_SECONDS,
  });
}

/** The bucket when one is named, else the local directory. */
export function objectStore(bucket: string | undefined, dir: string, env: Env = process.env) {
  return bucket ? s3Store(r2Client(env), bucket) : localStore(dir);
}
