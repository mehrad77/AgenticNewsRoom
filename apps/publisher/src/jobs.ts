import { type ChannelCheckJob, type PodcastAudioJob, QUEUES, type QueueName } from "@anr/core";
import type { PgBoss } from "pg-boss";

/** The queues this worker owns (@anr/core QUEUES). */
export const PUBLISHER_QUEUES: readonly QueueName[] = [
  QUEUES.publishSweep,
  QUEUES.channelStats,
  QUEUES.channelCheck,
  QUEUES.podcastAudio,
];

export interface PublisherHandlers {
  /** Every minute: approved and scheduled publications whose slot has come. */
  sweep: () => Promise<void>;
  /** Once a day: each Telegram channel's subscriber count. */
  stats: () => Promise<void>;
  /** When the desk asks: whether one channel can be posted to. */
  check: (job: ChannelCheckJob) => Promise<void>;
  /** An approved episode's audio, before its slot (D109). */
  audio?: (job: PodcastAudioJob) => Promise<void>;
}

export async function registerJobs(
  boss: Pick<PgBoss, "work">,
  handlers: PublisherHandlers = {
    sweep: async () => {},
    stats: async () => {},
    check: async () => {},
  },
): Promise<void> {
  await boss.work(QUEUES.publishSweep, async () => {
    await handlers.sweep();
  });
  await boss.work(QUEUES.channelStats, async () => {
    await handlers.stats();
  });
  await boss.work<ChannelCheckJob>(QUEUES.channelCheck, async ([job]) => {
    if (job) await handlers.check(job.data);
  });
  const audio = handlers.audio;
  if (audio) {
    await boss.work<PodcastAudioJob>(QUEUES.podcastAudio, async ([job]) => {
      if (job) await audio(job.data);
    });
  }
}
