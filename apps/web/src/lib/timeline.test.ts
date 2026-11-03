import { itemHash } from "@anr/core";
import { describe, expect, it } from "vitest";
import { itemsOf, linksOf, nameIndex, timelineSeriesOf } from "./timeline.ts";

const piece = {
  id: "p1",
  series: "daily-newsletter",
  path: "/daily-newsletter/2026-10-24",
  day: "2026-10-24",
  origin: "imported",
  items: [
    {
      kind: "news",
      headline: "Claude Code v2",
      body: "متن",
      claim_ids: [],
      org: "Anthropic",
      news_kind: "tool",
      related: ["Claude Code"],
      url: "https://example.org/a",
      links: [
        { url: "https://example.org/docs", label: "Docs" },
        { url: "https://t.me/x/1", label: "telegram" },
      ],
      anchor: "2026-10-24-claude-code-v2",
    },
    { kind: "article", title: "Not news", lead_id: "l1", reason: "r", claim_ids: [] },
    { kind: "news", headline: "خبر تازه", body: "b", claim_ids: ["c1"] },
  ],
};

describe("itemsOf", () => {
  it("label an imported item until the gate checked it as it reads now (D184)", () => {
    const [first] = piece.items;
    const checked = { "items.0": itemHash(first as Record<string, unknown>), "items.2": "stale" };
    const out = itemsOf({ ...piece, checked }, "fa", () => undefined);
    expect(out.map((e) => e.origin)).toEqual(["pipeline", "imported"]);
    expect(itemsOf(piece, "fa", () => undefined).map((e) => e.origin)).toEqual([
      "imported",
      "imported",
    ]);
  });

  it("makes each news item a timeline entry linked to its piece", () => {
    const out = itemsOf(piece, "fa", (id) => (id === "c1" ? "https://lead.example/1" : undefined));
    expect(out).toHaveLength(2);
    // Its kind names its series, so a link to it opens that series' timeline.
    expect(timelineSeriesOf(out[0]?.kind ?? "")).toBe("daily-newsletter");
    expect(timelineSeriesOf("paper")).toBeNull();
    expect(out[0]).toMatchObject({
      slug: "2026-10-24-claude-code-v2",
      titleLanguage: "en",
      date: "2026-10-24",
      origin: "imported",
      facts: {
        org: "Anthropic",
        url: "https://example.org/a",
        links: [{ url: "https://example.org/docs", label: "Docs" }],
        telegram: ["https://t.me/x/1"],
        piece: "/daily-newsletter/2026-10-24",
      },
      body: { fa: { summary: "متن" } },
    });
    // No anchor or url of its own: a position on the day, and its first claim's lead.
    expect(out[1]).toMatchObject({
      slug: "2026-10-24-3",
      titleLanguage: "fa",
      facts: { url: "https://lead.example/1" },
    });
  });
});

describe("linksOf", () => {
  it("links org and related names to the entries that bear them, by any name", () => {
    const names = nameIndex([
      {
        kind: "organisation",
        slug: "anthropic",
        title: "Anthropic",
        facts: { names: { fa: "آنتروپیک", en: "Anthropic" }, aliases: ["Anthropic PBC"] },
      },
      { kind: "product", slug: "claude-code", title: "Claude Code", facts: {} },
    ]);
    const [entry] = itemsOf(piece, "fa", () => undefined);
    if (!entry) throw new Error("no entry");
    expect(linksOf(entry, names)).toEqual([
      { kind: "made-by", label: "Anthropic", toKind: "organisation", toSlug: "anthropic" },
      { kind: "mentions", label: "Claude Code", toKind: "product", toSlug: "claude-code" },
    ]);
    expect(entry.facts.org_names).toEqual({ fa: "آنتروپیک", en: "Anthropic" });
    expect(names.get("anthropic pbc")?.slug).toBe("anthropic");
  });
});

describe("mostNamed", () => {
  it("counts the entries the items link to, most named first, an org in the page's language", async () => {
    const { mostNamed } = await import("./reference-page.ts");
    const [a] = itemsOf(piece, "fa", () => undefined);
    if (!a) throw new Error("no entry");
    a.facts.org_names = { fa: "آنتروپیک" };
    const b = { ...a, id: "p1:9", facts: { ...a.facts } };
    const links = new Map([
      [
        a.id,
        [
          { kind: "made-by", label: "Anthropic", toKind: "organisation", toSlug: "anthropic" },
          { kind: "mentions", label: "Claude Code", toKind: "product", toSlug: "claude-code" },
        ],
      ],
      [
        b.id,
        [{ kind: "made-by", label: "Anthropic", toKind: "organisation", toSlug: "anthropic" }],
      ],
    ]);
    expect(mostNamed([a, b], links, "fa")).toEqual([
      { kind: "organisation", slug: "anthropic", label: "آنتروپیک", count: 2 },
      { kind: "product", slug: "claude-code", label: "Claude Code", count: 1 },
    ]);
  });
});
