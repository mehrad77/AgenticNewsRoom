import { describe, expect, it } from "vitest";
import { splitHead } from "./piece-head.ts";

describe("splitHead", () => {
  it("split after the AI label", () => {
    const html =
      '<article><h1>T</h1><p class="anr-disclosure"><a href="/p">AI-made</a></p><p>Body</p></article>';
    expect(splitHead(html)).toEqual([
      '<article><h1>T</h1><p class="anr-disclosure"><a href="/p">AI-made</a></p>',
      "<p>Body</p></article>",
    ]);
  });

  it("split after the title when there is no label", () => {
    expect(splitHead("<article><h1>T</h1><p>B</p></article>")).toEqual([
      "<article><h1>T</h1>",
      "<p>B</p></article>",
    ]);
  });

  it("keep a body with no head whole", () => {
    expect(splitHead("<p>B</p>")).toEqual(["", "<p>B</p>"]);
  });
});
