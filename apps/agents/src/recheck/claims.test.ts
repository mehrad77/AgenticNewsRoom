import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { ChatLike } from "../model.ts";
import { parseClaims, writeClaims } from "./claims.ts";

const source = {
  language: "en",
  text: "Moonshot AI released Kimi K3.1 Pro today. The model has a context window of one million tokens.",
};
const item = { language: "fa", headline: "Kimi K3.1 Pro", body: "مون‌شات کیمی را منتشر کرد." };

const replies = (...texts: string[]): ChatLike => ({
  invoke: async () => new AIMessage(texts.shift() ?? "{}"),
});

describe("the claims of an imported item", () => {
  it("keep claims whose passages are in the source, whatever the spacing", () => {
    const out = parseClaims(
      JSON.stringify({
        claims: [
          {
            text: "مون‌شات کیمی را منتشر کرد",
            passage: "Moonshot AI  released Kimi K3.1 Pro today.",
          },
        ],
      }),
      source,
    );
    expect(out).toEqual({
      claims: [
        { text: "مون‌شات کیمی را منتشر کرد", passage: "Moonshot AI  released Kimi K3.1 Pro today." },
      ],
      unsupported: [],
    });
  });

  it("refuse a passage that is not in the source, or too short to prove anything", () => {
    const out = parseClaims(
      JSON.stringify({
        claims: [
          { text: "a", passage: "Moonshot released a model with two million tokens." },
          { text: "b", passage: "today." },
        ],
      }),
      source,
    );
    expect(out).toEqual({
      errors: [
        "claims[0].passage is not in the source text; copy it exactly",
        "claims[1].passage is too short to prove anything",
      ],
    });
  });

  it("snap a near-miss quote to the source's own sentence", async () => {
    const { snapPassage } = await import("./claims.ts");
    expect(snapPassage("The model has a context window of 1 million tokens", source)).toBe(
      "The model has a context window of one million tokens.",
    );
    expect(snapPassage("Moonshot raised two billion dollars from investors", source)).toBeNull();
  });

  it("retry with what was wrong, then give up", async () => {
    const bad = JSON.stringify({
      claims: [{ text: "a", passage: "not in the source at all, no." }],
    });
    const good = JSON.stringify({
      claims: [
        { text: "Kimi K3.1 Pro", passage: "The model has a context window of one million tokens." },
      ],
    });
    expect(await writeClaims(replies(bad, good), item, source)).toMatchObject({
      claims: [{ text: "Kimi K3.1 Pro" }],
    });
    expect(await writeClaims(replies(bad, bad, bad), item, source)).toEqual({
      error: "claims[0].passage is not in the source text; copy it exactly",
    });
  });
});

describe("uncovered", () => {
  it("list numbers and names the claims leave out", async () => {
    const { uncovered } = await import("./claims.ts");
    const en = { language: "en", headline: "IBM Deep Blue wins", body: "In 1997 in New York." };
    expect(uncovered(en, [{ text: "IBM's Deep Blue won in 1997" }])).toEqual(["New", "York"]);
    const fa = { language: "fa", headline: "IBM defeats Kasparov", body: "در سال ۱۹۹۷." };
    expect(uncovered(fa, [{ text: "IBM defeats Kasparov در 1997" }])).toEqual([]);
  });
});
