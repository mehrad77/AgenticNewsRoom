import { QUEUES, type QueueName } from "@anr/core";
import type { PgBoss } from "pg-boss";

/** The queues this worker owns (@anr/core QUEUES). */
export const PUBLISHER_QUEUES: readonly QueueName[] = [QUEUES.publishSweep, QUEUES.channelStats];

export interface PublisherHandlers {
  /** Every minute: approved and scheduled publications whose slot has come. */
  sweep: () => Promise<void>;
  /** Once a day: each Telegram channel's subscriber count. */
  stats: () => Promise<void>;
}

export async function registerJobs(
  boss: Pick<PgBoss, "work">,
  handlers: PublisherHandlers = { sweep: async () => {}, stats: async () => {} },
): Promise<void> {
  await boss.work(QUEUES.publishSweep, async () => {
    await handlers.sweep();
  });
  await boss.work(QUEUES.channelStats, async () => {
    await handlers.stats();
  });
}
