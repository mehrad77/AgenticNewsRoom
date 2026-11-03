// An episode's page (D180): its chapters, its transcript as speaker turns under chapter headings,
// and when each turn is spoken, for the player and the transcript sync. Ported from the old
// archive's episode page (D177); plain TypeScript, so EpisodePage.astro only lays it out.
import type { Language } from "@anr/core";

/** A chapter as the episodes row (and an imported rendition) records it: seconds into the audio. */
export interface Chapter {
  title: string;
  start: number;
  end: number;
}

export interface Turn {
  speaker: string;
  text: string;
  /** Estimated by timeTurns(); null when the section has no chapter to anchor it. */
  start: number | null;
  end: number | null;
}

export interface TranscriptSection {
  /** The «## » heading as written. */
  label: string;
  /** The heading shown: without «بخش N:» and the trailing «(speakers)». */
  title: string;
  /** The chapter the section is, or null. */
  chapter: number | null;
  turns: Turn[];
}

export interface EpisodeView {
  audioUrl: string;
  seconds: number;
  chapters: Chapter[];
  /** Empty when the episode has no transcript (a produced episode's script is not one). */
  sections: TranscriptSection[];
  /** Each speaker's colour, 1 to 8 (speakerColours). */
  speakers: Record<string, number>;
  summary: string | null;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

/** Chapters from the episodes row, else the rendition's own (an imported episode, D177). */
export function chaptersOf(recorded: unknown, rendition: Record<string, unknown>): Chapter[] {
  const from = (list: unknown): Chapter[] =>
    (Array.isArray(list) ? list : []).flatMap((c) => {
      const x = c as { title?: unknown; start?: unknown; end?: unknown };
      const start = num(x.start);
      const end = num(x.end);
      if (typeof x.title !== "string" || !Number.isFinite(start)) return [];
      return [{ title: x.title, start, end: Number.isFinite(end) ? end : start }];
    });
  const own = from(recorded);
  return own.length > 0 ? own : from(rendition.chapters);
}

/** «بخش ۳: مقاله‌ها، پروب (نیلوفر و فرزاد)» -> «مقاله‌ها، پروب»: the chapter's own name. */
export function sectionTitle(label: string): string {
  const t = label
    .trim()
    .replace(/^بخش\s*[0-9۰-۹٠-٩]+\s*[:：]\s*/, "")
    .replace(/\s*\([^()]*\)\s*$/, "");
  return t.trim() || label.trim();
}

const TURN = /^\s*([^\s:：]+)\s*[:：]\s*(.+?)\s*$/;

/** The transcript's lines outside HTML comments. */
function visibleLines(md: string): string[] {
  const out: string[] = [];
  let inComment = false;
  for (const line of md.split("\n")) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.trimStart().startsWith("<!--")) {
      inComment = !line.includes("-->");
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Parse a transcript («## » sections of «Speaker: text» lines) into sections of turns, matched to
 * chapters: one per section when the counts match, else by title. A turn is a line that starts
 * with a one-word label and a colon, so no newsroom's host names are needed; a note written that
 * way would read as a turn, which no transcript has.
 */
export function parseTranscript(md: string, chapters: Pick<Chapter, "title">[] = []) {
  const lines = visibleLines(md);
  const sections: TranscriptSection[] = [];
  let current: TranscriptSection | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const label = line.slice(3).trim();
      current = { label, title: sectionTitle(label), chapter: null, turns: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("#")) continue;
    const m = TURN.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (!current) {
      current = { label: "", title: "", chapter: null, turns: [] };
      sections.push(current);
    }
    current.turns.push({ speaker: m[1], text: m[2], start: null, end: null });
  }
  const out = sections.filter((s) => s.turns.length > 0);
  for (const [i, s] of out.entries()) {
    if (out.length === chapters.length) s.chapter = i;
    else {
      const j = chapters.findIndex((c) => c.title === s.title);
      s.chapter = j >= 0 ? j : null;
    }
  }
  return out;
}

/**
 * Estimate when each turn is spoken. Only chapters are recorded, so each chapter's span is shared
 * out among its turns by text length, plus an allowance for the pause between turns. Turns of a
 * section without a chapter stay null and are not synced.
 */
export function timeTurns(sections: TranscriptSection[], chapters: Chapter[], seconds: number) {
  const PAUSE_CHARS = 12;
  const byChapter = new Map<number, Turn[]>();
  for (const s of sections) {
    for (const t of s.turns) t.start = t.end = null;
    if (s.chapter === null || !chapters[s.chapter]) continue;
    byChapter.set(s.chapter, [...(byChapter.get(s.chapter) ?? []), ...s.turns]);
  }
  for (const [i, turns] of byChapter) {
    const chapter = chapters[i] as Chapter;
    const start = chapter.start;
    const next = chapters[i + 1]?.start;
    const end = Math.max(start, chapter.end > start ? chapter.end : (next ?? seconds));
    const weights = turns.map((t) => t.text.length + PAUSE_CHARS);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = start;
    for (const [j, t] of turns.entries()) {
      t.start = Math.round(at * 10) / 10;
      at += ((end - start) * (weights[j] ?? 0)) / total;
      t.end = j === turns.length - 1 ? end : Math.round(at * 10) / 10;
    }
  }
}

/** Each speaker's colour, 1 to 8: the one who speaks most first, ties in the order they speak. */
export function speakerColours(sections: TranscriptSection[]): Record<string, number> {
  const turns = new Map<string, number>();
  for (const s of sections)
    for (const t of s.turns) turns.set(t.speaker, (turns.get(t.speaker) ?? 0) + 1);
  const ranked = [...turns.keys()].sort((a, b) => (turns.get(b) ?? 0) - (turns.get(a) ?? 0));
  return Object.fromEntries(ranked.map((speaker, i) => [speaker, (i % 8) + 1]));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 336.4 -> «05:36» (h:mm:ss past an hour), in ASCII digits. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  return h
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** The page language's digits in place of ASCII ones: «05:36» -> «۰۵:۳۶» in Persian. */
export function localDigits(language: Language): (text: string | number) => string {
  const f = new Intl.NumberFormat(language, { useGrouping: false });
  return (text) => String(text).replace(/[0-9]/g, (d) => f.format(Number(d)));
}

/** Everything the episode page shows: the player's chapters and the timed transcript. */
export function episodeView(input: {
  rendition: Record<string, unknown>;
  audioUrl: string;
  seconds: number;
  chapters: unknown;
}): EpisodeView {
  const chapters = chaptersOf(input.chapters, input.rendition);
  const transcript =
    typeof input.rendition.transcript === "string" ? input.rendition.transcript : "";
  const sections = parseTranscript(transcript, chapters);
  timeTurns(sections, chapters, input.seconds);
  return {
    audioUrl: input.audioUrl,
    seconds: input.seconds,
    chapters,
    sections,
    speakers: speakerColours(sections),
    summary: typeof input.rendition.summary === "string" ? input.rendition.summary : null,
  };
}

/** A speaker's initial for their avatar, without its diacritics: «اِبی» -> «ا». */
export const initial = (speaker: string) =>
  speaker.normalize("NFD").replace(/\p{M}/gu, "").charAt(0);
