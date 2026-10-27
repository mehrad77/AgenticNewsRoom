import { fileURLToPath } from "node:url";
import { digitalSourceType, directionOf, type Language } from "@anr/core";
import { Liquid } from "liquidjs";

export {
  type ContextInput,
  channelKinds,
  editedByPerson,
  leadIds,
  templateContext,
} from "./context.ts";

const formatsDir = fileURLToPath(new URL("../../../config/formats", import.meta.url));

/** Longest message a channel accepts, in visible UTF-16 units (Telegram: after entity parsing). */
export const CHANNEL_LIMITS: Readonly<Record<string, number>> = { telegram: 4096 };

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
