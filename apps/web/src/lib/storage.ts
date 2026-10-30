// Episode audio and published images from the media bucket (D132): the site answers /a/ and /m/
// with a redirect to a presigned URL valid for an hour, so the bucket stays private and the bytes
// never pass through the server. Without a bucket (development) the files are served locally.
import { presignedUrl, r2Client } from "@anr/storage";

let client: ReturnType<typeof r2Client> | undefined;

/** The redirect for one object in the media bucket, or null where no bucket is set. */
export async function mediaRedirect(
  key: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Response | null> {
  const bucket = env.ANR_MEDIA_BUCKET;
  if (!bucket) return null;
  client ??= r2Client(env);
  return new Response(null, {
    status: 302,
    // The link expires: neither Cloudflare nor a browser may keep it.
    headers: {
      location: await presignedUrl(client, bucket, key),
      "cache-control": "private, no-store",
    },
  });
}
