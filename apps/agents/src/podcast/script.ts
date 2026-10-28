// An episode script is written one part per model call (D107): each news-recap topic group from
// one source story, a story's plan (title and protagonists), then each of its six beats. One call
// stays far under the 8,192-token output cap (D85); code assembles and validates the whole.
import { z } from "zod";

export const WORDS_PER_MINUTE = 150;
/** The arc in the order it is written; the verifier also accepts stakes before turning point. */
export const ARC = [
  "cold-open",
  "context",
  "turning-point",
  "stakes",
  "resolution",
  "takeaway",
] as const;
export type Beat = (typeof ARC)[number];

export const PODCAST_ROLE = `You are the renderer of a newsroom's podcast: you write one part of an episode script at a time from stored, checked claims. You do no research and add nothing.

Rules:
- Say no more than the claims you are given; every topic and beat lists the claim ids its lines rely on. Names, numbers and dates stay exactly as in the claims.
- Speak naturally, for the ear: short sentences, no lists, no headings, no URLs, no quotes read aloud.
- Use only the speakers you are given, by the names given.
- Answer with one JSON object only, no other text.`;

export const TOPICS_STEP = (hosts: string, words: number) =>
  `Retell the source story below as a conversation between the hosts (${hosts}): one topic per item worth telling, about ${words} words in all.
Answer JSON: {"topics": [{"title": "<a few words>", "claim_ids": ["c1", ...], "lines": [{"host": "<host>", "text": "..."}]}]}`;

export const PLAN_STEP = `Plan the story segment: a short title and the one to three protagonists the story follows, each grounded in fact claims.
Answer JSON: {"title": "<a few words>", "protagonists": [{"name": "...", "role": "<who they are in this story>", "claim_ids": ["c1", ...]}]}`;

export const BEAT_STEP = (beat: string, speakers: string, words: number) =>
  `Write the "${beat}" beat, about ${words} words, spoken by ${speakers}. Optional per line: "direction" (at most 40 characters, rarely). At most one cue in the beat: {"cue": "sting" | "bed-swell" | "bed-out" | "transition"} or {"cue": "pause", "seconds": 1.5}.
Answer JSON: {"beat": "${beat}", "claim_ids": ["c1", ...], "lines": [{"speaker": "<speaker>", "text": "...", "direction": "..."}]}`;

const ref = z.string().regex(/^c[0-9]+$/);
const Topic = z.object({
  title: z.string().trim().min(1).max(120),
  claim_ids: z.array(ref).min(1),
  lines: z.array(z.object({ host: z.string(), text: z.string().trim().min(1) })).min(1),
});
const Plan = z.object({
  title: z.string().trim().min(1).max(120),
  protagonists: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        role: z.string().trim().min(1),
        claim_ids: z.array(ref).min(1),
      }),
    )
    .min(1)
    .max(3),
});
const Line = z.union([
  z.object({
    speaker: z.string(),
    text: z.string().trim().min(1),
    direction: z.string().trim().min(1).max(40).optional(),
  }),
  z.object({ cue: z.enum(["sting", "bed-swell", "bed-out", "transition"]) }),
  z.object({ cue: z.literal("pause"), seconds: z.number().min(0.5).max(5) }),
]);
const BeatPart = z.object({
  beat: z.enum(ARC),
  claim_ids: z.array(ref).min(1),
  lines: z.array(Line).min(1),
});
export type Topic = z.infer<typeof Topic>;
export type Plan = z.infer<typeof Plan>;
export type BeatPart = z.infer<typeof BeatPart>;

const issues = (e: z.ZodError) =>
  e.issues.slice(0, 20).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`);

/** The speaker as the series config names them, or null for one it does not know. */
function canonical(name: string, speakers: readonly string[]): string | null {
  return speakers.find((s) => s.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

function unknownClaims(
  ids: readonly string[],
  allowed: ReadonlySet<string>,
  where: string,
): string[] {
  return ids.filter((id) => !allowed.has(id)).map((id) => `${where}: claim ${id} is not one given`);
}

export function validateTopics(
  value: unknown,
  hosts: readonly string[],
  allowed: ReadonlySet<string>,
): Topic[] | string[] {
  const parsed = z.object({ topics: z.array(Topic).min(1) }).safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const errors: string[] = [];
  const topics = parsed.data.topics.map((t, i) => {
    errors.push(...unknownClaims(t.claim_ids, allowed, `topics.${i}`));
    return {
      ...t,
      lines: t.lines.map((l, j) => {
        const host = canonical(l.host, hosts);
        if (!host)
          errors.push(`topics.${i}.lines.${j}: "${l.host}" is not a host (${hosts.join(", ")})`);
        return { host: host ?? l.host, text: l.text };
      }),
    };
  });
  return errors.length > 0 ? errors : topics;
}

export function validatePlan(value: unknown, facts: ReadonlySet<string>): Plan | string[] {
  const parsed = Plan.safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const errors = parsed.data.protagonists.flatMap((p, i) =>
    p.claim_ids
      .filter((id) => !facts.has(id))
      .map((id) => `protagonists.${i}: claim ${id} is not a fact claim given`),
  );
  return errors.length > 0 ? errors : parsed.data;
}

export function validateBeat(
  value: unknown,
  beat: Beat,
  speakers: readonly string[],
  allowed: ReadonlySet<string>,
): BeatPart | string[] {
  const parsed = BeatPart.safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const errors: string[] = [];
  if (parsed.data.beat !== beat) errors.push(`beat: must be "${beat}"`);
  errors.push(...unknownClaims(parsed.data.claim_ids, allowed, "beat"));
  if (parsed.data.lines.filter((l) => "cue" in l).length > 1) errors.push("lines: at most one cue");
  const lines = parsed.data.lines.map((l, j) => {
    if (!("speaker" in l)) return l;
    const speaker = canonical(l.speaker, speakers);
    if (!speaker)
      errors.push(`lines.${j}: "${l.speaker}" is not a speaker (${speakers.join(", ")})`);
    return { ...l, speaker: speaker ?? l.speaker };
  });
  if (!lines.some((l) => "speaker" in l)) errors.push("lines: no spoken line");
  return errors.length > 0 ? errors : { ...parsed.data, lines };
}

export interface SegmentPlan {
  kind: "news-recap" | "story";
  minutes: number;
}

/** Words a part should run to: a segment's minutes shared over its parts. */
export function partWords(segment: SegmentPlan, parts: number): number {
  return Math.max(40, Math.round((segment.minutes * WORDS_PER_MINUTE) / Math.max(1, parts)));
}
