// Writes each podcast series' stock sound cues (D108) into config/newsrooms/<newsroom>/audio/<series>/:
// a sting, a bed swell, a bed out, a transition, a loopable music bed and a jingle. Every sound is
// synthesised by ffmpeg from the formulas below (sine tones with envelopes), so no recording or
// third-party material is in them and they are the project's own. Each series plays them in its
// own key. `pnpm --filter @anr/publisher cues` regenerates them; the output is deterministic.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = fileURLToPath(new URL("../../../config", import.meta.url));
export const RATE = 24_000;

/** Series → key: frequencies are multiplied by `ratio`. Integer cycles keep the bed loopable. */
const SERIES = [
  { newsroom: "ai", series: "weekly-podcast", ratio: 1 },
  { newsroom: "kultur", series: "weekly-podcast", ratio: 0.75 },
];

/** A soft A-major pad: 220, 277.25 and 329.625 Hz complete whole cycles every 8 seconds. */
const pad = (r: number) =>
  `0.07*(sin(2*PI*${220 * r}*t)+sin(2*PI*${277.25 * r}*t)+sin(2*PI*${329.625 * r}*t))*(0.85+0.15*sin(2*PI*0.25*t))`;

const CUES = (r: number): Record<string, { expr: string; seconds: number }> => ({
  // Two bell partials with exponential decay.
  sting: {
    expr: `0.35*sin(2*PI*${660 * r}*t)*exp(-3*t)+0.2*sin(2*PI*${990 * r}*t)*exp(-4.5*t)`,
    seconds: 1.4,
  },
  // A rising sweep inside a half-sine envelope.
  transition: {
    expr: `0.22*sin(2*PI*(${300 * r}+${450 * r}*t)*t)*sin(PI*t/0.9)`,
    seconds: 0.9,
  },
  bed: { expr: pad(r), seconds: 8 },
  "bed-swell": { expr: `(${pad(r)})*(t/3)`, seconds: 3 },
  "bed-out": { expr: `(${pad(r)})*(1-t/3)`, seconds: 3 },
  // Four rising notes, a quarter second each, then the chord fading out.
  jingle: {
    expr: [440, 554.5, 659.25, 880]
      .map(
        (f, i) =>
          `0.25*sin(2*PI*${f * r}*t)*between(t,${i * 0.25},${i * 0.25 + 0.5})*exp(-4*(t-${i * 0.25}))`,
      )
      .concat([`(${pad(r)})*between(t,1,3)*(3-t)/2`])
      .join("+"),
    seconds: 3,
  },
});

export function writeCues(dir: string, ratio: number): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, { expr, seconds }] of Object.entries(CUES(ratio))) {
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${expr}':s=${RATE}:d=${seconds}`,
      "-ac",
      "1",
      "-c:a",
      "flac",
      // No encoder tag, so the bytes do not change with the ffmpeg version.
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      join(dir, `${name}.flac`),
    ]);
  }
  writeFileSync(
    join(dir, "LICENSE.md"),
    `# Sound cues: owned

Every file here was synthesised by \`apps/publisher/scripts/cues.ts\` with ffmpeg from sine-tone
formulas (key ratio ${ratio}). They contain no recording and no third-party material, so they are
the project's own work, released with the repository. Regenerate with
\`pnpm --filter @anr/publisher cues\`.
`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const s of SERIES) {
    const dir = join(configDir, "newsrooms", s.newsroom, "audio", s.series);
    writeCues(dir, s.ratio);
    console.log(`cues written: ${dir}`);
  }
}
