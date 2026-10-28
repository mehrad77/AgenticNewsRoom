import type { AssignJob, IngestSourceJob, PlanJob } from "@anr/core";
import { QUEUES, type QueueName } from "@anr/core";

/** One pg-boss schedule that config sync keeps in place. `key` is the row id it runs for. */
export interface DesiredSchedule {
  queue: QueueName;
  key: string;
  cron: string;
  tz: string;
  data: object;
  /** What to do about runs missed while nothing was running (a deploy, an outage). */
  missed: "skip" | "once";
}

/** Queues whose schedules come only from config; sync removes any schedule it did not ask for. */
export const SCHEDULED_QUEUES: readonly QueueName[] = [
  QUEUES.ingestSource,
  QUEUES.assign,
  QUEUES.plan,
  QUEUES.publishSweep,
  QUEUES.channelStats,
];

/**
 * Cron for a source's fetch interval (`30m`, `6h`, `1d`). Cron counts within the hour or day,
 * so an interval must divide it evenly: `*\/45` would fire at :00 and :45.
 */
export function cronEvery(every: string): string {
  const match = /^([0-9]+)([mhd])$/.exec(every);
  const n = Number(match?.[1]);
  const unit = match?.[2];
  if (unit === "m" && n > 0 && n < 60 && 60 % n === 0) return `*/${n} * * * *`;
  if (unit === "h" && n > 0 && n <= 24 && 24 % n === 0)
    return n === 24 ? "0 0 * * *" : `0 */${n} * * *`;
  if (unit === "d" && n === 1) return "0 0 * * *";
  throw new Error(`interval ${every} must divide an hour (m) or a day (h), or be 1d`);
}

/** Cron for a daily time of day (`16:00`). */
export function cronDaily(time: string): string {
  const match = /^([0-9]{2}):([0-9]{2})$/.exec(time);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new Error(`time ${time} must be 00:00 to 23:59`);
  return `${minutes} ${hours} * * *`;
}

const CRON_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

/** Cron for a weekday and time (`fri 08:00`). */
export function cronWeekly(at: string): string {
  const match = /^(mon|tue|wed|thu|fri|sat|sun) (.+)$/.exec(at);
  if (!match) throw new Error(`${at} must be a weekday and a time, like "fri 08:00"`);
  const [minutes, hours] = cronDaily(match[2] ?? "").split(" ");
  return `${minutes} ${hours} * * ${CRON_DAYS[match[1] as keyof typeof CRON_DAYS]}`;
}

/** The planning tick's time of day in each newsroom's timezone (D103). */
export const PLAN_AT = "06:00";

export interface ScheduledSource {
  id: string;
  every: string;
  use?: string;
  terms_checked?: string;
}
export interface ScheduledSeries {
  id: string;
  cadence: { daily?: string; weekly?: string };
  assignment_at?: string;
}

/** The schedules one newsroom's config asks for, in the newsroom's timezone. */
export function newsroomSchedules(
  newsroomId: string,
  timezone: string,
  sources: ScheduledSource[],
  series: ScheduledSeries[],
): DesiredSchedule[] {
  const out: DesiredSchedule[] = [];
  for (const s of sources) {
    // D17: never fetched until a person has read the source's terms. Enrichment sources are
    // queried on demand, not fetched into the lead pool.
    if (!s.terms_checked || (s.use ?? "leads") !== "leads") continue;
    const data: IngestSourceJob = { newsroomId, sourceId: s.id };
    out.push({
      queue: QUEUES.ingestSource,
      key: s.id,
      cron: cronEvery(s.every),
      tz: timezone,
      data,
      missed: "skip",
    });
  }
  for (const s of series) {
    // Daily news and weekly episodes are assigned by schedule; a picked series from its pick.
    if (!s.assignment_at) continue;
    const data: AssignJob = { newsroomId, seriesId: s.id };
    out.push({
      queue: QUEUES.assign,
      key: s.id,
      cron: s.cadence.daily ? cronDaily(s.assignment_at) : cronWeekly(s.assignment_at),
      tz: timezone,
      data,
      missed: "once",
    });
  }
  // Once a day, the planner's themes and weekly candidates are started when they are due.
  const plan: PlanJob = { newsroomId };
  out.push({
    queue: QUEUES.plan,
    key: newsroomId,
    cron: cronDaily(PLAN_AT),
    tz: timezone,
    data: plan,
    missed: "once",
  });
  return out;
}

/** Schedules that belong to no newsroom. */
export function platformSchedules(): DesiredSchedule[] {
  return [
    {
      queue: QUEUES.publishSweep,
      key: "platform",
      cron: "* * * * *",
      tz: "UTC",
      data: {},
      missed: "skip",
    },
    // A snapshot per channel and day; a day the laptop slept through is taken when it wakes.
    {
      queue: QUEUES.channelStats,
      key: "platform",
      cron: "0 0 * * *",
      tz: "UTC",
      data: {},
      missed: "once",
    },
  ];
}
