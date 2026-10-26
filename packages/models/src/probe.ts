import type { ClientFactory } from "./adapters.ts";
import { type Catalog, roleChains } from "./catalog.ts";
import { classify, type FailureKind } from "./errors.ts";

export type ProbeOutcome = "ok" | "no-key" | "no-tools" | FailureKind;

export interface ProbeRow {
  catalogId: string;
  model: string;
  outcome: ProbeOutcome;
  detail?: string;
}

const PING = {
  type: "function" as const,
  function: {
    name: "ping",
    description: "Answer by calling this tool.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

/** Outcomes that mean the models file needs a change; rate limits and outages do not. */
export const BROKEN: ReadonlySet<ProbeOutcome> = new Set(["gone", "fatal", "no-tools"]);

/** Calls every model a role chain uses once, with one tool, and reports what came back. */
export async function probe(catalog: Catalog, client: ClientFactory): Promise<ProbeRow[]> {
  const ids = [...new Set(roleChains(catalog.config).flatMap(([, chain]) => chain))];
  const rows: ProbeRow[] = [];
  for (const id of ids) {
    const entry = catalog.entries.get(id);
    if (!entry) throw new Error(`unknown model ${id}`);
    const row = { catalogId: id, model: `${entry.provider}/${entry.model}` };
    if (!entry.apiKey) {
      rows.push({ ...row, outcome: "no-key", detail: entry.missingEnv.join(", ") });
      continue;
    }
    try {
      const message = await client(entry).invoke(
        [["human", "Call the ping tool with ok set to true."]],
        { tools: [PING], toolChoice: "any" },
      );
      const called = (message.tool_calls ?? []).some((c) => c.name === "ping");
      rows.push({ ...row, outcome: called ? "ok" : "no-tools" });
    } catch (error) {
      const failure = classify(error);
      rows.push({ ...row, outcome: failure.kind, detail: failure.message });
    }
  }
  return rows;
}
