/**
 * pg-boss queues and the worker that owns each. Jobs carry ids only; a handler reads the rest
 * from Postgres inside withNewsroom(). Schedules are reconciled from config at deploy.
 */
export const QUEUES = {
  /** Agents worker: one source's fetch through the ingestion service, then summaries. */
  ingestSource: "ingest-source",
  /** Agents worker: a series' assignment for its next slot (daily news at assignment_at). */
  assign: "assign",
  /** Agents worker: one agent run, one graph, one submit. */
  agentRun: "agent-run",
  /** Publisher: approved and scheduled publications whose slot has come, every minute. */
  publishSweep: "publish-sweep",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface IngestSourceJob {
  newsroomId: string;
  sourceId: string;
}
export interface AssignJob {
  newsroomId: string;
  seriesId: string;
}
export interface AgentRunJob {
  newsroomId: string;
  agentRunId: string;
}
