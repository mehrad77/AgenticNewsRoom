import { itemHash } from "@anr/core";
import { describe, expect, it } from "vitest";
import { causeOf, type RecheckRows, reasonOf, recheckReport } from "./recheck.ts";

const news = (headline: string, claims: string[] = []) => ({
  kind: "news",
  headline,
  body: `${headline}.`,
  url: `https://lab.example/${headline.toLowerCase().replaceAll(" ", "-")}`,
  claim_ids: claims,
});

// One imported day in two languages, its items as the dev trial left them (D184).
const en = [
  news("Checked"),
  news("Not taken"),
  news("Source refused"),
  news("Page down"),
  news("Names left out"),
  news("Fact check partial", ["c1"]),
  news("Item match fail", ["c2"]),
  news("Style only", ["c3"]),
];
const fa = en.map((i) => ({ ...i, headline: `${i.headline} (fa)`, body: `${i.body} (fa)` }));
const base: RecheckRows = {
  renditions: [
    {
      id: "r-en",
      story_id: "s1",
      slot: new Date("2026-10-30T06:00:00Z"),
      language: "en",
      items: en,
    },
    {
      id: "r-fa",
      story_id: "s1",
      slot: new Date("2026-10-30T06:00:00Z"),
      language: "fa",
      items: fa,
    },
  ],
  publications: [
    { id: "p-fa", language: "fa", title: "روز", rendition_id: "r-fa" },
    { id: "p-en", language: "en", title: "The day", rendition_id: "r-en" },
  ],
  checked: [
    { rendition_id: "r-en", item: "items.0", text_hash: itemHash(en[0] as never) },
    { rendition_id: "r-fa", item: "items.0", text_hash: itemHash(fa[0] as never) },
    // Checked in English only, with an older text in Persian.
    { rendition_id: "r-en", item: "items.7", text_hash: itemHash(en[7] as never) },
    { rendition_id: "r-fa", item: "items.7", text_hash: "stale" },
  ],
  runs: [
    { story_id: "s1", item: 0, outcome: "submitted", detail: null },
    {
      story_id: "s1",
      item: 2,
      outcome: "error",
      detail: { error: "source: the source's terms are not checked yet (D17)" },
    },
    {
      story_id: "s1",
      item: 3,
      outcome: "error",
      detail: { error: "source: ingestion answered 502" },
    },
    {
      story_id: "s1",
      item: 4,
      outcome: "error",
      detail: {
        error:
          "fa: these are in the item but in no claim's text; put each in a claim, exactly as written: Devin",
      },
    },
    { story_id: "s1", item: 5, outcome: "submitted", detail: null },
    { story_id: "s1", item: 6, outcome: "submitted", detail: null },
    { story_id: "s1", item: 7, outcome: "submitted", detail: null },
  ],
  claims: [
    { id: "k1", story_id: "s1", ref: "c1", text: "Google expanded access." },
    { id: "k2", story_id: "s1", ref: "c2", text: "Mistral raised money." },
    { id: "k3", story_id: "s1", ref: "c3", text: "A style claim." },
  ],
  checks: [
    // Length and style rules are not part of the imported verdict.
    {
      claim_id: null,
      rendition_id: "r-fa",
      item: null,
      kind: "code",
      name: "style-lint",
      result: "fail",
      detail: { issues: ["mostly not in Persian script"] },
    },
    {
      claim_id: null,
      rendition_id: "r-en",
      item: null,
      kind: "code",
      name: "format:news-item-count",
      result: "fail",
      detail: { count: 4, range: [5, 8] },
    },
    {
      claim_id: null,
      rendition_id: "r-en",
      item: null,
      kind: "code",
      name: "schema",
      result: "pass",
      detail: null,
    },
    // Re-run: the later pass replaces the earlier fail.
    {
      claim_id: "k1",
      rendition_id: null,
      item: null,
      kind: "code",
      name: "quote-match",
      result: "fail",
      detail: null,
    },
    {
      claim_id: "k1",
      rendition_id: null,
      item: null,
      kind: "code",
      name: "quote-match",
      result: "pass",
      detail: null,
    },
    {
      claim_id: "k1",
      rendition_id: null,
      item: null,
      kind: "fact-check",
      name: "fact-check",
      result: "partial",
      detail: {
        by: { model: "gemma" },
        reason: "The passage does not mention deep analysis.",
        position: 0,
      },
    },
    {
      claim_id: "k2",
      rendition_id: null,
      item: null,
      kind: "fact-check",
      name: "fact-check",
      result: "pass",
      detail: { position: 0 },
    },
    {
      claim_id: null,
      rendition_id: "r-en",
      item: "items.6",
      kind: "item-match",
      name: "item-match",
      result: "fail",
      detail: {
        by: { model: "gemma" },
        reason: "at a post-money valuation of more than €21 billion",
      },
    },
    {
      claim_id: null,
      rendition_id: "r-fa",
      item: "items.6",
      kind: "item-match",
      name: "item-match",
      result: "pass",
      detail: null,
    },
  ],
};

