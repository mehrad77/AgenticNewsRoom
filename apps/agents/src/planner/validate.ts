// What the planner may submit (D103): 2–3 themes whose calendar covers exactly the cycle's weeks,
// or exactly three candidates for a weekly pick, each resting on stored leads. Shape is checked
// here; that the leads exist, are not withdrawn and are in no banned beat is checked in Postgres.
import { addDays, type CycleSpan, onOrBefore } from "@anr/core";
import { z } from "zod";

export const MIN_THEMES = 2;
export const MAX_THEMES = 3;
export const CANDIDATES = 3;

const leadIds = (max: number) => z.array(z.uuid()).min(1).max(max);

const Theme = z.object({
  theme: z.string().trim().min(1).max(140),
  angle: z.string().trim().min(1).max(800),
  rationale: z.string().trim().min(1).max(800),
  calendar: z.array(z.object({ week: z.string(), focus: z.string().trim().min(1).max(240) })),
  lead_ids: leadIds(12),
});
export type ThemeProposal = z.infer<typeof Theme>;

const Candidate = z.object({
  title: z.string().trim().min(1).max(200),
  angle: z.string().trim().min(1).max(800),
  why: z.string().trim().min(1).max(400),
  lead_ids: leadIds(8),
});
export type Candidate = z.infer<typeof Candidate>;

/** The Mondays of the weeks a cycle touches: the calendar's keys, and what a pick week looks up. */
export function cycleWeeks(span: CycleSpan): string[] {
  const weeks: string[] = [];
  for (let w = onOrBefore(span.starts, "mon"); w < span.ends; w = addDays(w, 7)) weeks.push(w);
  return weeks;
}

const issues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`);

export function validateThemes(
  value: unknown,
  weeks: readonly string[],
): ThemeProposal[] | string[] {
  const parsed = z
    .object({ themes: z.array(Theme).min(MIN_THEMES).max(MAX_THEMES) })
    .safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const errors: string[] = [];
  for (const [i, t] of parsed.data.themes.entries()) {
    const given = t.calendar.map((c) => c.week);
    if (given.length !== weeks.length || weeks.some((w, j) => given[j] !== w))
      errors.push(`themes.${i}.calendar: give exactly these weeks, in order: ${weeks.join(", ")}`);
  }
  return errors.length > 0 ? errors : parsed.data.themes;
}

export function validateCandidates(value: unknown): Candidate[] | string[] {
  const parsed = z.object({ candidates: z.array(Candidate).length(CANDIDATES) }).safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const titles = parsed.data.candidates.map((c) => c.title.toLowerCase());
  if (new Set(titles).size !== titles.length) return ["candidates: the three must differ"];
  return parsed.data.candidates;
}
