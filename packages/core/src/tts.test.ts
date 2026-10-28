import { describe, expect, it } from "vitest";
import { chooseEngine } from "./tts.ts";

const engines = [
  { id: "gemini", languages: ["fa", "en", "tr"] },
  { id: "xtts", languages: ["en", "tr"] },
  { id: "dia", languages: ["en"] },
];

describe("chooseEngine (D113)", () => {
  it("uses the newsroom's choice when it is enabled and speaks the language", () => {
    expect(chooseEngine("en", "xtts", ["gemini", "xtts"], "gemini", engines)).toEqual({
      ok: true,
      engine: "xtts",
      source: "newsroom",
    });
  });

  it("falls back to the default when the choice is disabled or cannot speak", () => {
    expect(chooseEngine("en", "xtts", ["gemini"], "gemini", engines)).toMatchObject({
      engine: "gemini",
      source: "default",
    });
    expect(chooseEngine("tr", "dia", ["gemini", "dia"], "gemini", engines)).toMatchObject({
      engine: "gemini",
    });
  });

  it("names why nothing can voice a language", () => {
    expect(chooseEngine("fa", null, ["xtts"], "gemini", engines)).toEqual({
      ok: false,
      reason: "no enabled engine speaks fa: choose one for the newsroom",
    });
  });
});
