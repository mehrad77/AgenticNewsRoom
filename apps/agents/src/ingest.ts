import type { IngestSourceJob } from "@anr/core";
import { IngestResultSchema } from "@anr/schemas";

/** A run of one source can fetch dozens of pages at a polite pace; give it time. */
const INGEST_TIMEOUT_MS = 15 * 60 * 1000;

export type IngestResult = IngestResultSchema;
export type IngestOutcome =
  | { kind: "done"; result: IngestResult }
  /** 404 or 422: unknown ids, or a source that must not be fetched. A person must act; no retry. */
  | { kind: "refused"; status: number; detail: string };

export interface IngestionClient {
  ingest(job: IngestSourceJob): Promise<IngestOutcome>;
}

/**
 * The ingestion service's `POST /ingest` (services/ingestion). The bodies are the JSON Schemas
 * in packages/schemas, so both sides validate the same contract. Anything but 200, 404 or 422
 * throws, and pg-boss retries the job.
 */
export function ingestionClient(baseUrl: string, fetchImpl: typeof fetch = fetch): IngestionClient {
  return {
    async ingest(job) {
      const response = await fetchImpl(new URL("/ingest", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newsroom_id: job.newsroomId, source_id: job.sourceId }),
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
        return { kind: "refused", status: response.status, detail: JSON.stringify(body.detail) };
      }
      if (!response.ok) {
        throw new Error(`ingestion answered ${response.status}: ${await response.text()}`);
      }
      return { kind: "done", result: IngestResultSchema.parse(await response.json()) };
    },
  };
}

export interface IngestDeps {
  ingestion: IngestionClient;
  /** Called with the run's new leads, which still need a summary and beats. */
  onNewLeads(newsroomId: string, leadIds: string[]): Promise<void>;
  log?: (line: string) => void;
}

/** The `ingest-source` job: one source's fetch through the ingestion service. */
export async function handleIngestSource(job: IngestSourceJob, deps: IngestDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const outcome = await deps.ingestion.ingest(job);
  if (outcome.kind === "refused") {
    log(`[ingest] source ${job.sourceId} refused (${outcome.status}): ${outcome.detail}`);
    return;
  }
  const r = outcome.result;
  log(
    `[ingest] source ${job.sourceId}: ${r.not_modified ? "not modified" : `${r.new_leads.length} new`}` +
      `, ${r.sightings} copies, ${r.known} known, ${r.dropped} dropped, ${r.retiered} retiered` +
      `, ${r.errors.length} errors`,
  );
  for (const e of r.errors) log(`[ingest]   ${e.url}: ${e.error}`);
  if (r.new_leads.length > 0) await deps.onNewLeads(job.newsroomId, r.new_leads);
}
