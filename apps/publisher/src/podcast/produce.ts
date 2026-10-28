// One approved episode's audio (D109): after an editor approved the script (it is scheduled), code
// voices it line by line, mixes it with the series' cues, tags and signs it, stores it and records
// an Episode row and the TTS spend. Nothing here waits for a person; a failure holds the episode
// with the reason, and a retry reuses every line already voiced.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digitalSourceType,
  ISO_639_2,
  type Language,
  localDay,
  type PodcastAudioJob,
} from "@anr/core";
import { budgetState, type Client, type Pool, withNewsroom, writingLimit } from "@anr/db";
import type { Catalog, CatalogEntry } from "@anr/models";
import { type createRenderer, editedByPerson, hostName } from "@anr/render";
import { holdPublication } from "../hold.ts";
import { engineFor } from "./engine.ts";
import { type Block, type Clip, mixEpisode } from "./mix.ts";
import type { Signer } from "./sign.ts";
import type { MediaStore } from "./store.ts";
import { MAX_VOICES, type SpeechRequest, type TextToSpeech } from "./tts.ts";

export interface AudioDeps {
  pool: Pool;
  renderer: ReturnType<typeof createRenderer>;
  /**
   * The engine: fixed (tests, dry runs), or chosen per newsroom and language from the catalogue
   * (D113). Either way cached (cachedTts): a line already voiced costs nothing.
   */
  tts: TextToSpeech | { catalog: Catalog; make: (entry: CatalogEntry) => TextToSpeech };
  store: MediaStore;
  signer: Signer;
  configDir: string;
}

export type AudioOutcome = "ready" | "exists" | "held" | "not-scheduled";

const PAUSE_BETWEEN_LINES = 0.35;
const CUE_FILES = new Set(["sting", "transition", "bed-swell", "bed-out"]);

interface SeriesConfig {
  name?: Record<string, string>;
  hosts?: Record<string, Record<string, string>>;
  /** Per engine and language: a voice for each host and the narrator (D113). */
  engine_voices?: Record<string, Record<string, Record<string, string>>>;
  host_names?: Record<string, Record<string, string>>;
  narrator?: Record<string, string>;
}
interface Script {
  title: string;
  items: (
    | {
        segment: "news-recap";
        topics: { title: string; lines: { host: string; text: string }[] }[];
      }
    | {
        segment: "story";
        title: string;
        beats: {
          beat: string;
          lines: (
            | { speaker: string; text: string; direction?: string }
            | { cue: string; seconds?: number }
          )[];
        }[];
      }
  )[];
}
interface Loaded {
  status: string;
  format: string;
  language: Language;
  slot: Date;
  timezone: string;
  newsroom: string;
  newsroomName: string;
  seriesSlug: string;
  config: SeriesConfig;
  renditionId: string;
  body: Script;
}

