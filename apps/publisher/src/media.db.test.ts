// Images on anr_test (D16, D119, D120): an unlicensed image holds the piece; a licensed one is
// published once as a copy with its Photo Metadata and licence in XMP, signed with c2patool
// (both tools real where installed), and the site page shows its credit.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { createRenderer } from "@anr/render";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exiftoolWriter, rawReader, unchangedForTests } from "./media.ts";
import { localStore } from "./podcast/store.ts";
import { publishOne } from "./publish.ts";

const pools = testPools();
afterAll(() => pools.end());
const SLOT = new Date("2026-11-06T09:00:00Z");

const tools = (() => {
  try {
    execFileSync("exiftool", ["-ver"]);
    execFileSync("c2patool", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const image = readFileSync(
  fileURLToPath(
    new URL("../../../services/ingestion/tests/fixtures/media-press.jpg", import.meta.url),
  ),
);
const digest = createHash("sha256").update(image).digest("hex");
const key = `raw/${digest.slice(0, 2)}/${digest}`;
const rawDir = mkdtempSync(join(tmpdir(), "anr-raw-"));
const mediaDir = mkdtempSync(join(tmpdir(), "anr-media-"));
const store = localStore(mediaDir);

let newsroomId = "";
let userId = "";
let mediaId = "";

beforeAll(async () => {
  mkdirSync(dirname(join(rawDir, key)), { recursive: true });
  writeFileSync(join(rawDir, key), image);
  newsroomId = await createTestNewsroom(pools.system, "media");
  userId = (
    await pools.system.query<{ id: string }>("insert into users (email) values ($1) returning id", [
      `media-${randomBytes(4).toString("hex")}@example.test`,
    ])
  ).rows[0]?.id as string;
  mediaId = (
    await pools.system.query<{ id: string }>(
      `insert into media (newsroom_id, file, source_url, file_url, content_type, description,
                          creator, credit_line, added_by)
       values ($1, $2, 'https://label.example/press', 'https://label.example/a.jpg', 'image/jpeg',
               'Ada on stage', 'Ada Photo', 'Ada Photo / Label X', $3) returning id`,
      [newsroomId, key, userId],
    )
  ).rows[0]?.id as string;
});

/** A scheduled artist story in English whose one item shows the image. */
async function scheduled(day: number) {
  const sys = pools.system;
  const one = async (sql: string, params: unknown[]) =>
    ((await sys.query(sql, params)).rows[0] as { id: string }).id;
  const slot = new Date(SLOT.getTime() + day * 86_400_000);
  const series = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, $2, f.id, '{en}', '{"cadence": {"weekly": "fri 09:00"}, "channels": {"site": ["en"]}}'
     from formats f where f.slug = 'artist-story' returning id`,
    [newsroomId, `artist-story-${day}`],
  );
  const assignment = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, series, slot],
  );
  const story = await one(
    "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
    [newsroomId, assignment],
  );
  const body = {
    language: "en",
    title: "An artist",
    items: [{ paragraphs: ["One."], media_id: mediaId, claim_ids: ["c1"] }],
  };
  const rendition = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'artist-story' returning id`,
    [newsroomId, story, JSON.stringify(body)],
  );
  const id = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
     values ($1, $2, $3, $4, 'en', 'scheduled') returning id`,
    [newsroomId, series, assignment, slot],
  );
  await sys.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id)
     values ($1, $2, 1, $3)`,
    [newsroomId, id, rendition],
  );
  return { id, now: new Date(slot.getTime() + 30_000) };
}

/** Every work directory the publisher was handed, to check none is left behind. */
const workDirs: string[] = [];

const deps = (now: Date) => ({
  pool: pools.app,
  renderer: createRenderer(),
  adapters: {},
  platform: platformKey(randomBytes(32).toString("base64")),
  rootDomain: "example.test",
  now: () => now,
  random: () => 0.5,
  media: {
    writer: tools ? exiftoolWriter() : unchangedForTests,
    raw: rawReader(localStore(rawDir)),
    store,
    workDir: () => {
      const dir = mkdtempSync(join(tmpdir(), "anr-work-"));
      workDirs.push(dir);
      return dir;
    },
  },
});

describe("images (D119, D120)", () => {
  it("holds a piece whose image has no recorded licence", async () => {
    const { id, now } = await scheduled(0);
    expect(await publishOne(deps(now), newsroomId, id)).toBe("held");
    const { rows } = await pools.system.query(
      "select name, detail from checks where publication_id = $1",
      [id],
    );
    expect(rows).toEqual([{ name: "unlicensed-media", detail: { media: [mediaId] } }]);
  });

  it("publishes a licensed image with its metadata in XMP, signed", async () => {
    await pools.system.query(
      `update media set licence = 'Press use with credit', licence_kind = 'press-kit',
              licence_url = 'https://label.example/press', licence_recorded_by = $2,
              licence_recorded_at = now() where id = $1`,
      [mediaId, userId],
    );
    const { id, now } = await scheduled(7);
    expect(await publishOne(deps(now), newsroomId, id)).toBe("published");
    const { rows } = await pools.system.query<{ published_file: string }>(
      "select published_file from media where id = $1",
      [mediaId],
    );
    expect(rows[0]?.published_file).toBe(`m/${mediaId}.jpg`);
    expect(workDirs.length).toBeGreaterThan(0);
    expect(workDirs.filter((d) => existsSync(d))).toEqual([]);
    const file = store.path(`m/${mediaId}.jpg`);
    if (!tools) return;
    const tags = JSON.parse(
      execFileSync("exiftool", [
        "-j",
        "-XMP-photoshop:Credit",
        "-XMP-xmpRights:UsageTerms",
        file,
      ]).toString(),
    )[0];
    expect(tags.Credit).toBe("Ada Photo / Label X");
    expect(tags.UsageTerms).toBe("Press use with credit (https://label.example/press)");
    const report = JSON.parse(execFileSync("c2patool", [file]).toString());
    expect(report.validation_state).toBe("Valid");
    expect(JSON.stringify(report)).toContain("c2pa.published");
  });
});
