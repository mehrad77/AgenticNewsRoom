// Prompt assembly (D75): the platform's role prompt, the newsroom's style guide for the target
// language and the format's writing guide, all versioned in the repo. Lead text is input, not
// prompt, and is not counted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The design's target, against the old system's 74 KB rulebook; measured in UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 5 * 1024;

export interface PromptParts {
  role: string;
  /** Step instructions sent later in the run; counted with the prompt. */
  steps?: readonly string[];
  /** The newsroom's style.md, whole; only the parts for `language` are used. */
  style?: string;
  /** The format's guide.md. */
  guide?: string;
  language?: string;
}

export interface AssembledPrompt {
  system: string;
  /** `<role>-<hash>`: a change to any part is a new version (Agent run `prompt_version`). */
  version: string;
  bytes: number;
}

/**
 * The "All languages" section of a style guide and the section for one language (`## fa ...`);
 * the other languages' sections are left out.
 */
export function styleFor(style: string, language: string): string {
  const sections = style.split(/^(?=## )/m);
  const keep = sections.filter((s, i) => {
    if (i === 0) return false; // the title
    const heading = s.split("\n", 1)[0]?.toLowerCase() ?? "";
    return heading.startsWith("## all languages") || new RegExp(`^## ${language}\\b`).test(heading);
  });
  return keep.join("").trim();
}

export function assemblePrompt(roleName: string, parts: PromptParts): AssembledPrompt {
  const blocks = [parts.role.trim()];
  if (parts.style !== undefined) {
    const style = parts.language ? styleFor(parts.style, parts.language) : parts.style.trim();
    blocks.push(`# Style guide\n\n${style.replace(/^## /gm, "### ")}`);
  }
  if (parts.guide !== undefined)
    blocks.push(`# Format guide\n\n${parts.guide.replace(/^# .*\n+/, "").trim()}`);
  const system = blocks.join("\n\n");
  const counted = [system, ...(parts.steps ?? [])].join("\n");
  const bytes = Buffer.byteLength(counted, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(`the ${roleName} prompt is ${bytes} bytes, over ${MAX_PROMPT_BYTES}`);
  }
  const hash = createHash("sha256").update(counted).digest("hex").slice(0, 12);
  return { system, version: `${roleName}-${hash}`, bytes };
}

/** A newsroom's style guide and a format's writing guide, read from config/ (D75). */
export function readGuides(configDir: string, newsroom: string, format: string) {
  const own = join(configDir, "newsrooms", newsroom, "formats", format, "guide.md");
  let guide: string;
  try {
    // A newsroom may override a format's guide, never its schema or checks.
    guide = readFileSync(own, "utf8");
  } catch {
    guide = readFileSync(join(configDir, "formats", format, "guide.md"), "utf8");
  }
  return { style: readFileSync(join(configDir, "newsrooms", newsroom, "style.md"), "utf8"), guide };
}
