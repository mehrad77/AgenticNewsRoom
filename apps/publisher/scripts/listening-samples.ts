// Listening samples for milestone 5's gate: the English and Turkish hosts, each pair in one
// multi-speaker Gemini TTS request, so the whole test costs exactly two requests. Each sample
// opens with the episode's code-rendered AI-voice intro, then a short neutral conversation.
// `pnpm --filter @anr/publisher samples -- --yes` writes .data/m5/listening/<language>.mp3.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "@anr/core";
import { buildCatalog, loadModelsConfig, modelsFile } from "@anr/models";
import { createRenderer } from "@anr/render";
import { parse } from "yaml";
import { geminiTts } from "../src/podcast/tts.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const configDir = join(root, "config");
const out = join(root, ".data", "m5", "listening");

const SAMPLES: { language: Language; newsroom: string; lines: [number, string][] }[] = [
  {
    language: "en",
    newsroom: "ai",
    lines: [
      [
        0,
        "This week we look at how small language models are trained, and why that matters for people who run them on a laptop.",
      ],
      [1, "And we will keep it simple: what changed, who did it, and what is still unclear."],
      [0, "Let's start with the numbers, because they surprised me."],
      [1, "They surprised me too. But first, a quick word on where our facts come from."],
    ],
  },
  {
    language: "tr",
    newsroom: "kultur",
    lines: [
      [0, "Bu hafta İstanbul'un bağımsız müzik sahnesine ve yeni çıkan albümlere bakıyoruz."],
      [1, "Ve her zamanki gibi, söylediğimiz her şey bir kaynağa dayanıyor."],
      [0, "Önce sanatçının kendi açıklamasıyla başlayalım; çünkü hikâye orada başlıyor."],
      [1, "Sonra da eleştirmenlerin ne dediğine bakarız. Hazırsan başlayalım."],
    ],
  },
];

/** `--language tr` makes only that language's request. */
const at = process.argv.indexOf("--language");
const chosen = at >= 0 ? SAMPLES.filter((s) => s.language === process.argv[at + 1]) : SAMPLES;
if (!process.argv.includes("--yes")) {
  console.log(
    `This makes exactly ${chosen.length} TTS request(s), one per language. Run with --yes.`,
  );
  process.exit(0);
}

process.loadEnvFile?.(join(root, ".env"));
const models = loadModelsConfig(modelsFile(configDir));
const entry = buildCatalog(models).entries.get(models.tts);
if (!entry?.apiKey) throw new Error(`no key for the TTS model ${models.tts}`);
const renderer = createRenderer(join(configDir, "formats"));
const tts = geminiTts(entry);
mkdirSync(out, { recursive: true });

for (const s of chosen) {
  const series = parse(
    readFileSync(join(configDir, "newsrooms", s.newsroom, "series", "weekly-podcast.yaml"), "utf8"),
  ) as { name: Record<string, string>; hosts: Record<string, Record<string, string>> };
  const hosts = Object.entries(series.hosts[s.language] ?? {});
  const [a, b] = hosts;
  if (!a || !b) throw new Error(`${s.newsroom} needs two ${s.language} hosts`);
  const intro = await renderer.introLines(
    s.language,
    series.name[s.language] ?? "",
    [a[0], b[0]],
    false,
  );
  const turns = [
    ...intro.map((l) => ({ speaker: l.speaker, text: l.text })),
    ...s.lines.map(([who, text]) => ({ speaker: hosts[who]?.[0] ?? a[0], text })),
  ].map((t) => ({
    ...t,
    voice: series.hosts[s.language]?.[t.speaker] ?? a[1],
    language: s.language,
  }));
  console.log(`[samples] ${s.language}: 1 request, voices ${a[1]} and ${b[1]}`);
  // The episode pipeline's own adapter: two voices, each turn its own part tagged with its speaker.
  let speech: Awaited<ReturnType<typeof tts.synthesizeTurns>>;
  try {
    speech = await tts.synthesizeTurns(turns);
  } catch (error) {
    // Kept whole: a refused request still counts against the day's few TTS calls.
    const message = `${s.language}: ${(error as Error).message}`;
    writeFileSync(join(out, `${s.language}.error.txt`), message);
    throw new Error(`${message.slice(0, 400)}\n(saved in ${join(out, `${s.language}.error.txt`)})`);
  }
  const rate = String(speech.sampleRate);
  const pcm = join(out, `${s.language}.pcm`);
  writeFileSync(pcm, speech.pcm);
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "s16le",
    "-ar",
    rate,
    "-ac",
    "1",
    "-i",
    pcm,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-ar",
    "44100",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    join(out, `${s.language}.mp3`),
  ]);
  writeFileSync(
    join(out, `${s.language}.txt`),
    `${turns.map((t) => `${t.speaker}: ${t.text}`).join("\n")}\n\ntokens: ${speech.tokensIn} in, ${speech.tokensOut} out; $${speech.costUsd.toFixed(4)}\n`,
  );
  console.log(
    `[samples] ${s.language}: ${join(out, `${s.language}.mp3`)} ($${speech.costUsd.toFixed(4)})`,
  );
}
