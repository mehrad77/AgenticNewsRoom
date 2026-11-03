import { describe, expect, it } from "vitest";
import { itemsOf, linksOf, nameIndex, TIMELINE_ITEM } from "./timeline.ts";

const piece = {
  id: "p1",
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
  it("makes each news item a timeline entry linked to its piece", () => {
    const out = itemsOf(piece, "fa", (id) => (id === "c1" ? "https://lead.example/1" : undefined));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: TIMELINE_ITEM,
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
