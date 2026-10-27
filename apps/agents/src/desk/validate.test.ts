import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CitableLead,
  parseJson,
  quoteKey,
  type ValidationContext,
  validateDraft,
} from "./validate.ts";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../packages/schemas/fixtures/normalization.json", import.meta.url),
    ),
    "utf8",
  ),
) as { cases: { name: string; input: string; expected: string; language?: string }[] };

const LEAD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const leads = new Map<string, CitableLead>([
  [
    LEAD,
    {
      text: "Example Lab released Orbit today. It is 40 percent faster than Comet.",
      language: "en",
      withdrawn: false,
    },
  ],
  [
    OTHER,
    {
      text: "A withdrawn preprint says Orbit is 40 percent faster than Comet.",
      language: "en",
      withdrawn: true,
    },
  ],
]);
const ctx: ValidationContext = {
  format: "newsletter-issue",
  language: "fa",
  needsStory: true,
  beats: ["labs", "research"],
  leads,
};

const news = (claim_ids: string[]) => ({
  kind: "news",
  headline: "اوربیت",
  body: "متن",
  claim_ids,
});
const draft = (claims: object[], items = [news(["c1"])]) => ({
  story: { summary: "s", beat: "labs", claims },
  rendition: { language: "fa", title: "خبرنامه", items },
});
const claim = (over: object = {}) => ({
  id: "c1",
  kind: "fact",
  text: "Orbit is 40 percent faster than Comet.",
  lead_id: LEAD,
  quoted_passage: "It is 40   percent faster than Comet",
  ...over,
});

describe("submit validation (D77)", () => {
  it("accepts a draft whose claims quote their leads, after normalising whitespace", () => {
    expect(validateDraft(draft([claim()]), ctx)).toMatchObject({ story: { beat: "labs" } });
  });

  it("returns schema errors with their paths", () => {
    const errors = validateDraft({ rendition: { language: "fa", items: [] } }, ctx);
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/^rendition\.title/)]));
  });

  it("rejects what the schema cannot express", () => {
    const errors = validateDraft(
      {
        ...draft(
          [
            claim({ quoted_passage: "It is 50 percent faster than Comet" }),
            claim({ id: "c2", lead_id: OTHER }),
            claim({ id: "c3", lead_id: "33333333-3333-3333-3333-333333333333" }),
            claim({ id: "c4", quoted_passage: "Orbit" }),
          ],
          [news([]), news(["c9"])],
        ),
        rendition: { language: "en", title: "t", items: [news([]), news(["c9"])] },
      },
      { ...ctx },
    );
    expect(errors).toEqual([
      'rendition.language must be "fa"',
      "claim c1: quoted_passage is not in lead 11111111-1111-1111-1111-111111111111's text; copy it exactly",
      "claim c2: lead 22222222-2222-2222-2222-222222222222 is withdrawn; do not cite it",
      "claim c3: lead 33333333-3333-3333-3333-333333333333 was not given or read in this run",
      "claim c4: quoted_passage is too short to prove anything",
      "rendition.items.0: lists no claims",
      "rendition.items.1: unknown claim c9",
    ]);
  });

  it("checks corroborating sources like the first one (D74)", () => {
    const errors = validateDraft(
      draft([
        claim({ also: [{ lead_id: OTHER, quoted_passage: "says Orbit is 40 percent faster" }] }),
      ]),
      ctx,
    );
    expect(errors).toEqual([
      "claim c1 also[0]: lead 22222222-2222-2222-2222-222222222222 is withdrawn; do not cite it",
    ]);
  });

  it("checks a renderer's rendition against the story's claims and refuses a new story", () => {
    const renderer = { ...ctx, language: "en", needsStory: false, storyClaimIds: ["c1"] };
    const rendition = { language: "en", title: "t", items: [news(["c1"])] };
    expect(validateDraft({ rendition }, renderer)).toMatchObject({ rendition });
    expect(validateDraft({ rendition: { ...rendition, items: [news(["c2"])] } }, renderer)).toEqual(
      ["rendition.items.0: unknown claim c2"],
    );
    expect(validateDraft(draft([claim()]), renderer)).toContain(
      "story: a rendition of an existing story carries no story",
    );
  });

  it("finds the JSON object in a model's answer", () => {
    expect(parseJson('Here it is:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJson("no json")).toBe("the answer has no JSON object");
  });

  it.each(vectors.cases)("normalises like the SQL function and the verifier: $name", (c) => {
    expect(quoteKey(c.input, c.language)).toBe(c.expected.replace(/\s+/g, " ").trim());
  });
});
