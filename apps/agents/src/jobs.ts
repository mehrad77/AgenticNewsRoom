import {
  type AgentRunJob,
  type AssignJob,
  type IngestSourceJob,
  QUEUES,
  type QueueName,
} from "@anr/core";
import type { PgBoss } from "pg-boss";

/** The queues this worker owns (@anr/core QUEUES); handlers arrive with milestones 2, 3 and 5. */
export const AGENTS_QUEUES: readonly QueueName[] = [
  QUEUES.ingestSource,
  QUEUES.assign,
  QUEUES.agentRun,
];

type Job = IngestSourceJob | AssignJob | AgentRunJob;

export async function registerJobs(boss: Pick<PgBoss, "work">): Promise<void> {
  for (const queue of AGENTS_QUEUES) {
    await boss.work<Job>(queue, async (jobs) => {
      for (const job of jobs) console.log(`[agents] ${queue} ${job.id}: no handler yet`, job.data);
    });
  }
}
