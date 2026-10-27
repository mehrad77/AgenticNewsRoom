import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assemblePrompt, MAX_PROMPT_BYTES, readGuides, styleFor } from "./assemble.ts";
import { DESK_CLAIMS, DESK_DRAFT, DESK_OUTLINE, DESK_ROLE, RENDERER_ROLE } from "./roles.ts";

const configDir = fileURLToPath(new URL("../../../../config", import.meta.url));

/** Every newsroom × series × language the desk or the renderer can be asked to write. */
function targets() {
  const out: { newsroom: string; format: string; language: string }[] = [];
  for (const newsroom of readdirSync(`${configDir}/newsrooms`)) {
    for (const file of readdirSync(`${configDir}/newsrooms/${newsroom}/series`)) {
      const series = parse(
        readFileSync(`${configDir}/newsrooms/${newsroom}/series/${file}`, "utf8"),
      );
      for (const language of series.languages)
        out.push({ newsroom, format: series.format, language });
    }
  }
  return out;
}

describe("prompt assembly (D75)", () => {
  it.each(targets())(
    "keeps $newsroom $format $language under 5 KB",
    ({ newsroom, format, language }) => {
      const { style, guide } = readGuides(configDir, newsroom, format);
      const desk = assemblePrompt("desk", {
        role: DESK_ROLE,
        steps: [DESK_OUTLINE, DESK_DRAFT(language), DESK_CLAIMS],
        style,
        guide,
        language,
      });
      const renderer = assemblePrompt("renderer", { role: RENDERER_ROLE, style, guide, language });
      for (const p of [desk, renderer]) expect(p.bytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
      expect(desk.system).toContain("# Format guide");
    },
  );

  it("keeps only the target language's style section", () => {
    const style =
      "# Guide\n\n## All languages\n\n- a\n\n## fa (Persian)\n\n- f\n\n## en (English)\n\n- e\n";
    expect(styleFor(style, "fa")).toBe("## All languages\n\n- a\n\n## fa (Persian)\n\n- f");
    expect(styleFor(style, "en")).not.toContain("- f");
  });

  it("versions the prompt by its content and refuses one over the limit", () => {
    const a = assemblePrompt("desk", { role: "x", guide: "g" });
    expect(a.version).toMatch(/^desk-[0-9a-f]{12}$/);
    expect(assemblePrompt("desk", { role: "x", guide: "h" }).version).not.toBe(a.version);
    // Persian is two bytes a letter: 2,600 letters are over 5 KB.
    expect(() => assemblePrompt("desk", { role: "ب".repeat(2600) })).toThrow(/bytes, over/);
  });
});
