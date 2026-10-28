import { fileURLToPath } from "node:url";
import { digitalSourceType, directionOf, type Language } from "@anr/core";
import type { Client } from "@anr/db";
import { Liquid } from "liquidjs";

export {
  audioPath,
  type ContextInput,
  channelKinds,
  chapterTitles,
  editedByPerson,
  isEpisode,
  leadIds,
  type SitePathInput,
  sitePath,
  templateContext,
} from "./context.ts";

const formatsDir = fileURLToPath(new URL("../../../config/formats", import.meta.url));

/** Longest message a channel accepts, in visible UTF-16 units (Telegram: after entity parsing). */
export const CHANNEL_LIMITS: Readonly<Record<string, number>> = { telegram: 4096 };

/** The word every AI-voice intro line must say, per language. */
export const AI_TERMS: Readonly<Record<Language, string>> = {
  fa: "هوش مصنوعی",
  en: "AI",
  tr: "yapay zekâ",
};

/** One spoken line of an episode's opening: a host by name, or the narrator. */
export interface IntroLine {
  speaker: string;
  text: string;
}

/** A host's name as spoken: the series config's key, capitalised (`maya` → `Maya`). */
export const spokenName = (host: string) => host.charAt(0).toLocaleUpperCase() + host.slice(1);

/** A series' `host_names` for one language: how each host is named there. */
export type HostNames = Readonly<Record<string, string>>;

/** A host's name in a language: its `host_names` entry, else its key capitalised. */
export const hostName = (host: string, names?: HostNames) => names?.[host] ?? spokenName(host);

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The text a reader sees: tags dropped, entities decoded. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    }).length;
}

/** Whether every tag opened in `html` is closed in it, in order. */
export function balancedTags(html: string): boolean {
  const open: string[] = [];
  for (const [, slash, name] of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const tag = (name ?? "").toLowerCase();
    if (!slash) open.push(tag);
    else if (open.pop() !== tag) return false;
  }
  return open.length === 0;
}

/**
 * Splits a rendered post into messages of at most `limit` visible units (D88). Blocks are separated
 * by blank lines and never cut; the lines from the last disclosure label onwards are the footer and
 * end every part. Throws when the label is missing, a part cannot fit, or a part's tags do not
 * balance (Telegram refuses a message with a broken tag).
 */
export function splitParts(text: string, label: string, limit: number): string[] {
  const blocks = text
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const at = blocks.findLastIndex((b) => b.includes(label));
  if (at === -1) throw new Error("the disclosure label is missing");
  const lines = (blocks[at] ?? "").split("\n");
  const from = lines.findIndex((l) => l.includes(label));
  const footer = lines.slice(from).join("\n");
  const before = lines.slice(0, from).join("\n").trim();
  blocks.splice(at, 1, ...(before ? [before] : []));
  const join = (body: string[]) => [...body, footer].join("\n\n");
  if (visibleLength(footer) > limit) throw new Error(`the footer cannot fit in ${limit}`);
  const parts: string[][] = [];
  for (const block of blocks) {
    const last = parts.at(-1);
    if (last && visibleLength(join([...last, block])) <= limit) last.push(block);
    else {
      if (visibleLength(join([block])) > limit)
        throw new Error(`a block of ${visibleLength(block)} characters cannot fit in ${limit}`);
      parts.push([block]);
    }
  }
  const out = parts.length === 0 ? [footer] : parts.map(join);
  for (const [i, part] of out.entries())
    if (!balancedTags(part)) throw new Error(`part ${i + 1} has an unbalanced tag`);
  return out;
}

/**
 * Renders a format's channel template. Templates live in config/formats/<format>/templates and
 * share partials in config/formats/_partials (the AI-disclosure label among them).
 */
/**
 * Why an episode's opening does not introduce its AI voices: a host or the narrator without a
 * line, a host's line that does not name them, or a line without the language's word for AI.
 */
export function introProblems(
  lines: readonly IntroLine[],
  language: Language,
  hosts: readonly string[],
  narrator: boolean,
  names?: HostNames,
): string[] {
  const problems: string[] = [];
  const term = AI_TERMS[language].toLocaleLowerCase(language);
  for (const voice of [...hosts, ...(narrator ? ["narrator"] : [])]) {
    const line = lines.find((l) => l.speaker === voice);
    if (!line) problems.push(`${voice} is not introduced`);
    else if (voice !== "narrator" && !line.text.includes(hostName(voice, names)))
      problems.push(`${voice}'s line does not name them`);
    else if (!line.text.toLocaleLowerCase(language).includes(term))
      problems.push(`${voice}'s line does not say "${AI_TERMS[language]}"`);
  }
  return problems;
}

