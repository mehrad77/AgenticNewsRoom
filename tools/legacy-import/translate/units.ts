// Persian texts from the old archive into English (D169): batching, the prompt, and the checks a
// translation must pass before it is kept. Pure; translate.ts does the calls.

export interface Unit {
  key: string;
  text: string;
}

export interface Translated {
  key: string;
  en: string;
}

/** Units in batches of at most `maxChars` characters, or one unit when it alone is longer. */
export function batches(units: Unit[], maxChars = 6000): Unit[][] {
  const out: Unit[][] = [];
  let cur: Unit[] = [];
  let size = 0;
  for (const u of units) {
    if (cur.length > 0 && size + u.text.length > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += u.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export const SYSTEM = `You translate Persian text from an AI research archive into clear, natural English for the same archive's English edition.

Rules:
- Translate faithfully. Add nothing, drop nothing, do not summarise or explain.
- Keep the markup exactly: line breaks, "- " bullets, **bold**, *italic*, \`code\` and [text](url) links (translate the link text, never the URL).
- Keep names of people, papers, models, companies and products in their usual English form. Write numbers with Western digits.
- Persian quotation marks «» become English quotation marks “”.

Answer with JSON only: {"items": [{"key": "<key>", "en": "<English>"}]}, one item per input item, same keys.`;

export function prompt(batch: Unit[]): string {
  return JSON.stringify({ items: batch.map((u) => ({ key: u.key, fa: u.text })) });
}

const urls = (s: string) => [...s.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]).sort();
const lines = (s: string) => s.trim().split(/\n+/).length;
const bullets = (s: string) => s.split("\n").filter((l) => /^\s*[-•]\s/.test(l)).length;

/** Why a translation cannot be kept, or null when it can. */
export function problem(unit: Unit, en: string): string | null {
  if (!en.trim()) return "empty";
  if ((en.match(/[؀-ۿ]/g) ?? []).length > 3) return "still Persian";
  if (urls(unit.text).join() !== urls(en).join()) return "links changed";
  if (bullets(unit.text) !== bullets(en)) return "bullets changed";
  if (Math.abs(lines(unit.text) - lines(en)) > 1) return "paragraphs changed";
  const ratio = en.length / unit.text.length;
  if (ratio < 0.5 || ratio > 2.5) return `length ratio ${ratio.toFixed(2)}`;
  return null;
}

/** The model's answer, parsed: only items for keys in the batch that pass every check. */
export function parse(
  batch: Unit[],
  answer: string,
): { kept: Translated[]; rejected: { key: string; why: string }[] } {
  const body = answer
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  let items: unknown;
  try {
    items = (JSON.parse(body) as { items?: unknown }).items;
  } catch {
    return { kept: [], rejected: batch.map((u) => ({ key: u.key, why: "not JSON" })) };
  }
  const byKey = new Map<string, string>();
  if (Array.isArray(items))
    for (const i of items)
      if (i && typeof i.key === "string" && typeof i.en === "string") byKey.set(i.key, i.en);
  const kept: Translated[] = [];
  const rejected: { key: string; why: string }[] = [];
  for (const u of batch) {
    const en = byKey.get(u.key);
    const why = en === undefined ? "missing" : problem(u, en);
    if (why || en === undefined) rejected.push({ key: u.key, why: why ?? "missing" });
    else kept.push({ key: u.key, en: en.trim() });
  }
  return { kept, rejected };
}
