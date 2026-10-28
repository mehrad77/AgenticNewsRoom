import { describe, expect, it } from "vitest";
import { PodcastEpisodeDraftSchema } from "./generated/index.ts";

const line = (speaker: string, text: string) => ({ speaker, text });

// Each beat and recap topic lists the claims its lines rely on (D107).
const storySegment = {
  segment: "story",
  title: "Attention",
  protagonists: [{ name: "Ashish Vaswani", role: "first author", claim_ids: ["c1"] }],
  beats: [
    {
      beat: "cold-open",
      claim_ids: ["c2"],
      lines: [line("narrator", "Eight researchers, one title."), { cue: "sting" }],
    },
    {
      beat: "context",
      claim_ids: ["c3"],
      lines: [line("maya", "Before 2017, translation models read word by word.")],
    },
    {
      beat: "turning-point",
      claim_ids: ["c1", "c4"],
      lines: [
        { ...line("leo", "Vaswani's team dropped recurrence entirely."), direction: "slower" },
      ],
    },
    {
      beat: "stakes",
      claim_ids: ["c5"],
      lines: [line("maya", "If attention alone worked, training could run in parallel.")],
    },
    {
      beat: "resolution",
      claim_ids: ["c6"],
      lines: [line("narrator", "Vaswani's model beat every benchmark it was tested on.")],
    },
    {
      beat: "takeaway",
      claim_ids: ["c6"],
      lines: [{ cue: "pause", seconds: 1 }, line("leo", "Simple ideas travel far.")],
    },
  ],
};

const recap = {
  segment: "news-recap",
  topics: [
    {
      title: "Three launches",
      claim_ids: ["c7"],
      lines: [{ host: "maya", text: "Three launches this week." }],
    },
  ],
};

const draft = (items: unknown[]) => ({ rendition: { language: "en", title: "Attention", items } });

describe("podcast-episode draft schema", () => {
  it("accepts a news recap and a story told as an arc", () => {
    expect(PodcastEpisodeDraftSchema.safeParse(draft([recap, storySegment])).success).toBe(true);
  });

  it("rejects a story without protagonists, and a beat without claims", () => {
    const { protagonists: _, ...noCast } = storySegment;
    expect(PodcastEpisodeDraftSchema.safeParse(draft([noCast])).success).toBe(false);
    const bare = {
      ...storySegment,
      beats: [{ ...storySegment.beats[0], claim_ids: [] }, ...storySegment.beats.slice(1)],
    };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([bare])).success).toBe(false);
  });

  it("rejects an unknown beat or cue", () => {
    const badBeat = {
      ...storySegment,
      beats: [
        ...storySegment.beats,
        { beat: "epilogue", claim_ids: ["c1"], lines: [line("leo", "x")] },
      ],
    };
    const badCue = {
      ...storySegment,
      beats: [
        { beat: "cold-open", claim_ids: ["c1"], lines: [{ cue: "song-clip" }] },
        ...storySegment.beats.slice(1),
      ],
    };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([badBeat])).success).toBe(false);
    expect(PodcastEpisodeDraftSchema.safeParse(draft([badCue])).success).toBe(false);
  });

  it("keeps cues and directions out of news recaps", () => {
    const cued = {
      ...recap,
      topics: [{ title: "x", claim_ids: ["c1"], lines: [{ cue: "sting" }] }],
    };
    expect(PodcastEpisodeDraftSchema.safeParse(draft([cued])).success).toBe(false);
  });
});
