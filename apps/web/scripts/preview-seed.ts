// Development only: a `m4preview` newsroom in anr_test with two published daily issues (fa, en),
// one held issue with its reasons, one scheduled for tomorrow, review samples, a notice, a
// Telegram channel (no token: nothing can be sent), sources, agent runs and audience counts, and
// dev@anr.test as its Editor-in-Chief, for looking at the reader site and the desk. Re-running
// replaces its rows.
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
    "picks",
    "editorial_cycles",
    "channel_stats",
    "page_views",
    "agent_runs",
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
    "lead_sightings",
    "lead_beats",
    "leads",
    "source_fetch_state",
  ])
    await system.query(`delete from ${t} where newsroom_id = $1`, [old]);
}
const newsroomId = await id(
  `insert into newsrooms (slug, subdomain, name, languages, timezone, editor_in_chief, corrections_owner, planning, policy)
   values ($1, $1, '{"fa": "پیش‌نمایش اتاق خبر", "en": "Preview Newsroom"}', '{fa,en}', 'Europe/Istanbul',
           'Mehrad Rousta', 'Mehrad Rousta', '{}', '{"budget": {"monthly_usd": 30, "check_reserve_usd": 5}}')
   on conflict (slug) do update set removed_at = null, policy = excluded.policy returning id`,
  [SLUG],
);
const seriesId = await id(
  `insert into series (newsroom_id, slug, format_id, languages, config)
   select $1, 'daily-newsletter', f.id, '{fa,en}', $2
   from formats f where f.slug = 'newsletter-issue'
   on conflict (newsroom_id, slug) do update set removed_at = null, config = excluded.config
   returning id`,
  [
    newsroomId,
    JSON.stringify({
      name: { fa: "خبرنامه‌ی روزانه", en: "Daily Newsletter" },
      channels: { site: ["fa", "en"], telegram: ["fa", "en"] },
    }),
  ],
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
const publishedFa = await id(
  "select id from publications where newsroom_id = $1 and language = 'fa' and status = 'published'",
  [newsroomId],
);
await system.query(
  `insert into sample_reviews (newsroom_id, publication_id, outcome, note, reviewed_at)
   values ($1, $2, 'miss', 'The speed claim compared different benchmarks; check that a comparison names one benchmark.', now())`,
  [newsroomId, publishedFa],
);
// Scheduled for tomorrow: the upcoming view can pull it back.
const nextSlot = new Date(Date.now() + 24 * 3600_000);
const nextAssignment = await id(
  "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
  [newsroomId, seriesId, nextSlot],
);
const nextStory = await id(
  "insert into stories (newsroom_id, assignment_id, beat_id) values ($1, $2, $3) returning id",
  [newsroomId, nextAssignment, beatId],
);
const nextRendition = await id(
  `insert into renditions (newsroom_id, story_id, format_id, language, body)
   select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'newsletter-issue' returning id`,
  [
    newsroomId,
    nextStory,
    JSON.stringify({
      language: "en",
      title: "Tomorrow in AI",
      items: [{ kind: "news", headline: "Comet 2", body: "Comet 2 ships.", claim_ids: ["c1"] }],
    }),
  ],
);
const next = await id(
  `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
   values ($1, $2, $3, $4, 'en', 'scheduled') returning id`,
  [newsroomId, seriesId, nextAssignment, nextSlot],
);
await system.query(
  "insert into publication_renditions (newsroom_id, publication_id, position, rendition_id) values ($1, $2, 1, $3)",
  [newsroomId, next, nextRendition],
);
// What the held issue cost, and audience counts for the measures.
for (const [role, model, cost] of [
  ["desk", "gemini-flash", 0.42],
  ["fact-checker", "claude-haiku", 0.08],
] as const)
  await system.query(
    `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, cost_usd,
                             tokens_in, tokens_out, outcome, assignment_id, finished_at)
     values ($1, $2, 'preview', $3, 'v1', 'seed', $4, 12000, 1800, 'submitted', $5, now())`,
    [newsroomId, role, model, cost, heldAssignment],
  );
await system.query(
  `insert into page_views (newsroom_id, publication_id, day, count)
   values ($1, $2, current_date, 37), ($1, $3, current_date, 12)`,
  [newsroomId, published, publishedFa],
);
const telegram = await id(
  `insert into channels (newsroom_id, kind, language, external_id, checked_at, check_result)
   values ($1, 'telegram', 'en', '@anr_preview_en', now(),
           '{"ok": false, "problem": "the bot is not an admin of the channel", "detail": {"chat_type": "channel"}}')
   returning id`,
  [newsroomId],
);
await system.query(
  "insert into channel_stats (newsroom_id, channel_id, day, subscribers) values ($1, $2, current_date, 120)",
  [newsroomId, telegram],
);
// Sources: one healthy with a fresh lead, one failing, one whose terms nobody checked.
for (const [slug, terms, failures, status, error] of [
  ["example-lab-blog", "2026-10-01", 0, 200, null],
  ["nova-feed", "2026-10-01", 5, 503, "HTTP 503 Service Unavailable"],
  ["unchecked-site", null, 0, null, null],
] as const) {
  const sourceId = await id(
    `insert into sources (newsroom_id, slug, kind, url, publisher, tier, fetch_every, terms_checked)
     values ($1, $2, 'rss', $3, 'Preview', 2, '1 hour', $4)
     on conflict (newsroom_id, slug) do update set removed_at = null, terms_checked = excluded.terms_checked
     returning id`,
    [newsroomId, slug, `https://${slug}.example/feed`, terms],
  );
  if (terms)
    await system.query(
      `insert into source_fetch_state (newsroom_id, source_id, last_fetched_at, last_status, last_error, consecutive_failures)
       values ($1, $2, now() - interval '20 minutes', $3, $4, $5)`,
      [newsroomId, sourceId, status, error, failures],
    );
  if (failures === 0 && terms)
    await system.query(
      `insert into leads (newsroom_id, source_id, uri, headline, body, language, content_hash, tier)
       values ($1, $2, 'https://example-lab-blog.example/orbit', 'Orbit', 'Orbit text.', 'en', 'seed', 2)`,
      [newsroomId, sourceId],
    );
}
await system.query(
  `insert into notices (newsroom_id, kind, key, detail) values ($1, 'no-channel', 'telegram:fa', '{"kind": "telegram", "language": "fa"}')`,
  [newsroomId],
);
// Planning (milestone 5): two proposed themes for the next cycle, and an open weekly pick.
const classicId = await id(
  `insert into series (newsroom_id, slug, format_id, languages, config)
   select $1, 'weekly-classic', f.id, '{fa,en}', $2
   from formats f where f.slug = 'classic-article'
   on conflict (newsroom_id, slug) do update set removed_at = null, config = excluded.config
   returning id`,
  [
    newsroomId,
    JSON.stringify({
      name: { fa: "مقاله‌ی کلاسیک هفته", en: "Classic Paper of the Week" },
      cadence: { weekly: "wed 10:00" },
      pick: { planner_proposes: 3, by: "mon", editor_picks_by: "tue" },
      channels: { site: ["fa", "en"] },
    }),
  ],
);
const paper = await id(
  `insert into leads (newsroom_id, uri, headline, body, language, content_hash, tier)
   values ($1, 'https://arxiv.org/abs/1706.03762', 'Attention Is All You Need', 'The Transformer.', 'en', 'seed-paper', 1)
   returning id`,
  [newsroomId],
);
const nextStart = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const weeksOf = (start: string) =>
  [0, 7, 14, 21, 28].map((d) =>
    new Date(Date.parse(start) + d * 86_400_000).toISOString().slice(0, 10),
  );
for (const [theme, angle] of [
  [
    "Open weights",
    "Who builds open models, who can inspect them, and what changes when weights are public.",
  ],
  [
    "Small models",
    "How much a model needs to be useful: distillation, quantisation and on-device work.",
  ],
]) {
  await system.query(
    `insert into editorial_cycles (newsroom_id, starts, ends, theme, angle, calendar, rationale, lead_ids)
     values ($1, $2::date, $2::date + 30, $3, $4, $5, $6, $7)`,
    [
      newsroomId,
      nextStart,
      theme,
      angle,
      JSON.stringify(
        weeksOf(nextStart).map((week, i) => ({ week, focus: `${theme}, part ${i + 1}` })),
      ),
      "Releases in this area doubled in the lead pool over the last month.",
      [paper],
    ],
  );
}
const current = await id(
  `insert into editorial_cycles (newsroom_id, starts, ends, theme, angle, status, decided_at)
   values ($1, $2::date - 25, $2::date, 'Agents at work', 'What agents do in real jobs.', 'approved', now()) returning id`,
  [newsroomId, nextStart],
);
await system.query(
  `insert into picks (newsroom_id, cycle_id, series_id, week, candidates, deadline, slot)
   values ($1, $2, $3, current_date, $4, now() + interval '1 day', now() + interval '34 hours')`,
  [
    newsroomId,
    current,
    classicId,
    JSON.stringify(
      ["Attention Is All You Need", "Deep Residual Learning", "Sequence to Sequence Learning"].map(
        (title) => ({
          title,
          angle: `${title}: the paper, its authors, and what it changed.`,
          why: "It is the root of this week's focus.",
          lead_ids: [paper],
        }),
      ),
    ),
  ],
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
