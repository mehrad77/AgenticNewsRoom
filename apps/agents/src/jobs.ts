import {
  type AgentRunJob,
  type AssignJob,
  type IngestSourceJob,
  QUEUES,
  type QueueName,
} from "@anr/core";
import type { PgBoss } from "pg-boss";

/** The queues this worker owns (@anr/core QUEUES). */
export const AGENTS_QUEUES: readonly QueueName[] = [
  QUEUES.ingestSource,
  QUEUES.assign,
  QUEUES.agentRun,
];

/**
 * A handler per queue. A queue without one is not worked at all, so its jobs wait in Postgres
 * for a worker that can run them (assign arrives with milestone 3).
 */
export interface JobHandlers {
  "ingest-source"?: (job: IngestSourceJob) => Promise<void>;
  assign?: (job: AssignJob) => Promise<void>;
  "agent-run"?: (job: AgentRunJob) => Promise<void>;
}

type Job = IngestSourceJob | AssignJob | AgentRunJob;

export async function registerJobs(
  boss: Pick<PgBoss, "work">,
  handlers: JobHandlers = {},
): Promise<void> {
  for (const queue of AGENTS_QUEUES) {
    const handler = handlers[queue as keyof JobHandlers] as
      | ((job: Job) => Promise<void>)
      | undefined;
    if (!handler) {
      console.log(`[agents] ${queue}: no handler; its jobs wait`);
      continue;
    }
    await boss.work<Job>(queue, async (jobs) => {
      // A throw fails the job and pg-boss retries it; a handler returns to complete it.
      for (const job of jobs) await handler(job.data);
    });
  }
}
