// The send protocol end to end on anr_test with a fake Telegram: renderer → channel → Post rows.
import { randomBytes } from "node:crypto";
import { platformKey, sealCredentials } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { createRenderer, visibleLength } from "@anr/render";
import { afterAll, describe, expect, it } from "vitest";
import { type ChannelAdapter, SendError } from "./channels/types.ts";
import { checkChannel } from "./check.ts";
import { type PublishDeps, publishOne } from "./publish.ts";
import { snapshotSubscribers } from "./stats.ts";
import { sweepDue } from "./sweep.ts";

const pools = testPools();
afterAll(() => pools.end());

const platform = platformKey(randomBytes(32).toString("base64"));
const SLOT = new Date("2026-10-27T18:00:00Z");
const NOW = new Date("2026-10-27T18:00:30Z");

/** A fake Telegram: records every message, and fails a send when `fail` says so. */
function fakeTelegram(fail: (n: number, text: string) => SendError | undefined = () => undefined) {
  const sent: { chat: string | null; text: string }[] = [];
  let calls = 0;
  const adapter: ChannelAdapter = {
    async send(target, text) {
      calls += 1;
      const error = fail(calls, text);
      if (error) throw error;
      sent.push({ chat: target.externalId, text });
      return String(1000 + sent.length);
    },
  };
  return { adapter, sent, calls: () => calls };
}

const deps = (adapter: ChannelAdapter, more: Partial<PublishDeps> = {}): PublishDeps => ({
  pool: pools.app,
  renderer: createRenderer(),
  adapters: { telegram: adapter },
  platform,
  rootDomain: "example.test",
  now: () => NOW,
  random: () => 0.5,
  ...more,
});

/** A newsroom with a daily series (site + telegram in en) and one scheduled publication. */
async function scheduled(
  o: { items?: number; telegram?: boolean; site?: boolean; slot?: Date } = {},
) {
  const slot = o.slot ?? SLOT;
  const sys = pools.system;
  const newsroomId = await createTestNewsroom(sys, "pub");
  const one = async <T>(sql: string, params: unknown[]) =>
    ((await sys.query(sql, params)).rows[0] as T & { id: string }).id;
  const seriesId = await one(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily-newsletter', f.id, '{en}',
            '{"cadence": {"daily": "21:00"}, "channels": {"site": ["en"], "telegram": ["en"]}}'
     from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId],
  );
  const assignmentId = await one(
    "insert into assignments (newsroom_id, series_id, slot) values ($1, $2, $3) returning id",
    [newsroomId, seriesId, slot],
  );
  const storyId = await one(
    "insert into stories (newsroom_id, assignment_id) values ($1, $2) returning id",
    [newsroomId, assignmentId],
  );
  const items = Array.from({ length: o.items ?? 3 }, (_, i) => ({
    kind: "news",
    headline: `Item ${i + 1}`,
    body: `Body of item ${i + 1}. `.repeat(o.items && o.items > 6 ? 40 : 1).trim(),
    claim_ids: ["c1"],
  }));
  const renditionId = await one(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select $1, $2, f.id, 'en', $3 from formats f where f.slug = 'newsletter-issue' returning id`,
    [newsroomId, storyId, JSON.stringify({ language: "en", title: "Today in AI", items })],
  );
  const publicationId = await one(
    `insert into publications (newsroom_id, series_id, assignment_id, slot, language, status)
     values ($1, $2, $3, $4, 'en', 'scheduled') returning id`,
    [newsroomId, seriesId, assignmentId, slot],
  );
  await sys.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id)
     values ($1, $2, 1, $3)`,
    [newsroomId, publicationId, renditionId],
  );
  let telegramId = "";
  if (o.telegram !== false) {
    telegramId = await one(
      `insert into channels (newsroom_id, kind, language, external_id)
       values ($1, 'telegram', 'en', '@anr_test') returning id`,
      [newsroomId],
    );
    const sealed = sealCredentials(
      { bot_token: "123:FAKE" },
      { newsroomId, channelId: telegramId },
      platform,
    );
    await sys.query("update channels set credentials = $2 where id = $1", [telegramId, sealed]);
  }
  if (o.site !== false)
    await sys.query(
      "insert into channels (newsroom_id, kind, language) values ($1, 'site', 'en')",
      [newsroomId],
    );
  return { newsroomId, publicationId, telegramId };
}

