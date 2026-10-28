// Text-to-speech for episode lines (D109): Gemini TTS, one call per line with the speaker's voice
// and the line's delivery direction as a style prompt, cached by model, voice, direction and text,
// so a retry or an unchanged line after an edit costs nothing. A fake makes tones for tests.
import { createHash } from "node:crypto";
import type { CatalogEntry } from "@anr/models";
import type { MediaStore } from "./store.ts";

export interface SpeechRequest {
  text: string;
  voice: string;
  language: string;
  /** A short delivery hint, such as "hushed"; passed as a style prompt. */
  direction?: string;
}

export interface Speech {
  /** Signed 16-bit little-endian mono PCM. */
  pcm: Buffer;
  sampleRate: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cached: boolean;
}

export interface TextToSpeech {
  readonly provider: string;
  readonly model: string;
  synthesize(request: SpeechRequest): Promise<Speech>;
}

/** What the model is asked to say: the text, after the delivery hint when there is one. */
export function stylePrompt(r: SpeechRequest): string {
  return r.direction ? `Say ${r.direction.trim()}: ${r.text}` : r.text;
}

/** A TTS call that failed; the episode is held with this as the reason. */
export class SpeechFailed extends Error {}

const TIMEOUT_MS = 120_000;

/** Gemini's generateContent with an audio response (24 kHz linear PCM). */
export function geminiTts(entry: CatalogEntry, fetchImpl: typeof fetch = fetch): TextToSpeech {
  if (!entry.apiKey) throw new Error(`no key for ${entry.id}`);
  const key = entry.apiKey;
  return {
    provider: entry.provider,
    model: entry.model,
    async synthesize(r) {
      const url = `${entry.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${entry.model}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: stylePrompt(r) }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: r.voice } } },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok)
        throw new SpeechFailed(
          `TTS answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      const json = (await response.json()) as {
        candidates?: {
          content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const audio = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!audio?.data) throw new SpeechFailed("TTS answered without audio");
      const rate = Number(/rate=([0-9]+)/.exec(audio.mimeType ?? "")?.[1] ?? 24_000);
      const tokensIn = json.usageMetadata?.promptTokenCount ?? 0;
      const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0;
      const price = entry.price ?? { in: 0, out: 0 };
      return {
        pcm: Buffer.from(audio.data, "base64"),
        sampleRate: rate,
        tokensIn,
        tokensOut,
        costUsd: (tokensIn * price.in + tokensOut * price.out) / 1_000_000,
        cached: false,
      };
    },
  };
}

/**
 * For tests and dry runs: a quiet tone per line, a little over a third of a second per word, its
 * pitch set by the voice so speakers are told apart by ear. Costs nothing and calls nothing.
 */
export function fakeTts(sampleRate = 24_000): TextToSpeech {
  return {
    provider: "fake",
    model: "fake-tts",
    async synthesize(r) {
      const seconds = Math.max(0.5, r.text.split(/\s+/).length * 0.35);
      const hz = 180 + (createHash("sha256").update(r.voice).digest()[0] ?? 0);
      const n = Math.round(seconds * sampleRate);
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const envelope = Math.min(1, i / 2400, (n - i) / 2400);
        pcm.writeInt16LE(
          Math.round(6000 * envelope * Math.sin((2 * Math.PI * hz * i) / sampleRate)),
          i * 2,
        );
      }
      return { pcm, sampleRate, tokensIn: 0, tokensOut: 0, costUsd: 0, cached: false };
    },
  };
}

export function cacheKey(model: string, r: SpeechRequest): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([model, r.voice, r.language, r.direction ?? "", r.text]))
    .digest("hex");
  return `tts/${hash.slice(0, 2)}/${hash}.pcm`;
}

/** The same request is synthesised once; later ones read the stored audio (24 kHz unless noted). */
export function cachedTts(tts: TextToSpeech, store: MediaStore): TextToSpeech {
  return {
    provider: tts.provider,
    model: tts.model,
    async synthesize(r) {
      const key = cacheKey(tts.model, r);
      const hit = await store.get(key);
      const meta = await store.get(`${key}.json`);
      if (hit && meta) {
        const { sampleRate } = JSON.parse(meta.toString()) as { sampleRate: number };
        return { pcm: hit, sampleRate, tokensIn: 0, tokensOut: 0, costUsd: 0, cached: true };
      }
      const speech = await tts.synthesize(r);
      await store.put(key, speech.pcm, "audio/L16");
      await store.put(
        `${key}.json`,
        Buffer.from(JSON.stringify({ sampleRate: speech.sampleRate })),
        "application/json",
      );
      return speech;
    },
  };
}
