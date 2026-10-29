import { INGEST_TIMEOUT_SECONDS, type IngestMediaJob, type IngestSourceJob } from "@anr/core";
import {
  IngestResultSchema,
  MediaRequestResultSchema,
  SourceRequestResultSchema,
} from "@anr/schemas";

/** A run of one source can fetch dozens of pages at a polite pace; give it time. */
const INGEST_TIMEOUT_MS = INGEST_TIMEOUT_SECONDS * 1000;

export type IngestResult = IngestResultSchema;
export type IngestOutcome =
  | { kind: "done"; result: IngestResult }
  /** 404 or 422: unknown ids, or a source that must not be fetched. A person must act; no retry. */
  | { kind: "refused"; status: number; detail: string };

export type SourceRequestOutcome =
  | { kind: "lead"; result: SourceRequestResultSchema }
  /** 404 unknown run, 422 never fetched (private address, robots, unchecked terms), 429 the run's cap. */
  | { kind: "refused"; status: number; detail: string }
  /** 502 or a network failure: the page could not be fetched now. */
  | { kind: "failed"; detail: string };

export type MediaRequestOutcome =
  | { kind: "media"; result: MediaRequestResultSchema }
  /** 404 unknown newsroom or lead, 422 never fetched or not an image, 502 or a network failure. */
  | { kind: "refused" | "failed"; detail: string };

export interface IngestionClient {
  ingest(job: IngestSourceJob): Promise<IngestOutcome>;
  /** An agent run asks for one page to be fetched and stored (D61); never throws. */
  requestSource(newsroomId: string, agentRunId: string, url: string): Promise<SourceRequestOutcome>;
  /** A member's image, fetched and read into a media row (D119); never throws. */
  addMedia(job: IngestMediaJob): Promise<MediaRequestOutcome>;
}

/** A source request fetches one page at once; it must not hold a run for long. */
const REQUEST_TIMEOUT_MS = 60_000;

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
    async requestSource(newsroomId, agentRunId, url) {
      try {
        const response = await fetchImpl(new URL("/request-source", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newsroom_id: newsroomId, agent_run_id: agentRunId, url }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if ([404, 422, 429].includes(response.status)) {
          const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
          return { kind: "refused", status: response.status, detail: String(body.detail ?? "") };
        }
        if (!response.ok)
          return { kind: "failed", detail: `ingestion answered ${response.status}` };
        return { kind: "lead", result: SourceRequestResultSchema.parse(await response.json()) };
      } catch (error) {
        return { kind: "failed", detail: (error as Error).message };
      }
    },
    async addMedia(job) {
      try {
        const response = await fetchImpl(new URL("/media", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            newsroom_id: job.newsroomId,
            url: job.url,
            source_url: job.sourceUrl,
            lead_id: job.leadId,
            added_by: job.addedBy,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 404 || response.status === 422) {
          const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
          return { kind: "refused", detail: String(body.detail ?? "") };
        }
        if (!response.ok)
          return { kind: "failed", detail: `ingestion answered ${response.status}` };
        return { kind: "media", result: MediaRequestResultSchema.parse(await response.json()) };
      } catch (error) {
        return { kind: "failed", detail: (error as Error).message };
      }
    },
  };
}

export interface IngestDeps {
  ingestion: Pick<IngestionClient, "ingest">;
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
