// The episode mix (D109): every clip decoded to one PCM format and joined in order, a music bed
// looped under the story segments and ducked whenever someone speaks, loudness normalised to
// −16 LUFS in two passes (measure, then one linear gain), encoded as MP3 with ID3 tags and
// chapters in the same step. Episodes contain no recorded music: cues are the series' own.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const RATE = 24_000;
/** Integrated loudness, true peak and loudness range of every episode. */
export const LOUDNESS = { I: -16, TP: -1.5, LRA: 11 };
const BYTES_PER_SECOND = RATE * 2;

export type Clip =
  | { kind: "speech"; pcm: Buffer; sampleRate: number }
  | { kind: "file"; path: string }
  /** `gap`: the pause between two lines, left out when lines are voiced in one request. */
  | { kind: "silence"; seconds: number; gap?: boolean };

/** A stretch of the episode: its clips, a chapter title if it starts a chapter, and whether the bed plays under it. */
export interface Block {
  chapter?: string;
  bed?: boolean;
  clips: Clip[];
}

export interface Tags {
  title: string;
  artist: string;
  album: string;
  date: string;
  language: string;
  comment: string;
}

export interface Chapter {
  title: string;
  start: number;
  end: number;
}

export interface Mixed {
  mp3: Buffer;
  seconds: number;
  chapters: Chapter[];
}

const ffmpeg = (args: string[]) =>
  run("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });

/**
 * Any audio as 24 kHz mono signed 16-bit PCM. Speech already in it is used as it is, and each cue
 * file is decoded once per episode (`files`).
 */
async function decode(clip: Clip, files: Map<string, Promise<Buffer>>): Promise<Buffer> {
  if (clip.kind === "silence") return Buffer.alloc(Math.round(clip.seconds * RATE) * 2);
  if (clip.kind === "speech" && clip.sampleRate === RATE) return clip.pcm;
  if (clip.kind === "speech") return ffmpegDecode(clip);
  const pcm = files.get(clip.path) ?? ffmpegDecode(clip);
  files.set(clip.path, pcm);
  return pcm;
}

function ffmpegDecode(clip: Exclude<Clip, { kind: "silence" }>): Promise<Buffer> {
  const input =
    clip.kind === "file"
      ? ["-i", clip.path]
      : ["-f", "s16le", "-ar", String(clip.sampleRate), "-ac", "1", "-i", "pipe:0"];
  const args = [
    "-loglevel",
    "error",
    ...input,
    "-ac",
    "1",
    "-ar",
    String(RATE),
    "-f",
    "s16le",
    "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ffmpeg",
      ["-hide_banner", "-nostdin", ...args],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    if (clip.kind === "speech") child.stdin?.end(clip.pcm);
    else child.stdin?.end();
  });
}

/** ffmetadata escapes `=`, `;`, `#`, `\` and line breaks with a backslash. */
const esc = (v: string) => v.replace(/[=;#\\\n]/g, (c) => `\\${c}`);

export function metadata(tags: Tags, chapters: readonly Chapter[]): string {
  const lines = [";FFMETADATA1", ...Object.entries(tags).map(([k, v]) => `${k}=${esc(v)}`)];
  for (const c of chapters) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${Math.round(c.start * 1000)}`,
      `END=${Math.round(c.end * 1000)}`,
      `title=${esc(c.title)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The bed's gain over time: on under each range, with two-second fades, else silent. */
export function bedVolume(ranges: readonly [number, number][], level = 0.35): string {
  // ffmpeg's min() and max() take two arguments.
  const terms = ranges.map(
    ([s, e]) => `max(0,min(1,min((t-${s.toFixed(3)})/2,(${e.toFixed(3)}-t)/2)))`,
  );
  return `${level}*(${terms.join("+")})`;
}

/** Measures the mix (loudnorm's first pass). */
async function measure(path: string): Promise<Record<string, string>> {
  const { stderr } = await ffmpeg([
    "-i",
    path,
    "-af",
    `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
  if (!json) throw new Error("loudnorm printed no measurement");
  return JSON.parse(json) as Record<string, string>;
}

/** Integrated loudness of a file in LUFS (ffmpeg's EBU R128 meter). */
export async function loudness(path: string): Promise<number> {
  const { stderr } = await ffmpeg(["-i", path, "-af", "ebur128", "-f", "null", "-"]);
  const all = [...stderr.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)];
  return Number(all.at(-1)?.[1]);
}

export async function mixEpisode(
  blocks: readonly Block[],
  bedPath: string | null,
  tags: Tags,
  workDir: string,
): Promise<Mixed> {
  const parts: Buffer[] = [];
  const chapters: Chapter[] = [];
  const bedRanges: [number, number][] = [];
  const files = new Map<string, Promise<Buffer>>();
  let at = 0;
  for (const block of blocks) {
    const start = at;
    for (const clip of block.clips) {
      const pcm = await decode(clip, files);
      parts.push(pcm);
      at += pcm.length / BYTES_PER_SECOND;
    }
    if (block.chapter) chapters.push({ title: block.chapter, start, end: at });
    if (block.bed) bedRanges.push([start, at]);
  }
  // A chapter runs until the next one starts.
  for (const [i, c] of chapters.entries()) c.end = chapters[i + 1]?.start ?? at;
  const voice = join(workDir, "voice.pcm");
  writeFileSync(voice, Buffer.concat(parts));

  const mixed = join(workDir, "mixed.wav");
  const raw = ["-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", voice];
  if (bedPath && bedRanges.length > 0) {
    await ffmpeg([
      "-loglevel",
      "error",
      ...raw,
      "-stream_loop",
      "-1",
      "-i",
      bedPath,
      "-filter_complex",
      [
        "[0:a]asplit=2[v][sc]",
        `[1:a]aresample=${RATE},atrim=0:${at.toFixed(3)},volume='${bedVolume(bedRanges)}':eval=frame[bed]`,
        "[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[duck]",
        "[v][duck]amix=inputs=2:normalize=0:duration=first[out]",
      ].join(";"),
      "-map",
      "[out]",
      "-ac",
      "1",
      mixed,
    ]);
  } else {
    await ffmpeg(["-loglevel", "error", ...raw, mixed]);
  }

  const m = await measure(mixed);
  const meta = join(workDir, "metadata.txt");
  writeFileSync(meta, metadata(tags, chapters));
  const out = join(workDir, "episode.mp3");
  await ffmpeg([
    "-loglevel",
    "error",
    "-i",
    mixed,
    "-i",
    meta,
    "-map",
    "0:a",
    "-map_metadata",
    "1",
    "-map_chapters",
    "1",
    "-af",
    `${[
      `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`,
      `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}`,
      `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    ].join(":")},aresample=44100`,
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-id3v2_version",
    "3",
    out,
  ]);
  return { mp3: readFileSync(out), seconds: at, chapters };
}
