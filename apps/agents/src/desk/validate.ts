// Submit validation (D77): the format's JSON Schema (generated zod), then the cross-references a
// schema cannot express. Errors go back to the model once; a second invalid answer holds the
// assignment. The verifier repeats the checks that matter for publishing; this only gives the
// writer a chance to fix them first.
import { DRAFT_SCHEMAS } from "@anr/schemas";

export { DRAFT_SCHEMAS };

export interface DraftClaim {
  id: string;
  kind: "fact" | "quote" | "opinion";
  text: string;
  lead_id: string;
  quoted_passage: string;
  also?: { lead_id: string; quoted_passage: string }[];
}

export interface Draft {
  story?: { summary: string; beat: string; claims: DraftClaim[] };
  rendition: { language: string; title: string; items: DraftItem[] };
}

export interface DraftItem {
  kind?: string;
  claim_ids: string[];
  lead_id?: string;
  [key: string]: unknown;
}

/** A lead a claim may cite, with the text the writer was shown. */
export interface CitableLead {
  text: string;
  language: string;
  withdrawn: boolean;
}

export interface ValidationContext {
  format: string;
  language: string;
  /** A desk submit carries a story; a renderer submit only a rendition. */
  needsStory: boolean;
  /** Beats a story may name: live and not banned. */
  beats: readonly string[];
  /** Leads the run may cite (the assignment's and those it read), by id. */
  leads: ReadonlyMap<string, CitableLead>;
  /** For a renderer: the story's claim ids and the first rendition's items. */
  storyClaimIds?: readonly string[];
  firstItems?: readonly DraftItem[];
}

/**
 * The first JSON object in a model's answer (models wrap JSON in prose or code fences). With
 * `closeBrackets` (drafts only, D86), brackets left open at the very end are closed: small models
 * drop the last brace of a long object, and a retry at temperature 0 repeats the slip; the draft is
 * still validated and checked. A checker's verdict is never repaired: one that does not parse holds.
 */
export function parseJson(text: string, { closeBrackets = false } = {}): unknown | string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "the answer has no JSON object";
  const json = text.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch (error) {
    const closed = closeBrackets ? closeOpenBrackets(json) : undefined;
    if (closed !== undefined) {
      try {
        return JSON.parse(closed);
      } catch {}
    }
    return `the JSON does not parse: ${(error as Error).message}`;
  }
}

/** The text with its unclosed objects and arrays closed, or undefined if it ends mid-string or mismatched. */
function closeOpenBrackets(json: string): string | undefined {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") open.push("}");
    else if (ch === "[") open.push("]");
    else if (ch === "}" || ch === "]") {
      if (open.pop() !== ch) return undefined;
    }
  }
  if (inString || open.length === 0) return undefined;
  return json + open.reverse().join("");
}

/**
 * Moves a rendition written inside the story to the top level, where it belongs. Models of two
 * families wrote it there on every try; the move changes no content, and every check still runs.
 */
function liftRendition(value: unknown): unknown {
  if (typeof value !== "object" || value === null || "rendition" in value) return value;
  const { story } = value as { story?: unknown };
  if (typeof story !== "object" || story === null || !("rendition" in story)) return value;
  const { rendition, ...rest } = story as { rendition: unknown };
  return { ...value, story: rest, rendition };
}

/** A minimum a passage must have to prove anything: not a word picked out of the text. */
export const MIN_PASSAGE_CHARS = 20;

