import { describe, expect, it } from "vitest";
import { mediaRedirect } from "./storage.ts";

describe("mediaRedirect (D132)", () => {
  it("redirects to an hour-long presigned URL into the private bucket, never cached", async () => {
    const res = await mediaRedirect("a/0b1c.mp3", {
      ANR_MEDIA_BUCKET: "anr-media",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
    });
    expect(res?.status).toBe(302);
    expect(res?.headers.get("cache-control")).toBe("private, no-store");
    const url = new URL(res?.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://acct.r2.cloudflarestorage.com/anr-media/a/0b1c.mp3",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("is null where no bucket is set, so development serves its local files", async () => {
    expect(await mediaRedirect("a/0b1c.mp3", {})).toBeNull();
  });
});
