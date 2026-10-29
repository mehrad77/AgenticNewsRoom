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
const draft = (claims: object[], items: object[] = [news(["c1"])]) => ({
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

  it("lifts a rendition written inside the story to the top level", () => {
    const { story, rendition } = draft([claim()]);
    const nested = { story: { ...story, rendition } };
    expect(validateDraft(nested, ctx)).toMatchObject({ story: { beat: "labs" }, rendition });
  });

  it("names a missing item kind instead of the union's message", () => {
    const { kind: _, ...noKind } = news(["c1"]);
    expect(validateDraft(draft([claim()], [noKind]), ctx)).toContain(
      'rendition.items.0: "kind" is missing',
    );
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

  it("keeps a renderer's items to the first rendition's kinds, leads and claims", () => {
    const article = (lead_id: string) => ({
      kind: "article",
      title: "t",
      lead_id,
      reason: "r",
      claim_ids: ["c1"],
    });
    const firstItems = [news(["c1"]), article(LEAD)];
    const renderer = {
      ...ctx,
      language: "en",
      needsStory: false,
      storyClaimIds: ["c1", "c2"],
      firstItems,
    };
    const rendition = (items: object[]) => ({ rendition: { language: "en", title: "t", items } });
    expect(validateDraft(rendition(firstItems), renderer)).toMatchObject({ rendition: {} });
    expect(validateDraft(rendition([news(["c1"])]), renderer)).toEqual([
      "rendition.items: 1 items; the first rendition has 2",
    ]);
    expect(validateDraft(rendition([news(["c2"]), article(OTHER)]), renderer)).toEqual([
      "rendition.items.0: claim_ids must be c1",
      `rendition.items.1: lead_id must be ${LEAD}`,
    ]);
  });

  it("lets an item show only a licensed image of the run's leads (D119)", () => {
    const story = { ...ctx, format: "artist-story", language: "en", media: new Set(["m1"]) };
    const piece = (media_id: string) => ({
      story: { summary: "s", beat: "labs", claims: [claim()] },
      rendition: {
        language: "en",
        title: "t",
        items: [{ paragraphs: ["p"], claim_ids: ["c1"], media_id }],
      },
    });
    expect(validateDraft(piece("m1"), story)).toMatchObject({ rendition: {} });
    expect(validateDraft(piece("m2"), story)).toEqual([
      "rendition.items.0: image m2 is not a licensed image of the leads",
    ]);
  });

  it("finds the JSON object in a model's answer", () => {
    expect(parseJson('Here it is:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJson("no json")).toBe("the answer has no JSON object");
  });

  it("closes brackets left open at the end, and repairs nothing else", () => {
    const lenient = { closeBrackets: true };
    expect(parseJson('{"a": {"b": [{"c": "x}"}]}', lenient)).toEqual({ a: { b: [{ c: "x}" }] } });
    expect(parseJson('{"a": [1, 2}', lenient)).toMatch(/does not parse/);
    expect(parseJson('{"a": "b" "c": 1}', lenient)).toMatch(/does not parse/);
    // A checker's verdict is read strictly: a truncated one holds.
    expect(parseJson('{"verdict": {"v": "supported"}')).toMatch(/does not parse/);
  });

  it.each(vectors.cases)("normalises like the SQL function and the verifier: $name", (c) => {
    expect(quoteKey(c.input, c.language)).toBe(c.expected.replace(/\s+/g, " ").trim());
  });
});
