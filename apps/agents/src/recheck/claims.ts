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
- "text": the claim, in the item's language, in the item's own words as far as possible.
- "passage": a passage copied character for character from the source text that supports the
  claim: one or two whole sentences, at least ${MIN_PASSAGE_CHARS} characters. Never translate,
  shorten or paraphrase it.
- If the source does not support something the item says, do not invent a passage: leave that
  fact out of "claims" and add it to "unsupported": ["..."].`;

export interface ItemInput {
  language: string;
  headline: string;
  body: string;
}

export interface SourceText {
  text: string;
  language: string;
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
  `Item (${item.language}):\n${item.headline}\n${item.body}\n\nSource text (${source.language}):\n${source.text.slice(0, SOURCE_CHARS)}`;

/** The answer's claims, or what is wrong with it, in words the model can act on. */
export function parseClaims(
  reply: string,
  source: SourceText,
): { claims: WrittenClaim[]; unsupported: string[] } | { errors: string[] } {
  const value = parseJson(reply);
  if (typeof value === "string") return { errors: [value] };
  const a = Answer.safeParse(value);
  if (!a.success)
    return {
      errors: ['answer {"claims": [{"text": "...", "passage": "..."}], "unsupported": []}'],
    };
  const errors: string[] = [];
  a.data.claims.forEach((c, i) => {
    if (quoteKey(c.passage, source.language).length < MIN_PASSAGE_CHARS)
      errors.push(`claims[${i}].passage is too short to prove anything`);
    else if (!quoteFoundIn(c.passage, source))
      errors.push(`claims[${i}].passage is not in the source text; copy it exactly`);
  });
  if (a.data.claims.length === 0 && a.data.unsupported.length === 0)
    errors.push("no claims: list the item's facts");
  return errors.length > 0
    ? { errors }
    : { claims: a.data.claims, unsupported: a.data.unsupported };
}

/** The item's claims from the model, with one retry on an answer code cannot keep. */
export async function writeClaims(
  model: ChatLike,
  item: ItemInput,
  source: SourceText,
): Promise<{ claims: WrittenClaim[]; unsupported: string[] } | { error: string }> {
  const messages: BaseMessage[] = [
    new SystemMessage(CLAIMS_SYSTEM),
    new HumanMessage(claimsQuestion(item, source)),
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await model.invoke(messages);
    const parsed = parseClaims(textOf(reply), source);
    if (!("errors" in parsed)) return parsed;
    messages.push(
      reply,
      new HumanMessage(`Fix these and answer again:\n- ${parsed.errors.join("\n- ")}`),
    );
    if (attempt === 1) return { error: parsed.errors.join("; ") };
  }
  return { error: "no answer" };
}
