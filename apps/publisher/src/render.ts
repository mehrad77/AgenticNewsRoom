import { fileURLToPath } from "node:url";
import { digitalSourceType, directionOf, type Language } from "@anr/core";
import { Liquid } from "liquidjs";

const formatsDir = fileURLToPath(new URL("../../../config/formats", import.meta.url));

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
    render(
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
    },
  };
}