describe("recheckReport", () => {
  const report = recheckReport(base);
  const [day] = report.days;
  const item = (i: number) => day?.items[i];

  it("names the day by its English publication", () => {
    expect(day).toMatchObject({ story_id: "s1", publication_id: "p-en", title: "The day" });
    expect(day?.slot).toBe("2026-10-30T06:00:00.000Z");
  });

  it("counts an item checked only when every language's text matches its checked hash", () => {
    expect(item(0)?.status).toBe("checked");
    expect(item(7)?.languages).toEqual([
      { language: "en", checked: true },
      { language: "fa", checked: false },
    ]);
    expect(item(7)?.status).toBe("checks");
    expect(item(7)?.reasons).toEqual([
      { language: "fa", check: "item-match", result: "missing", claim: null, reason: null },
    ]);
  });

  it("waits on items the recheck has not taken", () => {
    expect(item(1)).toMatchObject({ status: "waiting", reasons: [] });
  });

  it("says why the source or the claims failed", () => {
    expect(item(2)).toMatchObject({ status: "source" });
    expect(item(3)?.reasons[0]?.reason).toBe("source: ingestion answered 502");
    expect(item(4)).toMatchObject({ status: "claims" });
    expect(item(4)?.reasons[0]).toMatchObject({ language: "fa", check: "claims" });
    expect(item(4)?.reasons[0]?.reason).toMatch(/^these are in the item/);
  });

  it("gives the fact-checker's reason with the claim, after a re-run's latest result", () => {
    expect(item(5)?.status).toBe("checks");
    const reasons = item(5)?.reasons ?? [];
    expect(reasons.map((r) => r.check)).toEqual(["fact-check", "fact-check"]);
    expect(reasons[0]).toMatchObject({
      result: "partial",
      claim: "Google expanded access.",
      reason: "The passage does not mention deep analysis.",
    });
  });

  it("reports an item-match fail only for the language that failed", () => {
    expect(item(6)?.reasons).toEqual([
      {
        language: "en",
        check: "item-match",
        result: "fail",
        claim: null,
        reason: "at a post-money valuation of more than €21 billion",
      },
    ]);
  });

  it("never gives a style or length rule as the reason", () => {
    const all = day?.items.flatMap((i) => i.reasons.map((r) => r.check)) ?? [];
    expect(all).not.toContain("style-lint");
    expect(all).not.toContain("format:news-item-count");
  });

  it("counts the statuses and the causes", () => {
    expect(report.counts).toEqual({
      checked: 1,
      waiting: 1,
      running: 0,
      source: 2,
      claims: 1,
      checks: 3,
    });
    expect(report.causes).toContainEqual({ cause: "source's terms not checked", items: 1 });
    expect(report.causes).toContainEqual({ cause: "source page did not load", items: 1 });
    expect(report.causes).toContainEqual({
      cause: "names or numbers left out of claims",
      items: 1,
    });
    expect(report.causes).toContainEqual({ cause: "fact-check partial", items: 1 });
  });
});

describe("reasonOf", () => {
  it("lists a detail's fields when it has no reason", () => {
    expect(reasonOf({ needs: 2, tier1: false, publishers: ["github.com"] })).toBe(
      "needs: 2; publishers: github.com",
    );
    expect(reasonOf(null)).toBeNull();
  });
});

describe("causeOf", () => {
  it("groups quote misses", () => {
    expect(
      causeOf({
        language: "en",
        check: "claims",
        result: "error",
        claim: null,
        reason: "claims[0].passage is not in the source text; copy it exactly",
      }),
    ).toBe("quote not in the source");
  });
});
