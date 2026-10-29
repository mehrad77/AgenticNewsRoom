// An image a member added, on anr_test (D119): a failure leaves a `media-failed` notice.
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { MediaRequestOutcome } from "../ingest.ts";
import { ingestMedia } from "./ingest.ts";

const pools = testPools();
afterAll(() => pools.end());

const answering = (outcome: MediaRequestOutcome) => ({ addMedia: async () => outcome });

describe("ingest-media", () => {
  it("brings a read notice back, unread, when the same image fails again", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "img");
    const job = {
      newsroomId,
      url: "https://label.example/press/x.jpg",
      sourceUrl: "https://label.example/press",
      addedBy: "00000000-0000-0000-0000-000000000000",
    };
    const notice = async () =>
      (
        await pools.system.query<{ detail: { reason: string }; read_at: Date | null }>(
          "select detail, read_at from notices where newsroom_id = $1 and kind = 'media-failed'",
          [newsroomId],
        )
      ).rows;

    expect(
      await ingestMedia(
        pools.app,
        answering({ kind: "failed", detail: "Commons answered 502" }),
        job,
      ),
    ).toEqual({ kind: "noticed" });
    await pools.system.query("update notices set read_at = now() where newsroom_id = $1", [
      newsroomId,
    ]);
    await ingestMedia(pools.app, answering({ kind: "refused", detail: "not an image" }), job);

    const rows = await notice();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.read_at).toBeNull();
    expect(rows[0]?.detail.reason).toBe("not an image");
  });
});