const publication = async (id: string) =>
  (
    await pools.system.query<{
      status: string;
      path: string | null;
      title: string | null;
      search_text: string | null;
      edited: boolean;
    }>("select status, path, title, search_text, edited from publications where id = $1", [id])
  ).rows[0];

const posts = async (id: string) =>
  (
    await pools.system.query<{
      kind: string;
      part: number;
      status: string;
      external_id: string | null;
      body: string;
    }>(
      `select c.kind, p.part, p.status, p.external_id, p.body from posts p
       join channels c on c.id = p.channel_id where p.publication_id = $1 order by c.kind, p.part`,
      [id],
    )
  ).rows;

const holds = async (id: string) =>
  (
    await pools.system.query<{ name: string }>(
      "select name from checks where publication_id = $1 and kind = 'policy' order by at",
      [id],
    )
  ).rows.map((r) => r.name);

describe("publishing a scheduled publication", () => {
  it("sends every part in order, records each post and puts the piece on the site", async () => {
    const { newsroomId, publicationId } = await scheduled({ items: 12 });
    const tg = fakeTelegram();
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("published");

    expect(tg.sent.length).toBeGreaterThan(1);
    for (const m of tg.sent) {
      expect(m.chat).toBe("@anr_test");
      expect(visibleLength(m.text)).toBeLessThanOrEqual(4096);
      expect(m.text).toContain("AI-made");
    }
    const rows = await posts(publicationId);
    const telegram = rows.filter((r) => r.kind === "telegram");
    expect(telegram.map((r) => [r.part, r.status, r.external_id])).toEqual(
      tg.sent.map((_, i) => [i + 1, "sent", String(1001 + i)]),
    );
    expect(telegram.map((r) => r.body)).toEqual(tg.sent.map((m) => m.text));
    expect(rows.find((r) => r.kind === "site")?.status).toBe("sent");
    expect(rows.find((r) => r.kind === "site")?.external_id).toMatch(
      /^https:\/\/pub-[0-9a-f]{8}\.example\.test\/daily-newsletter\/2026-10-27$/,
    );
    expect(await publication(publicationId)).toMatchObject({
      status: "published",
      path: "/daily-newsletter/2026-10-27",
      title: "Today in AI",
      edited: false,
    });
    expect((await publication(publicationId))?.search_text).toContain("Item 12");

    // A second run finds it published and sends nothing.
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("not-due");
    expect(tg.calls()).toBe(tg.sent.length);
  });

  it("holds a part interrupted mid-send as unknown and never sends it again", async () => {
    const { newsroomId, publicationId, telegramId } = await scheduled();
    // A previous attempt wrote its post and started the call, then the process died.
    await pools.system.query(
      `insert into posts (newsroom_id, publication_id, channel_id, part, idempotency_key, body, attempted_at)
       values ($1, $2, $3, 1, 'k1', 'old text', now())`,
      [newsroomId, publicationId, telegramId],
    );
    const tg = fakeTelegram();
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("held");
    expect(tg.calls()).toBe(0);
    expect(await posts(publicationId)).toMatchObject([{ status: "unknown" }]);
    expect((await publication(publicationId))?.status).toBe("with-editor");
    expect(await holds(publicationId)).toEqual(["post-unknown"]);
  });

  it("holds an answer that may have been delivered", async () => {
    const { newsroomId, publicationId } = await scheduled({ items: 12 });
    const tg = fakeTelegram((n) => (n === 2 ? new SendError("unknown", "timed out") : undefined));
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("held");
    const telegram = (await posts(publicationId)).filter((r) => r.kind === "telegram");
    expect(telegram.slice(0, 2).map((r) => r.status)).toEqual(["sent", "unknown"]);
    expect(telegram.slice(2).every((r) => r.status === "pending")).toBe(true);
    expect((await publication(publicationId))?.status).toBe("with-editor");
  });

  it("retries a rate limit on the next sweep, sending each part once", async () => {
    const { newsroomId, publicationId } = await scheduled();
    const tg = fakeTelegram((n) => (n === 1 ? new SendError("retry", "429", 3) : undefined));
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("retry");
    expect((await publication(publicationId))?.status).toBe("scheduled");
    expect(await posts(publicationId)).toMatchObject([{ kind: "telegram", status: "failed" }]);
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("published");
    expect(tg.sent).toHaveLength(1);
  });

  it("holds what the channel refuses", async () => {
    const { newsroomId, publicationId } = await scheduled();
    const tg = fakeTelegram(() => new SendError("rejected", "400 chat not found"));
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("held");
    expect(await holds(publicationId)).toEqual(["channel-rejected"]);
    expect(await posts(publicationId)).toMatchObject([{ status: "failed" }]);
  });

  it("skips a channel the newsroom has not set up, telling the editor once", async () => {
    const { newsroomId, publicationId } = await scheduled({ telegram: false });
    const tg = fakeTelegram();
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("published");
    expect(tg.calls()).toBe(0);
    const { rows } = await pools.system.query(
      "select kind, key from notices where newsroom_id = $1",
      [newsroomId],
    );
    expect(rows).toEqual([{ kind: "no-channel", key: "telegram:en" }]);
  });

  it("holds a slot past due at a restore, until an editor touches it", async () => {
    const { newsroomId, publicationId } = await scheduled();
    // The restore happens now (wall clock), after the slot and after the row was last touched.
    await pools.system.query("insert into restores default values");
    try {
      const tg = fakeTelegram();
      // Its slot passed before the restore: it may have gone out already.
      expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("held");
      expect(await holds(publicationId)).toEqual(["restored"]);
      // An editor approves it after the restore: now it goes out.
      await pools.system.query(
        "update publications set status = 'scheduled', updated_at = now() + interval '1 second' where id = $1",
        [publicationId],
      );
      expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("published");
      expect(tg.sent).toHaveLength(1);
    } finally {
      await pools.migrator.query("delete from restores");
    }
  });

  it("lets one of two overlapping runs publish", async () => {
    const { newsroomId, publicationId } = await scheduled();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: ChannelAdapter = {
      async send() {
        await gate;
        return "1";
      },
    };
    const first = publishOne(deps(slow), newsroomId, publicationId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await publishOne(deps(slow), newsroomId, publicationId)).toBe("busy");
    release();
    expect(await first).toBe("published");
  });

  it("samples auto-published publications for review", async () => {
    const { newsroomId, publicationId } = await scheduled();
    const tg = fakeTelegram();
    await publishOne(deps(tg.adapter, { random: () => 0.05 }), newsroomId, publicationId);
    const { rows } = await pools.system.query(
      "select outcome from sample_reviews where publication_id = $1",
      [publicationId],
    );
    expect(rows).toEqual([{ outcome: null }]);
  });

  it("sends an editor's new text when nothing went out yet, and holds once something did", async () => {
    const { newsroomId, publicationId } = await scheduled({ items: 12 });
    const refuse = fakeTelegram(() => new SendError("rejected", "400 bot is not admin"));
    expect(await publishOne(deps(refuse.adapter), newsroomId, publicationId)).toBe("held");
    // The editor fixes the channel and rewrites the title, then approves.
    await pools.system.query(
      `update renditions set body = jsonb_set(body, '{title}', '"Edited title"')
       where id = (select rendition_id from publication_renditions where publication_id = $1)`,
      [publicationId],
    );
    await pools.system.query("update publications set status = 'scheduled' where id = $1", [
      publicationId,
    ]);
    // Part 1 goes out with the new text, then the answer to part 2 is lost.
    const tg = fakeTelegram((n) => (n === 2 ? new SendError("unknown", "reset") : undefined));
    expect(await publishOne(deps(tg.adapter), newsroomId, publicationId)).toBe("held");
    expect(tg.sent[0]?.text).toContain("Edited title");

    // Changing the text again once part 1 is out: a person decides, nothing is sent.
    await pools.system.query(
      "update posts set status = 'failed', attempted_at = null where status = 'unknown' and publication_id = $1",
      [publicationId],
    );
    await pools.system.query(
      `update renditions set body = jsonb_set(body, '{title}', '"Third title"')
       where id = (select rendition_id from publication_renditions where publication_id = $1)`,
      [publicationId],
    );
    await pools.system.query("update publications set status = 'scheduled' where id = $1", [
      publicationId,
    ]);
    const after = fakeTelegram();
    expect(await publishOne(deps(after.adapter), newsroomId, publicationId)).toBe("held");
    expect(after.calls()).toBe(0);
    expect((await holds(publicationId)).at(-1)).toBe("changed-after-send");
  });

  it("stops between parts once an editor holds the publication", async () => {
    const { newsroomId, publicationId } = await scheduled({ items: 12 });
    const tg = fakeTelegram();
    const holding: ChannelAdapter = {
      async send(target, text) {
        const id = await tg.adapter.send(target, text);
        await pools.system.query("update publications set status = 'with-editor' where id = $1", [
          publicationId,
        ]);
        return id;
      },
    };
    expect(await publishOne(deps(holding), newsroomId, publicationId)).toBe("not-due");
    expect(tg.sent).toHaveLength(1);
  });

  it("holds a channel still unreachable an hour after the slot", async () => {
    const { newsroomId, publicationId } = await scheduled();
    const tg = fakeTelegram(() => new SendError("retry", "unreachable"));
    const late = new Date(SLOT.getTime() + 61 * 60_000);
    expect(await publishOne(deps(tg.adapter, { now: () => late }), newsroomId, publicationId)).toBe(
      "held",
    );
    expect(await holds(publicationId)).toEqual(["channel-unreachable"]);
  });

  it("sweeps due publications across newsrooms", async () => {
    // A slot and clock long before any other test's fixtures, so this sweep touches only its own.
    const slot = new Date("2000-01-01T00:00:00Z");
    const { publicationId } = await scheduled({ slot });
    const tg = fakeTelegram();
    const counts = await sweepDue(
      deps(tg.adapter, { now: () => new Date(slot.getTime() + 60_000) }),
    );
    expect(counts.published).toBeGreaterThanOrEqual(1);
    expect((await publication(publicationId))?.status).toBe("published");
  });
});

