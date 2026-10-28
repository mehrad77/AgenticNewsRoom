// One approved episode on anr_test (D109): fake voices, the real mix (ffmpeg), the AI newsroom's
// own cues, ID3 tags and chapters, C2PA signing with c2patool's test certificate when it is
// installed, the local store, the Episode row and the TTS spend.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { createRenderer } from "@anr/render";
import { afterAll, describe, expect, it } from "vitest";
import { loudness } from "./mix.ts";
import { produceEpisode } from "./produce.ts";
import { c2paSigner, unsignedForTests } from "./sign.ts";
import { localStore } from "./store.ts";
import { cachedTts, fakeTts, type TextToSpeech } from "./tts.ts";

const pools = testPools();
afterAll(() => pools.end());
const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
const hasC2pa = (() => {
  try {
    execFileSync("c2patool", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const script = {
  language: "en",
  title: "Weekly Podcast · 2026-11-06",
  items: [
    {
      segment: "news-recap",
      topics: [
        {
          title: "Orbit ships",
          claim_ids: ["c1"],
          lines: [
            {
              host: "maya",
              text: "Example Lab shipped Orbit this week, and it is forty percent faster.",
            },
            { host: "leo", text: "Faster than Comet, the lab says." },
          ],
        },
      ],
    },
    {
      segment: "story",
      title: "Attention",
      protagonists: [{ name: "Ashish Vaswani", role: "first author", claim_ids: ["c2"] }],
      beats: ["cold-open", "context", "turning-point", "stakes", "resolution", "takeaway"].map(
        (beat, i) => ({
          beat,
          claim_ids: ["c2"],
          lines: [
            {
              speaker: "narrator",
              text: `Beat ${i + 1}: Vaswani and his colleagues worked on translation.`,
              ...(i === 1 && { direction: "hushed" }),
            },
            ...(i === 0 ? [{ cue: "sting" }] : []),
            ...(i === 5 ? [{ cue: "pause", seconds: 1 }] : []),
            { speaker: "maya", text: "And that changed the field." },
          ],
        }),
      ),
    },
  ],
};

async function scheduledEpisode() {
  const newsroomId = await createTestNewsroom(pools.system, "audio");
  await pools.system.query(
    `update newsrooms set slug = 'ai-audio-' || substr(id::text, 1, 8), languages = '{fa,en}',
            timezone = 'Europe/Istanbul', name = '{"en": "AI Newsroom"}',
            policy = '{"budget": {"monthly_usd": 30, "check_reserve_usd": 3}}'
     where id = $1`,
    [newsroomId],
  );
  const one = async (sql: string, params: unknown[]) =>
    (await pools.system.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'weekly-podcast', f.id, '{fa,en}', $2 from formats f where f.slug = 'podcast-episode' returning id`,
    [
      newsroomId,
      JSON.stringify({
        name: { en: "Weekly Podcast" },
        hosts: { en: { maya: "Kore", leo: "Puck" } },
        narrator: { en: "Enceladus" },
      }),
    ],
  );
  const slot = "2026-11-06T15:00:00Z";
  const assignment = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, slot],
  );
  const story = await one(
    "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
    [newsroomId, assignment],
  );
  const rendition = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'podcast-episode' returning id`,
    [newsroomId, story, JSON.stringify(script)],
  );
  const publicationId = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
     values ($1, $2, $3, $4, 'en', 'scheduled') returning id`,
    [newsroomId, seriesId, assignment, slot],
  );
  await pools.system.query(
    "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
    [newsroomId, publicationId, rendition],
  );
  return { newsroomId, publicationId };
}

/** Points the audio directory of the test newsroom at the AI newsroom's committed cues. */
function configWithCues(newsroomSlug: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anr-audio-config-"));
  execFileSync("mkdir", ["-p", join(dir, "newsrooms", newsroomSlug, "audio")]);
  execFileSync("ln", [
    "-s",
    join(configDir, "newsrooms/ai/audio/weekly-podcast"),
    join(dir, "newsrooms", newsroomSlug, "audio", "weekly-podcast"),
  ]);
  return dir;
}

describe("episode audio (D109)", () => {
  it("voices, mixes to −16 LUFS, tags with chapters, signs and stores an approved episode", async () => {
    const { newsroomId, publicationId } = await scheduledEpisode();
    const slug =
      (
        await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
          newsroomId,
        ])
      ).rows[0]?.slug ?? "";
    const store = localStore(mkdtempSync(join(tmpdir(), "anr-media-")));
    const calls: string[] = [];
    const fake = fakeTts();
    const counted: TextToSpeech = {
      ...fake,
      synthesize: async (r) => {
        calls.push(r.direction ? `${r.voice}:${r.direction}` : r.voice);
        return fake.synthesize(r);
      },
    };
    const deps = {
      pool: pools.app,
      renderer: createRenderer(),
      tts: cachedTts(counted, store),
      store,
      signer: hasC2pa ? c2paSigner() : unsignedForTests,
      configDir: configWithCues(slug),
    };
    const job = { newsroomId, publicationId };
    expect(await produceEpisode(deps, job)).toBe("ready");
    // 17 lines: the intro's three, the recap's two, the story's twelve. Maya's line repeats in
    // every beat, so the cache voices it once: 12 calls.
    expect(calls).toHaveLength(12);
    expect(calls).toContain("Enceladus:hushed");

    const [episode] = (
      await pools.system.query<{
        media_key: string;
        bytes: string;
        seconds: string;
        chapters: { title: string; start: number }[];
        digital_source_type: string;
        signed: boolean;
      }>("select * from episodes where publication_id = $1", [publicationId])
    ).rows;
    expect(episode?.chapters.map((c) => c.title)).toEqual([
      script.title,
      "Orbit ships",
      "Attention",
    ]);
    expect(episode?.digital_source_type).toBe(
      "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    );
    expect(episode?.signed).toBe(hasC2pa);
    const file = store.path(episode?.media_key ?? "");
    expect(Number(episode?.bytes)).toBeGreaterThan(10_000);

    // −16 LUFS within half a unit, and the ID3 chapters and tags are in the file.
    expect(Math.abs((await loudness(file)) + 16)).toBeLessThan(0.5);
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_chapters",
        "-show_format",
        "-of",
        "json",
        file,
      ]).toString(),
    ) as { chapters: { tags: { title: string } }[]; format: { tags: Record<string, string> } };
    expect(probe.chapters.map((c) => c.tags.title)).toEqual([
      script.title,
      "Orbit ships",
      "Attention",
    ]);
    expect(probe.format.tags).toMatchObject({
      title: script.title,
      artist: "AI Newsroom",
      album: "Weekly Podcast",
    });
    expect(probe.format.tags.comment).toContain("AI-made");
    if (hasC2pa) {
      const report = execFileSync("c2patool", [file]).toString();
      expect(report).toContain('"validation_state": "Valid"');
      expect(report).toContain("trainedAlgorithmicMedia");
    }

    // The spend is an Agent run row; a second job finds the episode and voices nothing.
    const runs = (
      await pools.system.query<{ role: string; outcome: string; detail: { calls: number } }>(
        "select role, outcome, detail from agent_runs where newsroom_id = $1",
        [newsroomId],
      )
    ).rows;
    expect(runs).toEqual([{ role: "tts", outcome: "submitted", detail: { calls: 12 } }]);
    expect(await produceEpisode(deps, job)).toBe("exists");
    expect(calls).toHaveLength(12);
    writeFileSync(join(tmpdir(), "anr-last-episode.txt"), file);
  }, 120_000);

  it("holds the episode when a line cannot be voiced, keeping the spend", async () => {
    const { newsroomId, publicationId } = await scheduledEpisode();
    const failing: TextToSpeech = {
      provider: "fake",
      model: "fake-tts",
      synthesize: async () => {
        throw new Error("TTS answered 500");
      },
    };
    const store = localStore(mkdtempSync(join(tmpdir(), "anr-media-")));
    const outcome = await produceEpisode(
      {
        pool: pools.app,
        renderer: createRenderer(),
        tts: failing,
        store,
        signer: unsignedForTests,
        configDir,
      },
      { newsroomId, publicationId },
    );
    expect(outcome).toBe("held");
    const checks = (
      await pools.system.query<{ name: string; result: string }>(
        "select name, result from checks where publication_id = $1",
        [publicationId],
      )
    ).rows;
    expect(checks).toEqual([{ name: "audio", result: "error" }]);
    const status = (
      await pools.system.query<{ status: string }>(
        "select status from publications where id = $1",
        [publicationId],
      )
    ).rows[0]?.status;
    expect(status).toBe("with-editor");
  });
});