export function validateDraft(value: unknown, ctx: ValidationContext): Draft | string[] {
  const schema = DRAFT_SCHEMAS[ctx.format];
  if (!schema) return [`unknown format ${ctx.format}`];
  const lifted = liftRendition(value);
  const parsed = schema.safeParse(lifted);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => {
      const at = i.path.join(".") || "draft";
      // An item matches one schema per kind; without a kind the union's own message names none.
      const item = i.path.reduce<unknown>(
        (v, k) => (v as Record<PropertyKey, unknown>)?.[k],
        lifted,
      );
      if (
        at.startsWith("rendition.items.") &&
        i.path.length === 3 &&
        !(item as { kind?: unknown })?.kind
      )
        return `${at}: "kind" is missing`;
      return `${at}: ${i.message}`;
    });
  }
  const draft = parsed.data as Draft;
  const errors: string[] = [];
  if (draft.rendition.language !== ctx.language) {
    errors.push(`rendition.language must be "${ctx.language}"`);
  }

  let claimIds: readonly string[];
  if (ctx.needsStory) {
    if (!draft.story) return ["story: required (summary, beat and claims)"];
    const { story } = draft;
    if (!ctx.beats.includes(story.beat)) {
      errors.push(`story.beat "${story.beat}" is not one of ${ctx.beats.join(", ")}`);
    }
    const seen = new Set<string>();
    for (const c of story.claims) {
      if (seen.has(c.id)) errors.push(`claim ${c.id}: duplicate id`);
      seen.add(c.id);
      for (const [i, source] of [c, ...(c.also ?? [])].entries()) {
        const where = i === 0 ? `claim ${c.id}` : `claim ${c.id} also[${i - 1}]`;
        const lead = ctx.leads.get(source.lead_id);
        if (!lead) {
          errors.push(`${where}: lead ${source.lead_id} was not given or read in this run`);
        } else if (lead.withdrawn) {
          errors.push(`${where}: lead ${source.lead_id} is withdrawn; do not cite it`);
        } else if (quoteKey(source.quoted_passage, lead.language).length < MIN_PASSAGE_CHARS) {
          errors.push(`${where}: quoted_passage is too short to prove anything`);
        } else if (!quoteFoundIn(source.quoted_passage, lead)) {
          errors.push(
            `${where}: quoted_passage is not in lead ${source.lead_id}'s text; copy it exactly`,
          );
        }
      }
    }
    claimIds = [...seen];
  } else {
    if (draft.story) errors.push("story: a rendition of an existing story carries no story");
    claimIds = ctx.storyClaimIds ?? [];
    if (ctx.firstItems) errors.push(...sameItems(draft.rendition.items, ctx.firstItems));
  }

  for (const [i, item] of draft.rendition.items.entries()) {
    if (item.claim_ids.length === 0) errors.push(`rendition.items.${i}: lists no claims`);
    for (const id of item.claim_ids) {
      if (!claimIds.includes(id)) errors.push(`rendition.items.${i}: unknown claim ${id}`);
    }
    if (item.lead_id !== undefined && ctx.needsStory && !ctx.leads.has(item.lead_id)) {
      errors.push(`rendition.items.${i}: lead ${item.lead_id} was not given or read in this run`);
    }
  }
  return errors.length > 0 ? errors : draft;
}

/** A rendition in another language keeps the first one's items: same order, kinds, claims, leads. */
function sameItems(items: readonly DraftItem[], first: readonly DraftItem[]): string[] {
  if (items.length !== first.length) {
    return [`rendition.items: ${items.length} items; the first rendition has ${first.length}`];
  }
  const errors: string[] = [];
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  for (const [i, item] of items.entries()) {
    const original = first[i];
    if (!original) continue;
    if (item.kind !== original.kind) {
      errors.push(`rendition.items.${i}: kind must be "${original.kind}"`);
    }
    if (item.lead_id !== original.lead_id) {
      errors.push(`rendition.items.${i}: lead_id must be ${original.lead_id ?? "absent"}`);
    }
    if (!same(item.claim_ids, original.claim_ids)) {
      errors.push(`rendition.items.${i}: claim_ids must be ${original.claim_ids.join(", ")}`);
    }
  }
  return errors;
}

/** Normalised text for quote matching, without the database: the twin of the verifier's (D79). */
export function quoteKey(text: string, language?: string): string {
  let mapped = text
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/‌/g, "")
    .replace(/[\u2010\u2011\u2212]/g, "-")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (language === "tr") mapped = mapped.replace(/I/g, "ı").replace(/İ/g, "i");
  return mapped.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether a passage occurs in a lead's text after normalisation: the verifier's match (D79). */
export const quoteFoundIn = (passage: string, lead: { text: string; language: string }): boolean =>
  quoteKey(lead.text, lead.language).includes(quoteKey(passage, lead.language));
