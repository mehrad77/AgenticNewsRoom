/**
 * Calendar arithmetic for editorial cycles and weekly picks (D39). Days are `YYYY-MM-DD` strings in
 * the newsroom's timezone; instants are Dates. Cycles run back to back from `planning.from`, each
 * `cycle` long (`10d`, `2w`, `1mo`), so nothing assumes a month.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Planning {
  cycle: string;
  from: string;
}

/** An editorial cycle: `ends` is the day after its last day. */
export interface CycleSpan {
  starts: string;
  ends: string;
}

/** The planner proposes a cycle's themes this many days before it starts (D103). */
export const THEME_LEAD_DAYS = 7;

const DAY_MS = 86_400_000;
const toUtc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY_MS);
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function weekdayOf(day: string): Weekday {
  // getUTCDay: 0 is Sunday.
  return WEEKDAYS[(new Date(toUtc(day)).getUTCDay() + 6) % 7] as Weekday;
}

function parseCycle(cycle: string): { n: number; unit: "d" | "w" | "mo" } {
  const match = /^([1-9][0-9]*)(d|w|mo)$/.exec(cycle);
  if (!match) throw new Error(`cycle ${cycle} must be like 10d, 2w or 1mo`);
  return { n: Number(match[1]), unit: match[2] as "d" | "w" | "mo" };
}

/** The start of cycle `k` (0 is the first). A month cycle from the 31st ends on a month's last day. */
export function cycleStart(planning: Planning, k: number): string {
  const { n, unit } = parseCycle(planning.cycle);
  if (unit === "d") return addDays(planning.from, k * n);
  if (unit === "w") return addDays(planning.from, k * n * 7);
  const [y, m, d] = planning.from.split("-").map(Number) as [number, number, number];
  const months = m - 1 + k * n;
  const year = y + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(year, month, Math.min(d, last)));
}

/** The cycle that contains `day`, or null before the first one. */
export function cycleContaining(planning: Planning, day: string): CycleSpan | null {
  if (day < planning.from) return null;
  const { n, unit } = parseCycle(planning.cycle);
  const length = unit === "d" ? n : unit === "w" ? n * 7 : n * 31;
  // An estimate from below, then step forward: month lengths vary.
  let k = Math.max(0, Math.floor(daysBetween(planning.from, day) / length) - 1);
  while (cycleStart(planning, k + 1) <= day) k++;
  return { starts: cycleStart(planning, k), ends: cycleStart(planning, k + 1) };
}

/** The first cycle that starts after `day` (or on it, before the first cycle). */
export function nextCycle(planning: Planning, day: string): CycleSpan {
  const current = cycleContaining(planning, day);
  const starts = current ? current.ends : planning.from;
  const after = cycleContaining(planning, starts);
  if (!after) throw new Error(`no cycle at ${starts}`);
  return after;
}

/** The cycle whose themes the planner should be proposing on `day`, if any. */
export function cycleToPlan(planning: Planning, day: string): CycleSpan | null {
  const current = cycleContaining(planning, day);
  const next = nextCycle(planning, day);
  if (daysBetween(day, next.starts) <= THEME_LEAD_DAYS) return next;
  return current;
}

/** The local calendar day of an instant in `timeZone`. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Offset of `timeZone` from UTC at `at`, in minutes. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((wall - at.getTime()) / 60_000);
}

/**
 * The instant of a local wall-clock time (`HH:MM`) on `day` in `timeZone`. A time a clock change
 * skips (02:30 in New York on its spring-forward day) resolves an hour early.
 */
export function localInstant(day: string, time: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T${time}:00Z`);
  let at = new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60_000);
  // Once more, in case the guess crossed a daylight-saving change.
  at = new Date(guess - offsetMinutes(at, timeZone) * 60_000);
  return at;
}

/** `wed 10:00` → its weekday and time. */
export function parseWeekly(weekly: string): { day: Weekday; time: string } {
  const [day, time] = weekly.split(" ") as [Weekday, string];
  if (!WEEKDAYS.includes(day) || !/^[0-2][0-9]:[0-5][0-9]$/.test(time ?? ""))
    throw new Error(`weekly time ${weekly} must be like "wed 10:00"`);
  return { day, time };
}

/** The first day on or after `day` that falls on `weekday`. */
export function onOrAfter(day: string, weekday: Weekday): string {
  const shift = (WEEKDAYS.indexOf(weekday) - WEEKDAYS.indexOf(weekdayOf(day)) + 7) % 7;
  return addDays(day, shift);
}

/** The last day on or before `day` that falls on `weekday`. */
export function onOrBefore(day: string, weekday: Weekday): string {
  const shift = (WEEKDAYS.indexOf(weekdayOf(day)) - WEEKDAYS.indexOf(weekday) + 7) % 7;
  return addDays(day, -shift);
}

/** The first occurrence of a weekly time at or after `at`. */
export function nextWeekly(weekly: string, at: Date, timeZone: string): Date {
  const { day, time } = parseWeekly(weekly);
  let d = onOrAfter(localDay(at, timeZone), day);
  let slot = localInstant(d, time, timeZone);
  if (slot < at) {
    d = addDays(d, 7);
    slot = localInstant(d, time, timeZone);
  }
  return slot;
}

export interface PickConfig {
  by: Weekday;
  editor_picks_by: Weekday;
}

/** One week's pick: proposed on `week`, chosen before `deadline`, published at `slot`. */
export interface PickWindow {
  /** The day the planner proposes (the series' `pick.by`); with the series, it names the pick. */
  week: string;
  /** The end of the `editor_picks_by` day: after it the slot is skipped. */
  deadline: Date;
  slot: Date;
}

/**
 * The pick window that `day` falls in, if the planner may still propose for it: from the last
 * `pick.by` day up to the end of the `editor_picks_by` day. Its slot is the series' first weekly
 * time after the deadline.
 */
export function pickWindow(
  pick: PickConfig,
  cadence: string,
  day: string,
  timeZone: string,
): PickWindow | null {
  const week = onOrBefore(day, pick.by);
  const lastDay = onOrAfter(week, pick.editor_picks_by);
  if (day > lastDay) return null;
  const deadline = localInstant(addDays(lastDay, 1), "00:00", timeZone);
  return { week, deadline, slot: nextWeekly(cadence, deadline, timeZone) };
}
