import { describe, expect, it } from "vitest";
import { batches, parse, problem } from "./units.ts";

const u = (key: string, text: string) => ({ key, text });

describe("batches", () => {
  it("packs units up to the size, and a long one alone", () => {
    const out = batches(
      [u("a", "x".repeat(40)), u("b", "x".repeat(40)), u("c", "x".repeat(200))],
      100,
    );
    expect(out.map((b) => b.map((x) => x.key))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("problem", () => {
  const fa = "اولین خط با [پیوند](https://x.org/a)\n- یک\n- دو";
  it("keeps a faithful translation", () => {
    expect(
      problem(u("k", fa), "First line with a [link](https://x.org/a)\n- one\n- two"),
    ).toBeNull();
  });
  it("refuses changed links, bullets, Persian left over and empty answers", () => {
    expect(problem(u("k", fa), "First line with a [link](https://x.org/b)\n- one\n- two")).toBe(
      "links changed",
    );
    expect(problem(u("k", fa), "First line with a [link](https://x.org/a)\n- one and two")).toBe(
      "bullets changed",
    );
    expect(problem(u("k", "متن"), "متن فارسی مانده")).toBe("still Persian");
    expect(problem(u("k", "متن"), " ")).toBe("empty");
  });
});

describe("parse", () => {
  it("keeps good items and names the rest", () => {
    const batch = [u("a", "سلام دنیا"), u("b", "خداحافظ دوست")];
    const answer = '```json\n{"items":[{"key":"a","en":"Hello world"},{"key":"z","en":"x"}]}\n```';
    expect(parse(batch, answer)).toEqual({
      kept: [{ key: "a", en: "Hello world" }],
      rejected: [{ key: "b", why: "missing" }],
    });
    expect(parse(batch, "nope").rejected).toHaveLength(2);
  });
});