async function load(client: Client, id: string): Promise<Loaded | null> {
  const { rows } = await client.query<Loaded>(
    `select p.status, f.slug as format, p.language, p.slot, n.timezone, n.slug as newsroom,
            coalesce(n.name->>p.language, n.slug) as "newsroomName", s.slug as "seriesSlug",
            s.config, r.id as "renditionId", r.body
     from publications p join series s on s.id = p.series_id join formats f on f.id = s.format_id
     join newsrooms n on n.id = p.newsroom_id
     join publication_renditions pr on pr.publication_id = p.id and pr.position = 1
     join renditions r on r.id = pr.rendition_id
     where p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** What the audio is made from: a change to any of it is a new episode file. */
export function scriptHash(
  l: Pick<Loaded, "body" | "config" | "language">,
  edited: boolean,
  model: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        l.body,
        l.config.hosts?.[l.language],
        l.config.narrator?.[l.language],
        l.config.name?.[l.language],
        edited,
        model,
      ]),
    )
    .digest("hex");
}

/** The episode's blocks, with each line still to be voiced. */
/**
 * Each speaker's voice for the engine: the series' `engine_voices` for it, else, for the engine
 * the host voices were written for (the default, Gemini), `hosts` and `narrator`; a local engine
 * without voices set gives each speaker its own default voice (`default:<speaker>`).
 */
export function voicesFor(
  config: SeriesConfig,
  language: string,
  engine: { id: string; local: boolean },
): (speaker: string) => string | undefined {
  const own = config.engine_voices?.[engine.id]?.[language];
  return (speaker) => {
    if (own?.[speaker]) return own[speaker];
    if (engine.local) return `default:${speaker}`;
    return speaker === "narrator"
      ? config.narrator?.[language]
      : config.hosts?.[language]?.[speaker];
  };
}

export function plan(
  l: Pick<Loaded, "body" | "config" | "language" | "seriesSlug">,
  intro: { speaker: string; text: string }[],
  audioDir: string,
  batch: "line" | "segment" = "line",
  voiceOf: (speaker: string) => string | undefined = voicesFor(l.config, l.language, {
    id: "",
    local: false,
  }),
): {
  blocks: { chapter?: string; bed?: boolean; items: (SpeechRequest | Clip)[] }[];
  voices: Set<string>;
} {
  const voices = new Set<string>();
  const voice = (speaker: string): string => {
    const v = voiceOf(speaker);
    if (!v) throw new Error(`no voice for ${speaker} in ${l.language}`);
    voices.add(v);
    return v;
  };
  const say = (speaker: string, text: string, direction?: string): (SpeechRequest | Clip)[] => [
    { text, speaker, voice: voice(speaker), language: l.language, ...(direction && { direction }) },
    { kind: "silence", seconds: PAUSE_BETWEEN_LINES, gap: true },
  ];
  const file = (name: string): Clip => ({ kind: "file", path: join(audioDir, `${name}.flac`) });
  const blocks: { chapter?: string; bed?: boolean; items: (SpeechRequest | Clip)[] }[] = [
    {
      chapter: l.body.title,
      items: [file("jingle"), ...intro.flatMap((i) => say(i.speaker, i.text))],
    },
  ];
  for (const item of l.body.items) {
    if (item.segment === "news-recap") {
      // Voiced a segment at a time, topics share one clip: one chapter for the recap (D112).
      if (batch === "segment") {
        blocks.push({
          chapter: item.topics
            .map((t) => t.title)
            .join(" · ")
            .slice(0, 200),
          items: item.topics.flatMap((t) => t.lines.flatMap((ln) => say(ln.host, ln.text))),
        });
      } else {
        for (const topic of item.topics)
          blocks.push({
            chapter: topic.title,
            items: topic.lines.flatMap((ln) => say(ln.host, ln.text)),
          });
      }
      continue;
    }
    const items: (SpeechRequest | Clip)[] = [];
    for (const beat of item.beats) {
      for (const ln of beat.lines) {
        if ("text" in ln) items.push(...say(ln.speaker, ln.text, ln.direction));
        else if (ln.cue === "pause") items.push({ kind: "silence", seconds: ln.seconds ?? 1 });
        else if (CUE_FILES.has(ln.cue)) items.push(file(ln.cue));
      }
    }
    blocks.push({ chapter: item.title, bed: true, items });
  }
  blocks.push({ items: [file("jingle")] });
  return { blocks, voices };
}

/** Words one request may hold: well under the output cap (about ten minutes of speech). */
export const MAX_REQUEST_WORDS = 1200;

/**
 * A block's items as requests (plan B, D112): consecutive lines join one request until a third
 * voice, the word limit or a cue; the pauses between them are left to the model.
 */
export function requests(
  items: readonly (SpeechRequest | Clip)[],
  maxVoices = MAX_VOICES,
  maxWords = MAX_REQUEST_WORDS,
): (SpeechRequest[] | Clip)[] {
  const out: (SpeechRequest[] | Clip)[] = [];
  let turns: SpeechRequest[] = [];
  let words = 0;
  const flush = () => {
    if (turns.length > 0) out.push(turns);
    turns = [];
    words = 0;
  };
  for (const item of items) {
    if ("kind" in item) {
      if (item.kind === "silence" && item.gap) continue;
      flush();
      out.push(item);
      continue;
    }
    const voices = new Set([...turns.map((t) => t.voice), item.voice]);
    const n = item.text.split(/\s+/).length;
    if (voices.size > maxVoices || (turns.length > 0 && words + n > maxWords)) flush();
    turns.push(item);
    words += n;
  }
  flush();
  return out;
}

export async function produceEpisode(deps: AudioDeps, job: PodcastAudioJob): Promise<AudioOutcome> {
  const inNewsroom = <T>(fn: (c: Client) => Promise<T>) =>
    withNewsroom(deps.pool, job.newsroomId, fn);
  const prepared = await inNewsroom(async (c) => {
    const l = await load(c, job.publicationId);
    if (l?.status !== "scheduled" || l.format !== "podcast-episode") return null;
    const edited = await editedByPerson(c, job.publicationId, [l.renditionId]);
    let tts: TextToSpeech;
    let engine = { id: "", local: false };
    if ("synthesize" in deps.tts) tts = deps.tts;
    else {
      const choice = await engineFor(c, deps.tts.catalog, l.language);
      if (!choice.ok) {
        await holdPublication(c, job.publicationId, {
          name: "tts-engine",
          result: "error",
          detail: { reason: choice.reason },
        });
        return { held: true as const };
      }
      tts = deps.tts.make(choice.engine);
      engine = { id: choice.engine.id, local: choice.engine.kind === "local-tts" };
    }
    // Another engine or other voices make other audio.
    const hash = scriptHash(
      l,
      edited,
      `${tts.model}:${JSON.stringify(l.config.engine_voices ?? {})}`,
    );
    const { rowCount } = await c.query(
      "select from episodes where publication_id = $1 and script_hash = $2",
      [job.publicationId, hash],
    );
    if (rowCount) return { done: true as const };
    // TTS is writing spend: it stops at the writing limit like the desk (D76).
    const budget = await budgetState(c);
    if (budget.spentUsd >= writingLimit(budget)) {
      await holdPublication(c, job.publicationId, {
        name: "budget",
        result: "error",
        detail: { reason: `the writing budget for ${budget.month} is spent` },
      });
      return { held: true as const };
    }
    return { l, edited, hash, tts, engine };
  });
  if (!prepared) return "not-scheduled";
  if ("done" in prepared) return "exists";
  if ("held" in prepared) return "held";
  const { l, edited, hash, tts, engine } = prepared;

  const work = mkdtempSync(join(tmpdir(), "anr-episode-"));
  const spend = { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
  try {
    const series = l.config.name?.[l.language] ?? l.seriesSlug;
    const hostNames = Object.keys(l.config.hosts?.[l.language] ?? {});
    const intro = await deps.renderer.introLines(
      l.language,
      series,
      hostNames,
      Boolean(l.config.narrator?.[l.language]),
      l.config.host_names?.[l.language],
    );
    const audioDir = join(deps.configDir, "newsrooms", l.newsroom, "audio", l.seriesSlug);
    const { blocks: planned } = plan(
      l,
      intro,
      audioDir,
      tts.batch,
      engine.id ? voicesFor(l.config, l.language, engine) : undefined,
    );
    const blocks: Block[] = [];
    for (const b of planned) {
      const clips: Clip[] = [];
      const steps = tts.batch === "segment" ? requests(b.items) : b.items;
      for (const item of steps) {
        if (!Array.isArray(item) && "kind" in item) {
          clips.push(item);
          continue;
        }
        const speech = Array.isArray(item)
          ? await tts.synthesizeTurns(item)
          : await tts.synthesize(item);
        if (!speech.cached) spend.calls += 1;
        spend.tokensIn += speech.tokensIn;
        spend.tokensOut += speech.tokensOut;
        spend.costUsd += speech.costUsd;
        clips.push({ kind: "speech", pcm: speech.pcm, sampleRate: speech.sampleRate });
      }
      blocks.push({ chapter: b.chapter, bed: b.bed, clips });
    }
    const label = await deps.renderer.disclosureLabel(l.language, edited);
    const voices = `${hostNames.map((h) => hostName(h, l.config.host_names?.[l.language])).join(", ")}${l.config.narrator?.[l.language] ? ", narrator" : ""}`;
    const mixed = await mixEpisode(
      blocks,
      join(audioDir, "bed.flac"),
      {
        title: l.body.title,
        artist: l.newsroomName,
        album: series,
        date: localDay(l.slot, l.timezone),
        language: ISO_639_2[l.language],
        comment: `${label}. AI voices: ${voices}.`,
      },
      work,
    );
    const source = digitalSourceType(edited).uri;
    const signed = await deps.signer.sign(mixed.mp3, source, l.body.title, work);
    const key = `episodes/${job.publicationId}/${hash.slice(0, 16)}.mp3`;
    await deps.store.put(key, signed.mp3, "audio/mpeg");
    await inNewsroom(async (c) => {
      await c.query(
        `insert into episodes (newsroom_id, publication_id, rendition_id, script_hash, media_key, bytes,
                               seconds, chapters, digital_source_type, signed)
         values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (publication_id, script_hash) do nothing`,
        [
          job.publicationId,
          l.renditionId,
          hash,
          key,
          signed.mp3.length,
          mixed.seconds.toFixed(2),
          JSON.stringify(mixed.chapters),
          source,
          signed.signed,
        ],
      );
      await recordTts(c, tts, job.publicationId, hash, spend, "submitted");
    });
    return "ready";
  } catch (error) {
    await inNewsroom(async (c) => {
      await recordTts(c, tts, job.publicationId, hash, spend, "error", (error as Error).message);
      await holdPublication(c, job.publicationId, {
        name: "audio",
        result: "error",
        detail: { error: (error as Error).message.slice(0, 2000) },
      });
    });
    return "held";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Every TTS call is a priced model call: one Agent run row per attempt, cached lines free (D106). */
async function recordTts(
  c: Client,
  tts: TextToSpeech,
  publicationId: string,
  hash: string,
  spend: { tokensIn: number; tokensOut: number; costUsd: number; calls: number },
  outcome: "submitted" | "error",
  error?: string,
) {
  await c.query(
    `insert into agent_runs (newsroom_id, role, provider, model, prompt_version, input_hash, tokens_in,
                             tokens_out, cost_usd, outcome, finished_at, task, detail)
     values (anr.current_newsroom_id(), 'tts', $1, $2, 'tts', $3, $4, $5, $6, $7, now(), $8, $9)`,
    [
      tts.provider,
      tts.model,
      hash,
      spend.tokensIn,
      spend.tokensOut,
      spend.costUsd,
      outcome,
      JSON.stringify({
        key: `tts:${publicationId}:${hash.slice(0, 16)}`,
        publication_id: publicationId,
      }),
      JSON.stringify({ calls: spend.calls, ...(error && { error: error.slice(0, 2000) }) }),
    ],
  );
}