export function createRenderer(root = formatsDir) {
  const engine = new Liquid({
    root,
    partials: `${root}/_partials`,
    extname: ".liquid",
    strictFilters: true,
    // Agent-written text is untrusted: every {{ output }} is HTML-escaped.
    outputEscape: "escape",
  });
  return {
    /** The AI-disclosure label alone, from the shared partial: what every template must show. */
    async disclosureLabel(language: Language, edited = false): Promise<string> {
      const out = await engine.parseAndRender(
        '{% render "disclosure", language: language, edited: edited %}',
        { language, edited },
      );
      return out.trim();
    },
    render,
    /** The notes line naming an episode's voices as AI (`_partials/ai-voices-notes.liquid`). */
    async voicesNote(
      language: Language,
      hosts: readonly string[],
      narrator: boolean,
      names?: HostNames,
    ): Promise<string> {
      const out = await engine.parseAndRender(
        '{% render "ai-voices-notes", language: language, hosts: hosts, narrator: narrator %}',
        {
          language,
          hosts: hosts
            .map((h) => hostName(h, names))
            .join(language === "fa" ? " و " : language === "tr" ? " ve " : " and "),
          narrator,
        },
      );
      return out.trim();
    },
    /**
     * The opening every episode starts with (from `_partials/ai-voices.liquid`): each host, then
     * the narrator, says they are an AI voice. The audio pipeline voices exactly these lines.
     */
    async introLines(
      language: Language,
      series: string,
      hosts: readonly string[],
      narrator: boolean,
      names?: HostNames,
    ): Promise<IntroLine[]> {
      const line = async (vars: Record<string, unknown>) =>
        (
          await engine.parseAndRender(
            '{% render "ai-voices", language: language, series: series, name: name, first: first, narrator: narrator %}',
            { language, series, name: "", first: false, narrator: false, ...vars },
          )
        ).trim();
      const out: IntroLine[] = [];
      for (const [i, host] of hosts.entries())
        out.push({
          speaker: host,
          text: await line({ name: hostName(host, names), first: i === 0 }),
        });
      if (narrator) out.push({ speaker: "narrator", text: await line({ narrator: true }) });
      return out;
    },
    /**
     * What a channel is sent: the template's output, split to the channel's limit with the
     * disclosure label on every part. The publisher sends these and the gate checks these (D79).
     */
    async renderParts(
      format: string,
      channel: string,
      language: Language,
      context: Record<string, unknown>,
    ): Promise<string[]> {
      const out = await render(format, channel, language, context);
      const limit = CHANNEL_LIMITS[channel];
      if (limit === undefined) return [out];
      const label = await engine.parseAndRender(
        '{% render "disclosure", language: language, edited: edited %}',
        { language, edited: context.edited === true },
      );
      return splitParts(out, label.trim(), limit);
    },
  };

  function render(
    format: string,
    channel: string,
    language: Language,
    context: Record<string, unknown>,
  ): Promise<string> {
    return engine.renderFile(`${format}/templates/${channel}`, {
      ...context,
      language,
      direction: directionOf(language),
      // One source for the visible label (`edited`) and the machine-readable IPTC type.
      digital_source_type: digitalSourceType(context.edited === true).uri,
    });
  }
}

/** The notes line of a series' episodes in `language`: its hosts and narrator named as AI. */
export async function seriesVoicesNote(
  client: Client,
  renderer: ReturnType<typeof createRenderer>,
  seriesSlug: string,
  language: Language,
): Promise<string> {
  const { rows } = await client.query<{
    hosts: Record<string, string> | null;
    names: Record<string, string> | null;
    narrator: string | null;
  }>(
    `select config->'hosts'->$2 as hosts, config->'host_names'->$2 as names,
            config->'narrator'->>$2 as narrator
     from series where slug = $1`,
    [seriesSlug, language],
  );
  const row = rows[0];
  return renderer.voicesNote(
    language,
    Object.keys(row?.hosts ?? {}),
    Boolean(row?.narrator),
    row?.names ?? undefined,
  );
}
