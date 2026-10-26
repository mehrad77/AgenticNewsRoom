import { describe, expect, it } from "vitest";
import { handleIngestSource, type IngestResult, ingestionClient } from "./ingest.ts";

const job = {
  newsroomId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
};
const result: IngestResult = {
  source_id: job.sourceId,
  not_modified: false,
  new_leads: ["33333333-3333-4333-8333-333333333333"],
  sightings: 1,
  known: 4,
  dropped: 0,
  retiered: 0,
  errors: [],
};

function fakeFetch(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (input: URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("ingestionClient", () => {
  it("posts the job as the ingest-run schema and validates the result", async () => {
    const seen: Request[] = [];
    const client = ingestionClient("http://127.0.0.1:8101", fakeFetch(200, result, seen));
    expect(await client.ingest(job)).toEqual({ kind: "done", result });
    expect(seen[0]?.url).toBe("http://127.0.0.1:8101/ingest");
    expect(await seen[0]?.json()).toEqual({ newsroom_id: job.newsroomId, source_id: job.sourceId });
  });

  it("treats 404 and 422 as a refusal, never a retry", async () => {
    const client = ingestionClient("http://x", fakeFetch(422, { detail: "no terms_checked" }));
    expect(await client.ingest(job)).toEqual({
      kind: "refused",
      status: 422,
      detail: '"no terms_checked"',
    });
  });

  it("throws on a failed source, so pg-boss retries", async () => {
    const client = ingestionClient("http://x", fakeFetch(502, { detail: "HTTP 503" }));
    await expect(client.ingest(job)).rejects.toThrow("ingestion answered 502");
  });

  it("rejects a result that breaks the contract", async () => {
    const client = ingestionClient("http://x", fakeFetch(200, { ...result, new_leads: ["nope"] }));
    await expect(client.ingest(job)).rejects.toThrow();
  });
});

describe("handleIngestSource", () => {
  it("hands new leads on for summaries", async () => {
    const handed: string[][] = [];
    await handleIngestSource(job, {
      ingestion: { ingest: async () => ({ kind: "done", result }) },
      onNewLeads: async (_n, ids) => {
        handed.push(ids);
      },
      log: () => {},
    });
    expect(handed).toEqual([result.new_leads]);
  });

  it("does nothing more for a refused or unchanged source", async () => {
    const handed: string[][] = [];
    const deps = {
      onNewLeads: async (_n: string, ids: string[]) => {
        handed.push(ids);
      },
      log: () => {},
    };
    await handleIngestSource(job, {
      ...deps,
      ingestion: { ingest: async () => ({ kind: "refused", status: 422, detail: "x" }) },
    });
    await handleIngestSource(job, {
      ...deps,
      ingestion: {
        ingest: async () => ({
          kind: "done",
          result: { ...result, not_modified: true, new_leads: [] },
        }),
      },
    });
    expect(handed).toEqual([]);
  });
});
