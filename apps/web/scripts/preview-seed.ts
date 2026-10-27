// Development only: a `m4preview` newsroom in anr_test with two published daily issues (fa, en),
// one held issue with its reasons, a review sample and a notice, and dev@anr.test as its
// Editor-in-Chief, for looking at the reader site and the desk. Re-running replaces its rows.
import { createPool } from "@anr/db";
import { loadRootEnv, testDatabaseUrl } from "@anr/db/testing";

loadRootEnv();
const system = createPool(testDatabaseUrl(process.env.DATABASE_SYSTEM_URL ?? ""));
const q = async <T = { id: string }>(sql: string, params: unknown[] = []) =>
  (await system.query(sql, params)).rows as T[];
const id = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]?.id ?? "";

const SLUG = "m4preview";
const old = await id("select id from newsrooms where slug = $1", [SLUG]);
if (old) {
  // Data rows only, children first; config rows (newsroom, series, beats) are reused below.
  for (const t of [
    "page_views",
    "posts",
    "checks",
    "sample_reviews",
    "notices",
    "memberships",
    "channels",
    "publication_renditions",
    "publications",
    "renditions",
    "claim_sources",
    "claims",
    "stories",
    "assignment_leads",
    "assignments",
  ])
    await system.query(`delete from ${t} where newsroom_id = $1`, [old]);
}
const newsroomId = await id(
  `insert into newsrooms (slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner, planning, policy)
   values ($1, $1, '{"fa": "پیش‌نمایش اتاق خبر", "en": "Preview Newsroom"}', '{fa,en}', 'Europe/Istanbul',
           'Mehrad Rousta', 'Mehrad Rousta', '{}', '{}')
   on conflict (slug) do update set removed_at = null returning id`,
  [SLUG],
);
const seriesId = await id(
  `insert into series (newsroom_id, slug, format_id, languages, config)
   select $1, 'daily-newsletter', f.id, '{fa,en}', '{"name": {"fa": "خبرنامه‌ی روزانه", "en": "Daily Newsletter"}}'
   from formats f where f.slug = 'newsletter-issue'
   on conflict (newsroom_id, slug) do update set removed_at = null returning id`,
  [newsroomId],
);
const beatId = await id(
  `insert into beats (newsroom_id, slug, status, media_topics) values ($1, 'labs', 'open', '{medtop:20000763}')
   on conflict (newsroom_id, slug) do update set removed_at = null returning id`,
  [newsroomId],
);
const items = {
  en: [
    [
      "Example Lab releases Orbit",
      "Example Lab released Orbit on Monday, saying it is 40 percent faster than Comet.",
    ],
    ["Nova Labs opens in Berlin", "Nova Labs opened a research office in Berlin."],
  ],
  fa: [
    [
      "Example Lab مدل Orbit را منتشر کرد",
      "آزمایشگاه Example Lab روز دوشنبه مدل Orbit را منتشر کرد و گفت ۴۰ درصد از Comet سریع‌تر است.",
    ],
    ["دفتر Nova Labs در Berlin", "شرکت Nova Labs دفتری پژوهشی در Berlin گشود."],
  ],
} as const;
const slot = new Date("2026-10-27T18:00:00Z");
const assignmentId = await id(
  "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
  [newsroomId, seriesId, slot],
);
const storyId = await id(
  "insert into stories (newsroom_id, assignment_id, beat_id) values ($1, $2, $3) returning id",
  [newsroomId, assignmentId, beatId],
);
for (const language of ["fa", "en"] as const) {
  const title = language === "fa" ? "خبرنامه‌ی روزانه‌ی هوش مصنوعی" : "Today in AI";
  const body = {
    language,
    title,
    items: items[language].map(([headline, text], i) => ({
      kind: "news",
      headline,
      body: text,
      claim_ids: [`c${i + 1}`],
    })),
  };
  const renditionId = await id(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, $3, $4 from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId, storyId, language, JSON.stringify(body)],
  );
  const search = [title, ...items[language].flat()].join("\n");
  const publicationId = await id(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status, published_at,
                               path, title, search_text)
     values ($1, $2, $3, $4, $5, 'published', $4, '/daily-newsletter/2026-10-27', $6, $7) returning id`,
    [newsroomId, seriesId, assignmentId, slot, language, title, search],
  );
  await system.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)`,
    [newsroomId, publicationId, renditionId],
  );
}
// A held issue with its reasons: the site must never show it; the desk's queue does.
const heldSlot = new Date("2026-10-28T18:00:00Z");
const heldAssignment = await id(
  "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
  [newsroomId, seriesId, heldSlot],
);
const heldStory = await id(
  "insert into stories (newsroom_id, assignment_id, beat_id) values ($1, $2, $3) returning id",
  [newsroomId, heldAssignment, beatId],
);
const claim = await id(
  `insert into claims (newsroom_id, story_id, ref, kind, text) values ($1, $2, 'c1', 'opinion', 'Orbit is the best model of the year.') returning id`,
  [newsroomId, heldStory],
);
const heldRendition = await id(
  `insert into renditions (newsroom_id, story_id, format_id, language, body)
   select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'newsletter-issue' returning id`,
  [
    newsroomId,
    heldStory,
    JSON.stringify({
      language: "en",
      title: "HELD DRAFT",
      items: [
        {
          kind: "news",
          headline: "Orbit",
          body: "Orbit is the best model of the year.",
          claim_ids: ["c1"],
        },
      ],
    }),
  ],
);
const held = await id(
  `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status, path, title, search_text)
   values ($1, $2, $3, $4, 'en', 'with-editor', '/daily-newsletter/2026-10-28', 'HELD DRAFT', 'Orbit held draft') returning id`,
  [newsroomId, seriesId, heldAssignment, heldSlot],
);
await system.query(
  "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
  [newsroomId, held, heldRendition],
);
await system.query(
  `insert into checks (newsroom_id, claim_id, kind, name, result, detail)
   values ($1, $2, 'policy', 'opinion', 'fail', '{"why": "opinion is not allowed in daily news"}')`,
  [newsroomId, claim],
);
const published = await id(
  "select id from publications where newsroom_id = $1 and language = 'en' and status = 'published'",
  [newsroomId],
);
await system.query("insert into sample_reviews (newsroom_id, publication_id) values ($1, $2)", [
  newsroomId,
  published,
]);
await system.query(
  `insert into notices (newsroom_id, kind, key, detail) values ($1, 'no-channel', 'telegram:fa', '{"kind": "telegram", "language": "fa"}')`,
  [newsroomId],
);
const userId = await id(
  "insert into users (email) values ('dev@anr.test') on conflict (lower(email)) do update set email = users.email returning id",
);
await system.query(
  "insert into memberships (newsroom_id, user_id, role) values ($1, $2, 'editor-in-chief')",
  [newsroomId, userId],
);
console.log(
  `seeded ${SLUG} in anr_test: http://${SLUG}.localhost:4410/ and the desk at http://desk.localhost:4410/`,
);
await system.end();
