import { fileURLToPath } from "node:url";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatSchema } from "../context.ts";
import type { ChatLike } from "../model.ts";
import { deskSteps } from "../prompts/roles.ts";
import { itemShape } from "../prompts/shapes.ts";
import type { LeadText } from "../tools/leads.ts";
import { assignmentMessage, writeDraft } from "./graph.ts";
import type { CitableLead } from "./validate.ts";

const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));
const LEAD = "11111111-1111-1111-1111-111111111111";
const lead: LeadText = {
  id: LEAD,
  uri: "https://lab.example/orbit",
  headline: "Orbit released",
  language: "en",
  tier: 1,
  publisher: "Example Lab",
  summary: null,
  beats: ["labs"],
  published: "2026-10-27",
  text: "Example Lab released Orbit today. It is 40 percent faster than Comet.",
  truncated: false,
  withdrawn: null,
  images: [],
};

/** Replays answers in order and records what it was sent. */
function scripted(answers: AIMessage[]): ChatLike & { seen: BaseMessage[][] } {
  const seen: BaseMessage[][] = [];
  return {
    seen,
    async invoke(messages) {
      seen.push(messages);
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      return next;
    },
  };
}

const valid = {
  story: {
    summary: "Orbit is out.",
    beat: "labs",
    claims: [
      {
        id: "c1",
        kind: "fact",
        text: "Orbit is 40 percent faster than Comet.",
        lead_id: LEAD,
        quoted_passage: "It is 40 percent faster than Comet.",
      },
    ],
  },
  rendition: {
    language: "en",
    title: "Daily",
    items: [{ kind: "news", headline: "Orbit", body: "Orbit is 40% faster.", claim_ids: ["c1"] }],
  },
};

function setup(answers: AIMessage[]) {
  const model = scripted(answers);
  const searched: string[] = [];
  const search = tool(
    async ({ query }) => {
      searched.push(query);
      return "[]";
    },
    { name: "search_leads", description: "search", schema: z.object({ query: z.string() }) },
  );
  const leads = new Map<string, CitableLead>([
    [LEAD, { text: lead.text, language: "en", withdrawn: false }],
  ]);
  const deps = {
    model,
    tools: [search],
    steps: deskSteps("en", itemShape(formatSchema(configDir, "newsletter-issue"))),
    validation: () => ({
      format: "newsletter-issue",
      language: "en",
      needsStory: true,
      beats: ["labs"],
      leads,
    }),
  };
  const assignment = {
    angle: null,
    series: "daily-newsletter",
    format: "newsletter-issue",
    language: "en",
    items: { news: "5-8" },
    beats: [{ slug: "labs", status: "open", description: "Lab news" }],
    leads: [lead],
  };
  return { model, searched, run: () => writeDraft(deps, "system prompt", assignment) };
}

describe("desk graph", () => {
  it("reads, outlines with tools, drafts, lists claims, and retries once with the errors", async () => {
    const { model, searched, run } = setup([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "t1", name: "search_leads", args: { query: "Orbit" } }],
      }),
      new AIMessage('{"beat": "labs", "summary": "s", "items": []}'),
      new AIMessage('{"language": "en", "title": "Daily", "items": []}'),
      new AIMessage(JSON.stringify({ ...valid, story: { ...valid.story, beat: "gossip" } })),
      new AIMessage(`Fixed:\n${JSON.stringify(valid)}`),
    ]);
    const outcome = await run();
    expect(outcome.draft).toMatchObject({ story: { beat: "labs" } });
    expect(searched).toEqual(["Orbit"]);
    // The tool's answer went back to the model before the outline.
    expect(model.seen[1]?.some((m) => m instanceof ToolMessage)).toBe(true);
    // The retry carried the validation error.
    expect(String(model.seen[4]?.at(-1)?.content)).toContain('story.beat "gossip"');
  });

  it("ends with the errors after a second invalid answer", async () => {
    const { run } = setup([
      new AIMessage("{}"),
      new AIMessage("{}"),
      new AIMessage("not json"),
      new AIMessage('{"rendition": {}}'),
    ]);
    const outcome = await run();
    expect(outcome.draft).toBeNull();
    expect(outcome.errors.length).toBeGreaterThan(0);
  });

  it("answers an unknown tool with an error instead of running anything", async () => {
    const { model, run } = setup([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "t1", name: "fetch_url", args: { url: "x" } }],
      }),
      new AIMessage("{}"),
      new AIMessage("{}"),
      new AIMessage(JSON.stringify(valid)),
    ]);
    await run();
    const answer = model.seen[1]?.find((m) => m instanceof ToolMessage);
    expect(String(answer?.content)).toContain("no tool named fetch_url");
  });

  it("puts the assignment's leads, beats and withdrawn marks in the first message", () => {
    const text = assignmentMessage({
      angle: "Speed",
      series: "s",
      format: "newsletter-issue",
      language: "fa",
      items: {},
      beats: [
        { slug: "labs", status: "open", description: "Lab news" },
        { slug: "gossip", status: "banned", description: null },
        { slug: "policy", status: "restricted", description: "Law" },
      ],
      leads: [{ ...lead, summary: "Orbit is out.", withdrawn: "withdrawn on arXiv" }],
    });
    expect(text).toContain("Summary: Orbit is out.");
    expect(text).toContain(`## Lead ${LEAD}`);
    expect(text).toContain("WITHDRAWN: withdrawn on arXiv. Do not cite.");
    expect(text).toContain("- policy (restricted)");
    expect(text).not.toContain("gossip");
  });
});
