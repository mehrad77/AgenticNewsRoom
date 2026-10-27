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
  /** Agents worker: the verifier gate for one story, from code checks to policy (D80). */
  gate: "gate",
  /** Agents worker: a new desk run for an assignment an editor returned to the desk (D96). */
  redraft: "redraft",
  /** Publisher: approved and scheduled publications whose slot has come, every minute. */
  publishSweep: "publish-sweep",
  /** Publisher: once a day, each Telegram channel's subscriber count (audience per language). */
  channelStats: "channel-stats",
  /** Publisher: asks a channel whether it can be posted to, without posting (D101). */
  channelCheck: "channel-check",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** How long the agents worker waits for one source's ingest run (polite fetching is slow). */
export const INGEST_TIMEOUT_SECONDS = 15 * 60;

/**
 * How long one agent run or gate job may take: several model calls of up to 120 s each, with
 * fallbacks. Its job must not expire (and be retried) while it still runs.
 */
export const AGENT_RUN_TIMEOUT_SECONDS = 45 * 60;

/**
 * Queue options that differ from pg-boss's defaults. A job expires only after its own work has
 * timed out, so pg-boss never starts a second attempt while the first runs.
 */
export const QUEUE_OPTIONS: Partial<Record<QueueName, { expireInSeconds: number }>> = {
  [QUEUES.ingestSource]: { expireInSeconds: INGEST_TIMEOUT_SECONDS + 5 * 60 },
  [QUEUES.agentRun]: { expireInSeconds: AGENT_RUN_TIMEOUT_SECONDS },
  [QUEUES.gate]: { expireInSeconds: AGENT_RUN_TIMEOUT_SECONDS },
};

/**
 * Queue policies other than pg-boss's `standard`, fixed when a queue is created. `stately` keeps
 * at most one queued and one active job per singleton key: one gate per story at a time (D80).
 */
export const QUEUE_POLICIES: Partial<Record<QueueName, "stately">> = {
  [QUEUES.gate]: "stately",
};

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
export interface RedraftJob {
  newsroomId: string;
  assignmentId: string;
}
export interface ChannelCheckJob {
  newsroomId: string;
  channelId: string;
}
export interface GateJob {
  newsroomId: string;
  storyId: string;
}
