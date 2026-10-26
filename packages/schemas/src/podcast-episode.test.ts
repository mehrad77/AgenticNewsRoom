import { describe, expect, it } from "vitest";
import { PodcastEpisodeDraftSchema } from "./generated/index.ts";

const line = (speaker: string, text: string, claim_ids: string[] = []) => ({
  speaker,
  text,
  claim_ids,
});

const storySegment = {
  segment: "story",
  protagonists: [{ name: "Ashish Vaswani", role: "first author", claim_ids: ["c1"] }],
  beats: [
    {
      beat: "cold-open",
      lines: [line("narrator", "Eight researchers, one title.", ["c2"]), { cue: "sting" }],
    },
    {
      beat: "context",
      lines: [line("maya", "Before 2017, translation models read word by word.", ["c3"])],
    },
    {
      beat: "turning-point",
      lines: [
        {
          ...line("leo", "Vaswani's team dropped recurrence entirely.", ["c1", "c4"]),
          direction: "slower",
        },
      ],
    },
    {
      beat: "stakes",
      lines: [line("maya", "If attention alone worked, training could run in parallel.", ["c5"])],
    },
    {
      beat: "resolution",
      lines: [line("narrator", "Vaswani's model beat every benchmark it was tested on.", ["c6"])],
    },
    {
      beat: "takeaway",
      lines: [{ cue: "pause", seconds: 1 }, line("leo", "Simple ideas travel far.")],
    },
  ],
};

const draft = (items: unknown[]) => ({ rendition: { language: "en", title: "Attention", items } });

describe("podcast-episode draft schema", () => {
  it("accepts a news recap and a story told as an arc", () => {
    const recap = {
      segment: "news-recap",
      lines: [{ host: "maya", text: "Three launches this week.", claim_ids: ["c7"] }],
    };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([recap, storySegment])).success).toBe(true);
  });

  it("rejects a story without protagonists", () => {
    const { protagonists: _, ...noCast } = storySegment;
    expect(PodcastEpisodeDraftSchema.safeParse(draft([noCast])).success).toBe(false);
  });

  it("rejects an unknown beat or cue", () => {
    const badBeat = {
      ...storySegment,
      beats: [...storySegment.beats, { beat: "epilogue", lines: [line("leo", "x")] }],
    };
    const badCue = {
      ...storySegment,
      beats: [{ beat: "cold-open", lines: [{ cue: "song-clip" }] }, ...storySegment.beats.slice(1)],
    };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([badBeat])).success).toBe(false);
    expect(PodcastEpisodeDraftSchema.safeParse(draft([badCue])).success).toBe(false);
  });

  it("keeps cues and directions out of news recaps", () => {
    const recap = { segment: "news-recap", lines: [{ cue: "sting" }] };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([recap])).success).toBe(false);
  });
});
