// Reference images on anr_test (D119, D162): a listed entry's licensed image gets its published
// copy once; an image no listed entry shows, or one without a licence, gets none.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawReader, unchangedForTests } from "./media.ts";
import { localStore } from "./podcast/store.ts";
import { publishReferenceImages } from "./reference.ts";

const pools = testPools();
afterAll(() => pools.end());

const image = readFileSync(
  fileURLToPath(
    new URL("../../../services/ingestion/tests/fixtures/media-press.jpg", import.meta.url),
  ),
);
/** A distinct copy of the fixture for each media row (a row is one file), stored as ingestion does. */
const stored = (n: number) => {
  const data = Buffer.concat([image, Buffer.from([n])]);
  const digest = createHash("sha256").update(data).digest("hex");
  const key = `raw/${digest.slice(0, 2)}/${digest}`;
  mkdirSync(dirname(join(rawDir, key)), { recursive: true });
  writeFileSync(join(rawDir, key), data);
  return key;
};
const rawDir = mkdtempSync(join(tmpdir(), "anr-raw-"));
const mediaDir = mkdtempSync(join(tmpdir(), "anr-media-"));
const deps = {
  writer: unchangedForTests,
  raw: rawReader({
    get: async (k: string) => readFileSync(join(rawDir, k)),
  } as unknown as Parameters<typeof rawReader>[0]),
  store: localStore(mediaDir),
  workDir: () => mkdtempSync(join(tmpdir(), "anr-work-")),
};

let newsroomId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  const sys = pools.system;
  newsroomId = await createTestNewsroom(sys, "refimg");
  await sys.query(
    `update newsrooms set reference = '{"kinds": {"artist": {"path": "artists", "layout": "profile",
       "name": {"en": "Artists"}, "one": {"en": "Artist"}}}}' where id = $1`,
    [newsroomId],
  );
  const user = (
    await sys.query<{ id: string }>("insert into users (email) values ($1) returning id", [
      `refimg-${randomBytes(4).toString("hex")}@example.test`,
    ])
  ).rows[0]?.id;
  const media = async (name: string, licensed: boolean, n: number) => {
    const { rows } = await sys.query<{ id: string }>(
      `insert into media (newsroom_id, file, source_url, file_url, content_type, description,
                          creator, credit_line, added_by, licence, licence_kind, licence_url,
                          licence_recorded_at)
       values ($1, $2, 'https://commons.example/f', 'https://commons.example/f', 'image/jpeg', $3,
               'Ada', 'Ada, via Wikimedia Commons', $4, $5, $6, $7, $8) returning id`,
      [
        newsroomId,
        stored(n),
        name,
        user,
        licensed ? "CC BY 4.0" : null,
        licensed ? "commons" : null,
        licensed ? "https://creativecommons.org/licenses/by/4.0/" : null,
        licensed ? new Date() : null,
      ],
    );
    return rows[0]?.id as string;
  };
  ids.shown = await media("shown", true, 1);
  ids.unshown = await media("unshown", true, 2);
  ids.unlicensed = await media("unlicensed", false, 3);
  const entry = async (slug: string, mediaId: string) =>
    sys.query(
      `insert into reference_entries (newsroom_id, kind, slug, title, facts, origin)
       values ($1, 'artist', $2, $2, $3, 'imported')`,
      [newsroomId, slug, { image: { media_id: mediaId } }],
    );
  await entry("ada", ids.shown as string);
  await entry("bea", ids.unlicensed as string);
});

describe("publishReferenceImages", () => {
  it("publishes a listed entry's licensed image once, and nothing else", async () => {
    const first = await publishReferenceImages(pools.app, deps);
    expect(first.published).toBeGreaterThanOrEqual(1);
    const { rows } = await pools.system.query<{ id: string; published_file: string | null }>(
      "select id, published_file from media where newsroom_id = $1",
      [newsroomId],
    );
    const published = Object.fromEntries(rows.map((r) => [r.id, r.published_file]));
    expect(published[ids.shown as string]).toMatch(/^m\/.+\.jpg$/);
    expect(published[ids.unshown as string]).toBeNull();
    expect(published[ids.unlicensed as string]).toBeNull();
    const again = await publishReferenceImages(pools.app, deps);
    expect(again.published).toBe(0);
  });
});
