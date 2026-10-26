import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { parseAnswer, summarise } from "./graph.ts";
import { summariserPrompt } from "./prompt.ts";

const beats = [
  {
    slug: "labs",
    description: "What AI labs announce and ship",
    topics: ["artificial intelligence"],
  },
  {
    slug: "research",
    description: null,
    topics: ["artificial intelligence", "scientific research"],
  },
];
const lead = { headline: "Orbit", language: "en", body: "Example Lab released Orbit, a model." };
const slugs = beats.map((b) => b.slug);

describe("parseAnswer", () => {
  it("accepts a summary and known beats, even inside a code fence", () => {
    expect(
      parseAnswer('```json\n{"summary": "Orbit is out.", "beats": ["labs", "labs"]}\n```', slugs),
    ).toEqual({
      summary: "Orbit is out.",
      beats: ["labs"],
    });
  });

  it("refuses invented beats, missing fields and non-JSON", () => {
    expect(parseAnswer('{"summary": "x", "beats": ["medtop:20001298"]}', slugs)).toEqual([
      "unknown beats medtop:20001298; use only labs, research",
    ]);
    expect(parseAnswer('{"beats": []}', slugs)).toHaveLength(1);
    expect(parseAnswer("I think it is about labs.", slugs)).toEqual([
      "no JSON object in the answer",
    ]);
  });
});

describe("summariser graph", () => {
  it("returns the first valid answer", async () => {
    const model = new FakeListChatModel({
      responses: ['{"summary": "Orbit is out.", "beats": ["labs"]}'],
    });
    const out = await summarise(model, lead, beats);
    expect(out.result).toEqual({ summary: "Orbit is out.", beats: ["labs"] });
  });

  it("retries once with the errors, then succeeds", async () => {
    const model = new FakeListChatModel({
      responses: [
        '{"summary": "Orbit.", "beats": ["ai-labs"]}',
        '{"summary": "Orbit.", "beats": ["labs"]}',
      ],
    });
    const out = await summarise(model, lead, beats);
    expect(out.result).toEqual({ summary: "Orbit.", beats: ["labs"] });
  });

  it("gives up after a second invalid answer", async () => {
    const model = new FakeListChatModel({ responses: ["no", "still no", "never asked"] });
    const out = await summarise(model, lead, beats);
    expect(out.result).toBeNull();
    expect(out.errors).toEqual(["no JSON object in the answer"]);
  });
});

describe("prompt", () => {
  it("lists the beats with their Media Topic labels and stays small", () => {
    const prompt = summariserPrompt(lead, beats);
    expect(prompt).toContain(
      "- labs: What AI labs announce and ship (topics: artificial intelligence)",
    );
    expect(prompt).toContain("- research: (topics: artificial intelligence; scientific research)");
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(5 * 1024);
  });
});
