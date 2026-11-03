import { describe, expect, it } from "vitest";
import { lineOf } from "./series.ts";

describe("lineOf", () => {
  it("takes an episode's summary, else the first item's first paragraph or body", () => {
    expect(lineOf({ summary: " خلاصه ", items: [] })).toBe("خلاصه");
    expect(lineOf({ items: [{ heading: "h", paragraphs: ["first", "second"] }] })).toBe("first");
    expect(lineOf({ items: [{ kind: "news", headline: "h", body: "news body" }] })).toBe(
      "news body",
    );
    expect(lineOf({ items: [] })).toBeNull();
    expect(lineOf(null)).toBeNull();
  });
});
