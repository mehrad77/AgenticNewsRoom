import { describe, expect, it } from "vitest";
import {
  dateLabel,
  entryPath,
  groupBy,
  inlineHtml,
  links,
  refs,
  teaser,
  textHtml,
} from "./reference.ts";

describe("textHtml", () => {
  it("writes paragraphs and bullets, escaping first", () => {
    expect(textHtml("first <b>\n- one\n- **two**\nlast")).toBe(
      "<p>first &#60;b&#62;</p>\n<ul><li>one</li><li><strong>two</strong></li></ul>\n<p>last</p>",
    );
    expect(textHtml("")).toBe("");
    expect(textHtml(undefined)).toBe("");
  });

  it("links only http(s) URLs", () => {
    expect(inlineHtml("[a](https://x.org) [b](javascript:alert(1))")).toBe(
      '<a href="https://x.org" rel="noopener">a</a> [b](javascript:alert(1))',
    );
    expect(inlineHtml("`code` and `https://x.org`")).toBe(
      '<code>code</code> and <a href="https://x.org" rel="noopener" dir="ltr">https://x.org</a>',
    );
  });
});

describe("teaser", () => {
  it("strips markup and cuts at a word", () => {
    expect(teaser("**bold** [link](https://x)")).toBe("bold link");
    const t = teaser("word ".repeat(100), 50);
    expect(t.length).toBeLessThanOrEqual(51);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("dates and groups", () => {
  it("writes Gregorian dates at the entry's precision", () => {
    expect(dateLabel("1936-11-01", "en", "month")).toBe("November 1936");
    expect(dateLabel("1936-01-01", "en", "year")).toBe("1936");
    expect(dateLabel("2026-10-24", "fa")).toContain("۲۰۲۶");
    expect(dateLabel(null, "en")).toBe("");
  });

  it("groups consecutive entries", () => {
    expect(groupBy([1, 1, 2, 1], String).map((g) => [g.key, g.entries.length])).toEqual([
      ["1", 2],
      ["2", 1],
      ["1", 1],
    ]);
  });
});

describe("facts", () => {
  it("keeps only safe links and well-formed refs", () => {
    expect(links([{ label: "a", url: "https://x" }, { label: "b", url: "ftp://y" }, null])).toEqual(
      [{ label: "a", url: "https://x" }],
    );
    expect(
      refs([
        { title: "T", year: 1990, entry: { kind: "paper", slug: "t" } },
        { title: "U", url: "javascript:x" },
        { nope: true },
      ]),
    ).toEqual([
      { title: "T", year: 1990, note: null, entry: { kind: "paper", slug: "t" }, url: null },
      { title: "U", year: null, note: null, entry: null, url: null },
    ]);
  });

  it("knows where an entry lives", () => {
    expect(entryPath("paper", "turing-1936")).toBe("/reference/papers/turing-1936");
    expect(entryPath("news-event", "2026-10-24-x")).toBe("/reference/news#2026-10-24-x");
  });
});
