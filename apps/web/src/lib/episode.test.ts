import { describe, expect, it } from "vitest";
import {
  chaptersOf,
  clock,
  episodeView,
  initial,
  localDigits,
  parseTranscript,
  sectionTitle,
  speakerColours,
  timeTurns,
} from "./episode.ts";

const transcript = [
  "# اتاق خبر، ۲۲ اکتبر",
  "<!-- Imported from PR #9.",
  "Arc: cold open -> ordinary world",
  "-->",
  "## بخش ۱: شروع ثابت (نیلوفر)",
  "نیلوفر: سلام، این اتاق خبر است.",
  "یک خط بی‌گوینده، نه یک گفته.",
  "## بخش ۲: مقاله‌ها، پروب (نیلوفر و فرزاد)",
  "فرزاد: پروب چیست؟",
  "نیلوفر: یک روش تازه.",
  "",
  "## بخشی بی‌گفته",
].join("\n");

const chapters = [
  { title: "شروع ثابت", start: 0, end: 10 },
  { title: "مقاله‌ها، پروب", start: 10, end: 40 },
];

describe("sectionTitle", () => {
  it("drops the part number and the speakers", () => {
    expect(sectionTitle("بخش ۳: مقاله‌ها، پروب (نیلوفر و فرزاد)")).toBe("مقاله‌ها، پروب");
    expect(sectionTitle("بخش 2: شروع ثابت")).toBe("شروع ثابت");
    expect(sectionTitle("اگه، وگرنه: شرطی که خودش مقدار داره")).toBe(
      "اگه، وگرنه: شرطی که خودش مقدار داره",
    );
  });
});

describe("parseTranscript", () => {
  it("reads speaker turns under their sections, skipping comments, titles and other lines", () => {
    const sections = parseTranscript(transcript, chapters);
    expect(sections.map((s) => s.title)).toEqual(["شروع ثابت", "مقاله‌ها، پروب"]);
    expect(sections.flatMap((s) => s.turns.map((t) => t.speaker))).toEqual([
      "نیلوفر",
      "فرزاد",
      "نیلوفر",
    ]);
    expect(sections[1]?.turns[0]?.text).toBe("پروب چیست؟");
  });

  it("matches sections to chapters one to one when the counts agree", () => {
    const renamed = chapters.map((c, i) => ({ ...c, title: `chapter ${i}` }));
    expect(parseTranscript(transcript, renamed).map((s) => s.chapter)).toEqual([0, 1]);
  });

  it("matches by title when the counts differ, and leaves the rest unmatched", () => {
    const [opening, probe] = chapters;
    const three = [probe, { title: "other", start: 40, end: 50 }, opening].filter((c) => !!c);
    expect(parseTranscript(transcript, three).map((s) => s.chapter)).toEqual([2, 0]);
    const one = [{ title: "other", start: 0, end: 5 }];
    expect(parseTranscript(transcript, one).map((s) => s.chapter)).toEqual([null, null]);
  });

  it("puts turns before any heading in an untitled section", () => {
    const sections = parseTranscript("A: one\nB: two\nA: three\nB: four");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("");
    expect(sections[0]?.turns).toHaveLength(4);
  });
});

describe("timeTurns", () => {
  it("shares each chapter's span among its turns by length", () => {
    const sections = parseTranscript(transcript, chapters);
    timeTurns(sections, chapters, 40);
    const [first, second] = sections;
    expect(first?.turns[0]).toMatchObject({ start: 0, end: 10 });
    const [a, b] = second?.turns ?? [];
    expect(a?.start).toBe(10);
    expect(a?.end).toBe(b?.start);
    expect(b?.end).toBe(40);
    expect((a?.end ?? 0) > 10 && (a?.end ?? 0) < 40).toBe(true);
  });

  it("leaves turns without a chapter untimed", () => {
    const first = [{ title: "شروع ثابت", start: 0, end: 10 }];
    const sections = parseTranscript(transcript, first);
    timeTurns(sections, first, 40);
    expect(sections[1]?.turns.every((t) => t.start === null && t.end === null)).toBe(true);
  });
});

describe("chaptersOf", () => {
  it("prefers the recorded chapters and reads numeric strings", () => {
    expect(chaptersOf([{ title: "a", start: "1.5", end: "3" }], { chapters })).toEqual([
      { title: "a", start: 1.5, end: 3 },
    ]);
    expect(chaptersOf([], { chapters })).toEqual(chapters);
    expect(chaptersOf(null, {})).toEqual([]);
  });
});

describe("clock and digits", () => {
  it("writes minutes and seconds, and hours past an hour", () => {
    expect(clock(336.4)).toBe("05:36");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(-3)).toBe("00:00");
  });

  it("uses the page language's digits", () => {
    expect(localDigits("fa")("05:36")).toBe("۰۵:۳۶");
    expect(localDigits("en")("05:36")).toBe("05:36");
  });
});

describe("episodeView", () => {
  it("colours the speaker who speaks most first", () => {
    const view = episodeView({
      rendition: { transcript, summary: "s", chapters },
      audioUrl: "/a/x.mp3",
      seconds: 40,
      chapters: [],
    });
    expect(view.speakers).toEqual({ نیلوفر: 1, فرزاد: 2 });
    expect(view.summary).toBe("s");
    expect(view.sections[0]?.turns[0]?.start).toBe(0);
    expect(speakerColours([])).toEqual({});
  });

  it("has no transcript for a produced episode's script", () => {
    const view = episodeView({
      rendition: { title: "t", items: [{ segment: "story" }] },
      audioUrl: "/a/x.mp3",
      seconds: 60,
      chapters: [{ title: "Story", start: 0, end: 60 }],
    });
    expect(view.sections).toEqual([]);
    expect(view.chapters).toHaveLength(1);
  });
});

describe("initial", () => {
  it("is the speaker's first letter without diacritics", () => {
    expect(initial("اِبی")).toBe("ا");
    expect(initial("Maya")).toBe("M");
  });
});
