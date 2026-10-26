/** Languages ANR v1 writes in. A newsroom lists several, one of them primary. */
export const LANGUAGES = ["fa", "en", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

export type Direction = "rtl" | "ltr";

const RTL: ReadonlySet<Language> = new Set(["fa"]);

/** Text direction follows the page's language, never the newsroom. */
export function directionOf(language: Language): Direction {
  return RTL.has(language) ? "rtl" : "ltr";
}

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}
