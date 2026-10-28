import type { CatalogEntry } from "@anr/models";
import { describe, expect, it } from "vitest";
import { requests } from "./produce.ts";
import { geminiTts, SpeechFailed, type SpeechRequest } from "./tts.ts";

const entry = {
  id: "gemini-flash-tts",
  provider: "gemini",
  model: "gemini-3.8-flash-tts",
  apiKey: "test-key",
  price: { in: 0.5, out: 9 },
} as CatalogEntry;

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AAAA" } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1000 },
      }),
    );
  }) as unknown as typeof fetch;
  return { bodies, tts: geminiTts(entry, fetchImpl) };
}

const turn = (speaker: string, voice: string, text: string, direction?: string): SpeechRequest => ({
  speaker,
  voice,
  text,
  language: "fa",
  ...(direction && { direction }),
});

describe("Gemini TTS requests (D112)", () => {
  it("voices one speaker with its voice and style prompt", async () => {
    const { bodies, tts } = capture();
    const speech = await tts.synthesize(turn("niloofar", "Sulafat", "سلام", "hushed"));
    expect(bodies[0]).toMatchObject({
      contents: [{ parts: [{ text: "Say hushed: سلام" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } } },
      },
    });
    // Priced from the catalog: 10 tokens in at $0.50/M, 1000 out at $9/M.
    expect(speech.costUsd).toBeCloseTo(0.009 + 0.000_005, 9);
  });

  it("voices two speakers in one request, each turn its own part tagged with its speaker", async () => {
    const { bodies, tts } = capture();
    await tts.synthesizeTurns([
      turn("niloofar", "Sulafat", "یک"),
      turn("farzad", "Algenib", "دو"),
      turn("niloofar", "Sulafat", "سه"),
    ]);
    expect(bodies[0]).toMatchObject({
      contents: [
        {
          parts: [
            { text: "یک", speechMetadata: { speaker: "niloofar" } },
            { text: "دو", speechMetadata: { speaker: "farzad" } },
            { text: "سه", speechMetadata: { speaker: "niloofar" } },
          ],
        },
      ],
      generationConfig: {
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: "niloofar",
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } },
              },
              { speaker: "farzad", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Algenib" } } },
            ],
          },
        },
      },
    });
    expect(tts.batch).toBe("segment");
  });

  it("refuses three voices in one request", async () => {
    const { bodies, tts } = capture();
    await expect(
      tts.synthesizeTurns([
        turn("a", "V1", "x"),
        turn("b", "V2", "y"),
        turn("narrator", "V3", "z"),
      ]),
    ).rejects.toBeInstanceOf(SpeechFailed);
    expect(bodies).toHaveLength(0);
  });
});

describe("segment requests (plan B, D112)", () => {
  const gap = { kind: "silence" as const, seconds: 0.35, gap: true };
  const sting = { kind: "file" as const, path: "sting.flac" };

  it("joins lines until a third voice or a cue, dropping the pauses between them", () => {
    const items = [
      turn("maya", "Kore", "one"),
      gap,
      turn("leo", "Puck", "two"),
      gap,
      turn("narrator", "Enceladus", "three"),
      gap,
      turn("maya", "Kore", "four"),
      sting,
      turn("leo", "Puck", "five"),
    ];
    expect(requests(items).map((r) => (Array.isArray(r) ? r.map((t) => t.text) : r.kind))).toEqual([
      ["one", "two"],
      ["three", "four"],
      "file",
      ["five"],
    ]);
  });

  it("starts a new request at the word limit", () => {
    const long = turn("maya", "Kore", "word ".repeat(700).trim());
    expect(requests([long, gap, long, gap, long]).filter(Array.isArray)).toHaveLength(3);
    expect(requests([long, gap, long], 2, 1500).filter(Array.isArray)).toHaveLength(1);
  });
});
