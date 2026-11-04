// The claims of one imported news item (D184): the desk's chain reads the item and the stored text
// of the source it names, and answers with the item's claims, each quoting that text. Code keeps
// an answer only if every passage is in the source, as the verifier will check; one retry, then
// the item has no claims and keeps its imported label.
import { type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { textOf } from "../converse.ts";
import { MIN_PASSAGE_CHARS, parseJson, quoteFoundIn, quoteKey } from "../desk/validate.ts";
import type { ChatLike } from "../model.ts";

export const CLAIMS_PROMPT_VERSION = "recheck-claims-1";

/** The source's text the model reads; longer pages are cut, and a quote past the cut cannot match. */
export const SOURCE_CHARS = 16_000;

export const CLAIMS_SYSTEM = `You split one short news item into its factual claims, for a fact-checker.
You get the item (in its own language) and the stored text of the source it is based on.
Answer with JSON only: {"claims": [{"text": "...", "passage": "..."}]}.
- One claim per fact the item states: who did what, names, numbers, dates. Together the claims
  must cover everything the item says; leave nothing out.
- "text": the claim, in the item's language, in the item's own words as far as possible. Every
  name, number and Latin-script word the item uses, its headline included, must appear in some
  claim's text exactly as the item writes it.
- "passage": a passage copied character for character from the source text that supports the
  claim: one or two whole sentences, at least ${MIN_PASSAGE_CHARS} characters. Never translate,
  shorten or paraphrase it.
- "Names" lists the organisations and products the item is about: each must appear in some
  claim's text too.
- When the headline is the source's own title (often in English in a Persian item), add one claim
  that the source carries that title, with the title in quotes in the claim's text, e.g.
  Mistral AI published "Introducing Mistral Large 4"; its passage is the source's sentence or
  heading that holds the title.
- If the source does not support something the item says, do not invent a passage: leave that
  fact out of "claims" and add it to "unsupported": ["..."].`;

export interface ItemInput {
  language: string;
  headline: string;
  body: string;
  /** The names the item carries besides its text (`org`, `related`): the verifier checks them too. */
  names?: string[];
}

export interface SourceText {
  text: string;
  language: string;
}

/**
 * What the item states that no claim's text carries: its numbers and its Latin-script names (in
 * Persian text every Latin word; elsewhere words with a capital letter or a digit). A superset of
 * the verifier's item check, so an answer kept here does not fail it for words left out.
 */
export function uncovered(item: ItemInput, claims: readonly { text: string }[]): string[] {
  const said = quoteKey(claims.map((c) => c.text).join(" "), item.language);
  const all = [item.headline, item.body, ...(item.names ?? [])].join(" ");
  const text = quoteKey(all, item.language);
  const raw = all.normalize("NFKC");
  const numbers = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const words = (raw.match(/[A-Za-z][A-Za-z0-9.+-]*[A-Za-z0-9]|[A-Za-z]{2,}/g) ?? []).filter(
    (w) => w.length > 1 && (item.language === "fa" || /[A-Z0-9]/.test(w)),
  );
  return [...new Set([...numbers, ...words])].filter((w) => !said.includes(quoteKey(w)));
}

const tokens = (text: string, language: string) =>
  quoteKey(text, language)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

/**
 * A near-miss quote snapped to the source: the sentence, or two adjacent ones, that holds most of
 * the passage's words (at least SNAP_OVERLAP of them), copied from the source as it is. The
 * fact-checker then judges the claim against the source's real words, so snapping can only turn
 * a misquote into a fair question, never make an unsupported claim pass.
 */
export const SNAP_OVERLAP = 0.8;
export function snapPassage(passage: string, source: SourceText): string | null {
  const want = new Set(tokens(passage, source.language));
  if (want.size === 0) return null;
  const sentences = source.text
    .slice(0, SOURCE_CHARS)
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  let best: { text: string; score: number } | null = null;
  for (let i = 0; i < sentences.length; i++)
    for (const text of [sentences[i] ?? "", `${sentences[i]} ${sentences[i + 1] ?? ""}`.trim()]) {
      const have = new Set(tokens(text, source.language));
      const score = [...want].filter((t) => have.has(t)).length / want.size;
      // Prefer the shorter window on a tie: the one sentence that says it.
      if (!best || score > best.score || (score === best.score && text.length < best.text.length))
        best = { text, score };
    }
  return best && best.score >= SNAP_OVERLAP && quoteFoundIn(best.text, source) ? best.text : null;
}

export interface WrittenClaim {
  text: string;
  passage: string;
}

const Answer = z.object({
  claims: z.array(z.object({ text: z.string().min(1), passage: z.string().min(1) })),
  unsupported: z.array(z.string()).default([]),
});

export const claimsQuestion = (item: ItemInput, source: SourceText) =>
  `Item (${item.language}):\n${item.headline}\n${item.body}${item.names?.length ? `\nNames: ${item.names.join(", ")}` : ""}\n\nSource text (${source.language}):\n${source.text.slice(0, SOURCE_CHARS)}`;

/** The answer's claims, or what is wrong with it, in words the model can act on. */
export function parseClaims(
  reply: string,
  source: SourceText,
  item?: ItemInput,
): { claims: WrittenClaim[]; unsupported: string[] } | { errors: string[] } {
  const value = parseJson(reply);
  if (typeof value === "string") return { errors: [value] };
  const a = Answer.safeParse(value);
  if (!a.success)
    return {
      errors: ['answer {"claims": [{"text": "...", "passage": "..."}], "unsupported": []}'],
    };
  const errors: string[] = [];
  const claims = a.data.claims.map((c) =>
    quoteFoundIn(c.passage, source)
      ? c
      : { ...c, passage: snapPassage(c.passage, source) ?? c.passage },
  );
  claims.forEach((c, i) => {
    if (quoteKey(c.passage, source.language).length < MIN_PASSAGE_CHARS)
      errors.push(`claims[${i}].passage is too short to prove anything`);
    else if (!quoteFoundIn(c.passage, source))
      errors.push(
        `claims[${i}].passage is not in the source text; copy it exactly: "${c.passage.slice(0, 80)}"`,
      );
  });
  if (a.data.claims.length === 0 && a.data.unsupported.length === 0)
    errors.push("no claims: list the item's facts");
  const missing = item && errors.length === 0 ? uncovered(item, claims) : [];
  if (missing.length > 0)
    errors.push(
      `these are in the item but in no claim's text; put each in a claim, exactly as written: ${missing.join(", ")}`,
    );
  return errors.length > 0 ? { errors } : { claims, unsupported: a.data.unsupported };
}

/** Tries per item: an answer code cannot keep goes back with what was wrong. */
export const ATTEMPTS = 3;

/** The item's claims from the model, retried with what was wrong while it has tries. */
export async function writeClaims(
  model: ChatLike,
  item: ItemInput,
  source: SourceText,
): Promise<{ claims: WrittenClaim[]; unsupported: string[] } | { error: string }> {
  const messages: BaseMessage[] = [
    new SystemMessage(CLAIMS_SYSTEM),
    new HumanMessage(claimsQuestion(item, source)),
  ];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const reply = await model.invoke(messages);
    const parsed = parseClaims(textOf(reply), source, item);
    if (!("errors" in parsed)) return parsed;
    messages.push(
      reply,
      new HumanMessage(`Fix these and answer again:\n- ${parsed.errors.join("\n- ")}`),
    );
    if (attempt === ATTEMPTS - 1) return { error: parsed.errors.join("; ") };
  }
  return { error: "no answer" };
}
