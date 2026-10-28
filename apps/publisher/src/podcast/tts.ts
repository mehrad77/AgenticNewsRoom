// Text-to-speech for episode lines (D109): Gemini TTS, one call per line with the speaker's voice
// and the line's delivery direction as a style prompt, cached by model, voice, direction and text,
// so a retry or an unchanged line after an edit costs nothing. A fake makes tones for tests.
import { createHash } from "node:crypto";
import type { CatalogEntry } from "@anr/models";
import type { MediaStore } from "./store.ts";

export interface SpeechRequest {
  text: string;
  voice: string;
  /** Who says it (a host's key or "narrator"); names the turn in a two-voice request. */
  speaker?: string;
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
  /**
   * How episodes are voiced (D112): `line`, one request per line; `segment`, a segment's lines
   * joined into as few requests as two voices per request allow (plan B, for quota-limited APIs).
   */
  readonly batch: "line" | "segment";
  synthesize(request: SpeechRequest): Promise<Speech>;
  /** Several turns, at most two voices, as one clip. */
  synthesizeTurns(turns: readonly SpeechRequest[]): Promise<Speech>;
}

/** Most voices one request may speak in (Gemini's multi-speaker limit). */
export const MAX_VOICES = 2;

/** What the model is asked to say: the text, after the delivery hint when there is one. */
export function stylePrompt(r: SpeechRequest): string {
  return r.direction ? `Say ${r.direction.trim()}: ${r.text}` : r.text;
}

/** A TTS call that failed; the episode is held with this as the reason. */
export class SpeechFailed extends Error {}

const TIMEOUT_MS = 120_000;

/**
 * Gemini's generateContent with an audio response (24 kHz linear PCM). One voice: the text with
 * its style prompt. Two voices: each turn its own text part, tagged with its speaker.
 */
export function geminiTts(entry: CatalogEntry, fetchImpl: typeof fetch = fetch): TextToSpeech {
  if (!entry.apiKey) throw new Error(`no key for ${entry.id}`);
  const key = entry.apiKey;
  const price = entry.price ?? { in: 0, out: 0 };
  async function call(turns: readonly SpeechRequest[]): Promise<Speech> {
    const voices = [...new Set(turns.map((t) => t.voice))];
    if (voices.length === 0 || voices.length > MAX_VOICES)
      throw new SpeechFailed(`a request speaks in one or two voices, not ${voices.length}`);
    const speakers = new Map(turns.map((t) => [t.speaker ?? t.voice, t.voice]));
    const single = voices.length === 1;
    const body = {
      contents: [
        {
          parts: single
            ? [{ text: turns.map(stylePrompt).join("\n") }]
            : turns.map((t) => ({
                text: stylePrompt(t),
                speechMetadata: { speaker: t.speaker ?? t.voice },
              })),
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: single
          ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[0] } } }
          : {
              multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: [...speakers].map(([speaker, voice]) => ({
                  speaker,
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
                })),
              },
            },
      },
    };
    const url = `${entry.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${entry.model}:generateContent`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
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
    return {
      pcm: Buffer.from(audio.data, "base64"),
      sampleRate: rate,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * price.in + tokensOut * price.out) / 1_000_000,
      cached: false,
    };
  }
  return {
    provider: entry.provider,
    model: entry.model,
    // A few requests a day on this account: a segment per request (plan B).
    batch: "segment",
    synthesize: (r) => call([r]),
    synthesizeTurns: call,
  };
}

/**
 * A local engine's server (`tools/tts-eval/serve.py`, D113): one line per request, answered as
 * 16-bit PCM with its sample rate in a header. No quota, so line by line; it costs nothing.
 */
export function localTts(entry: CatalogEntry, fetchImpl: typeof fetch = fetch): TextToSpeech {
  if (!entry.baseUrl) throw new Error(`${entry.id} has no server address`);
  const base = entry.baseUrl.replace(/\/$/, "");
  const engine: TextToSpeech = {
    provider: entry.provider,
    model: entry.model,
    batch: "line",
    async synthesize(r) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: r.text,
            language: r.language,
            voice: r.voice,
            speaker: r.speaker ?? null,
            direction: r.direction ?? null,
          }),
          signal: AbortSignal.timeout(entry.timeoutMs),
        });
      } catch (error) {
        throw new SpeechFailed(
          `${entry.id} is not reachable at ${base}: ${(error as Error).message}`,
        );
      }
      if (!response.ok)
        throw new SpeechFailed(
          `${entry.id} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      return {
        pcm: Buffer.from(await response.arrayBuffer()),
        sampleRate: Number(response.headers.get("x-sample-rate") ?? 24_000),
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        cached: false,
      };
    },
    async synthesizeTurns(turns) {
      const parts: Speech[] = [];
      for (const t of turns) parts.push(await engine.synthesize(t));
      return { ...(parts[0] as Speech), pcm: Buffer.concat(parts.map((p) => p.pcm)) };
    },
  };
  return engine;
}

/** The adapter for a catalogued engine: Gemini's API or a local server. */
export function ttsFor(entry: CatalogEntry): TextToSpeech {
  return entry.kind === "local-tts" ? localTts(entry) : geminiTts(entry);
}

/**
 * For tests and dry runs: a quiet tone per line, a little over a third of a second per word, its
 * pitch set by the voice so speakers are told apart by ear. Costs nothing and calls nothing.
 */
export function fakeTts(sampleRate = 24_000, batch: "line" | "segment" = "line"): TextToSpeech {
  const fake: TextToSpeech = {
    provider: "fake",
    model: "fake-tts",
    batch,
    async synthesizeTurns(turns) {
      const parts = await Promise.all(turns.map((t) => fake.synthesize(t)));
      return { ...(parts[0] as Speech), pcm: Buffer.concat(parts.map((p) => p.pcm)) };
    },
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
  return fake;
}

export function cacheKey(model: string, turns: readonly SpeechRequest[]): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        model,
        ...turns.map((r) => [r.speaker ?? "", r.voice, r.language, r.direction ?? "", r.text]),
      ]),
    )
    .digest("hex");
  return `tts/${hash.slice(0, 2)}/${hash}.pcm`;
}

/** The same request is synthesised once; later ones read the stored audio. */
export function cachedTts(tts: TextToSpeech, store: MediaStore): TextToSpeech {
  async function cached(turns: readonly SpeechRequest[], make: () => Promise<Speech>) {
    const key = cacheKey(tts.model, turns);
    const hit = await store.get(key);
    const meta = await store.get(`${key}.json`);
    if (hit && meta) {
      const { sampleRate } = JSON.parse(meta.toString()) as { sampleRate: number };
      return { pcm: hit, sampleRate, tokensIn: 0, tokensOut: 0, costUsd: 0, cached: true };
    }
    const speech = await make();
    await store.put(key, speech.pcm, "audio/L16");
    await store.put(
      `${key}.json`,
      Buffer.from(JSON.stringify({ sampleRate: speech.sampleRate })),
      "application/json",
    );
    return speech;
  }
  return {
    provider: tts.provider,
    model: tts.model,
    batch: tts.batch,
    synthesize: (r) => cached([r], () => tts.synthesize(r)),
    synthesizeTurns: (turns) => cached(turns, () => tts.synthesizeTurns(turns)),
  };
}
