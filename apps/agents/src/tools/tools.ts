// The four things an agent can do (invariant 2, D73): read a lead, search the newsroom's lead pool,
// request a source through ingestion, submit. Nothing else is reachable from a graph: no web, no
// send, no other write. Research tools are bound to models; code calls submit after validation.
import type { Pool } from "@anr/db";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import type { IngestionClient } from "../ingest.ts";
import { type LeadText, MAX_SEARCH_RESULTS, readLead, searchLeads } from "./leads.ts";

export const TOOL_NAMES = ["read_lead", "search_leads", "request_source", "submit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** What every tool of one run is bound to: its newsroom and its Agent run. */
export interface ToolContext {
  pool: Pool;
  newsroomId: string;
  agentRunId: string;
  /** The newsroom's primary language: how a search query is normalised. */
  language: string;
  ingestion: Pick<IngestionClient, "requestSource">;
  /** Leads read in this run, as shown to the model; claims may cite only these (D77). */
  readLeads: Map<string, LeadText>;
}

/** The submit tool's handler, supplied by the role (desk or renderer); the run's only write. */
export type SubmitHandler<T> = (draft: T) => Promise<string>;

/** Tool results go back to the model as text; every failure is an answer, never a throw. */
const json = (value: unknown) => JSON.stringify(value);

export function researchTools(ctx: ToolContext): StructuredToolInterface[] {
  const read = tool(
    async ({ lead_id }) => {
      if (!z.uuid().safeParse(lead_id).success) return json({ error: "no such lead" });
      const lead = await readLead(ctx.pool, ctx.newsroomId, lead_id);
      if (!lead) return json({ error: "no such lead" });
      ctx.readLeads.set(lead.id, lead);
      return json(lead);
    },
    {
      name: "read_lead",
      description:
        "Read one stored lead: its headline, publisher, tier (1 best), date and full stored text. Claims may quote only text you read here.",
      schema: z.object({ lead_id: z.string().describe("The lead's id") }),
    },
  );
  const search = tool(
    async ({ query }) => json(await searchLeads(ctx.pool, ctx.newsroomId, query, ctx.language)),
    {
      name: "search_leads",
      description: `Search this newsroom's stored leads by words (any language). Returns up to ${MAX_SEARCH_RESULTS} leads with summaries; read one before citing it.`,
      schema: z.object({ query: z.string().min(3).describe("Words to look for") }),
    },
  );
  const request = tool(
    async ({ url }) => {
      const outcome = await ctx.ingestion.requestSource(ctx.newsroomId, ctx.agentRunId, url);
      switch (outcome.kind) {
        case "lead":
          return json({
            lead_id: outcome.result.lead_id,
            headline: outcome.result.headline,
            tier: outcome.result.tier,
            already_stored: !outcome.result.created,
          });
        case "refused":
          return json({
            error:
              outcome.status === 429
                ? "this run has made all the source requests it may"
                : `refused: ${outcome.detail}`,
          });
        case "failed":
          return json({ error: `could not fetch it now: ${outcome.detail}` });
      }
    },
    {
      name: "request_source",
      description:
        "Ask for a public web page to be fetched and stored as a lead, then read it with read_lead. A few per run; an unknown site's lead is tier 3.",
      schema: z.object({ url: z.url().describe("The page's URL") }),
    },
  );
  return [read, search, request];
}

/**
 * The submit tool. Code calls it once a draft validates; it is a tool so the only write a run can
 * make has one definition and one name.
 */
export function submitTool<T>(handler: SubmitHandler<T>): StructuredToolInterface {
  return tool(async ({ draft }) => handler(draft as T), {
    name: "submit",
    description: "Submit the validated draft. Ends the run.",
    schema: z.object({ draft: z.unknown() }),
  });
}

/** Every tool a run can reach. A test pins the names to TOOL_NAMES. */
export function agentTools<T>(
  ctx: ToolContext,
  submit: SubmitHandler<T>,
): StructuredToolInterface[] {
  return [...researchTools(ctx), submitTool(submit)];
}
