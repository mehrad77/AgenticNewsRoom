// The summariser's role prompt, versioned: a change to the text is a new PROMPT_VERSION, and
// every Agent run records the version it ran with.

export const PROMPT_VERSION = "summariser-1";
/** Stored text beyond this is not sent: a summary needs the opening, and the cap bounds cost. */
export const MAX_INPUT_CHARS = 20_000;

export interface SummariserLead {
  headline: string | null;
  language: string;
  body: string;
}

export interface SummariserBeat {
  slug: string;
  /** The beat's IPTC Media Topic labels, so the model knows what each slug covers. */
  topics: string[];
}

const ROLE = `You summarise one stored lead for a newsroom's editors and place it in the newsroom's beats.

Rules:
- Use only the lead's text below. Add nothing from memory; give no opinion.
- The summary is one or two plain sentences, at most 300 characters, in the lead's own language.
- Beats: choose every beat from the list that the lead is mainly about, or none. Use the slugs exactly as listed; never invent one.
- Answer with JSON only, no other text: {"summary": "...", "beats": ["slug", ...]}`;

export function summariserPrompt(lead: SummariserLead, beats: SummariserBeat[]): string {
  const list = beats.map((b) => `- ${b.slug}: ${b.topics.join("; ")}`).join("\n");
  const text =
    lead.body.length > MAX_INPUT_CHARS ? `${lead.body.slice(0, MAX_INPUT_CHARS)}\n[…]` : lead.body;
  return `${ROLE}

Beats:
${list}

Lead (language: ${lead.language}):
Headline: ${lead.headline ?? "(none)"}

${text}`;
}

export function retryPrompt(errors: string[]): string {
  return `Your answer was not valid: ${errors.join("; ")}. Answer again with JSON only, following the rules.`;
}