describe("the daily subscriber snapshot", () => {
  it("records each Telegram channel's count once a day, and survives a failing channel", async () => {
    const { newsroomId, telegramId } = await scheduled();
    const broken = await pools.system.query<{ id: string }>(
      "insert into channels (newsroom_id, kind, language, external_id) values ($1, 'telegram', 'fa', '@gone') returning id",
      [newsroomId],
    );
    let count = 1200;
    const adapter: ChannelAdapter = {
      send: async () => "1",
      subscribers: async (t) => {
        if (t.externalId === "@gone") throw new SendError("rejected", "chat not found");
        expect(t.credentials).toEqual({ bot_token: "123:FAKE" });
        return count;
      },
    };
    const only = { ...deps(adapter), pool: pools.app };
    const first = await snapshotSubscribers(only);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    count = 1250;
    await snapshotSubscribers(only);
    const { rows } = await pools.system.query(
      "select subscribers from channel_stats where channel_id = $1",
      [telegramId],
    );
    expect(rows).toEqual([{ subscribers: 1250 }]);
    const none = await pools.system.query("select 1 from channel_stats where channel_id = $1", [
      broken.rows[0]?.id,
    ]);
    expect(none.rows).toHaveLength(0);
  });
});

describe("a channel check", () => {
  it("stores what the channel said, and a refusal as the problem, without sending", async () => {
    const { newsroomId, telegramId } = await scheduled();
    const fake = fakeTelegram();
    const result = async () =>
      (
        await pools.system.query(
          "select check_result, checked_at is not null as checked from channels where id = $1",
          [telegramId],
        )
      ).rows[0];
    fake.adapter.check = async (t) => {
      expect(t.credentials).toEqual({ bot_token: "123:FAKE" });
      return { ok: true, detail: { chat_title: "ANR" } };
    };
    await checkChannel(deps(fake.adapter), { newsroomId, channelId: telegramId });
    expect(await result()).toEqual({
      check_result: { ok: true, detail: { chat_title: "ANR" } },
      checked: true,
    });
    fake.adapter.check = async () => {
      throw new SendError("rejected", "Telegram getChat: 400 Bad Request: chat not found");
    };
    await checkChannel(deps(fake.adapter), { newsroomId, channelId: telegramId });
    expect((await result())?.check_result).toEqual({
      ok: false,
      problem: "Telegram getChat: 400 Bad Request: chat not found",
    });
    expect(fake.calls()).toBe(0);
  });
});

describe("an unexpected publisher error", () => {
  it("is retried while the slot is fresh, then held for a person", async () => {
    // Year 2000 again: no other test's fixtures are due at this clock.
    const slot = new Date("2000-01-02T00:00:00Z");
    const { publicationId } = await scheduled({ slot });
    const real = createRenderer();
    const broken = {
      ...real,
      disclosureLabel: async () => {
        throw new Error("template store unreadable");
      },
    };
    const run = (minutes: number) =>
      sweepDue(
        deps(fakeTelegram().adapter, {
          renderer: broken as never,
          now: () => new Date(slot.getTime() + minutes * 60_000),
        }),
      );
    await run(5);
    expect((await publication(publicationId))?.status).toBe("scheduled");
    await run(61);
    expect((await publication(publicationId))?.status).toBe("with-editor");
    expect(await holds(publicationId)).toEqual(["publisher-error"]);
  });
});
