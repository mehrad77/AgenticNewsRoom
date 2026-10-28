/**
 * Which text-to-speech engine voices a language (D113): the newsroom's choice when the platform
 * admin has it enabled and it speaks the language; else the platform default under the same
 * conditions; else none. The publisher voices with it and the desk shows it.
 */
export interface TtsEngineInfo {
  id: string;
  languages: readonly string[];
}

export type TtsChoice =
  | { ok: true; engine: string; source: "newsroom" | "default" }
  | { ok: false; reason: string };

export function chooseEngine(
  language: string,
  chosen: string | null | undefined,
  enabled: readonly string[],
  fallback: string,
  engines: readonly TtsEngineInfo[],
): TtsChoice {
  const usable = (id: string) =>
    enabled.includes(id) &&
    (engines.find((e) => e.id === id)?.languages.includes(language) ?? false);
  if (chosen && usable(chosen)) return { ok: true, engine: chosen, source: "newsroom" };
  if (usable(fallback)) return { ok: true, engine: fallback, source: "default" };
  return {
    ok: false,
    reason: chosen
      ? `the ${language} engine ${chosen} is not enabled or does not speak ${language}, and the default cannot stand in`
      : `no enabled engine speaks ${language}: choose one for the newsroom`,
  };
}
