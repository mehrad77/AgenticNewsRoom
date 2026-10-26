import { QUEUES, type QueueName } from "@anr/core";
import type { PgBoss } from "pg-boss";

/** The queues this worker owns (@anr/core QUEUES); the sweep is built in milestone 4. */
export const PUBLISHER_QUEUES: readonly QueueName[] = [QUEUES.publishSweep];

export async function registerJobs(boss: Pick<PgBoss, "work">): Promise<void> {
  await boss.work(QUEUES.publishSweep, async () => {
    // Every minute: approved and scheduled publications whose slot has come (milestone 4).
  });
}
