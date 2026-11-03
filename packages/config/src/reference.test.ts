import type { ReferenceSchema } from "@anr/schemas";
import { describe, expect, it } from "vitest";
import { referenceProblems } from "./reference.ts";

// A culture newsroom's Reference: nothing in the platform assumes AI's kinds.
const culture: ReferenceSchema = {
  nav: ["artists", "venues"],
  kinds: {
    artist: {
      path: "artists",
      layout: "profile",
      name: { tr: "Sanatçılar", en: "Artists" },
      one: { tr: "Sanatçı", en: "Artist" },
    },
    venue: {
      path: "venues",
      layout: "profile",
      name: { tr: "Mekânlar", en: "Venues" },
      one: { tr: "Mekân", en: "Venue" },
    },
  },
  lists: {
    artists: {
      path: "rising",
      kind: "artist",
      fact: "rising",
      name: { tr: "Yükselenler", en: "Rising artists" },
      one: { tr: "Yükselen", en: "Rising artist" },
    },
  },
};

describe("referenceProblems", () => {
  it("accepts any newsroom's kinds", () => {
    expect(
      referenceProblems({ ...culture, lists: {}, nav: ["artist"] }, ["tr", "en"], "r"),
    ).toEqual([]);
  });

  it("finds missing languages, clashing paths and unknown names", () => {
    const problems = referenceProblems(
      {
        ...culture,
        kinds: {
          ...culture.kinds,
          venue: { ...culture.kinds.venue, path: "artists", filters: [] } as never,
        },
      },
      ["tr", "en", "fa"],
      "r",
    );
    expect(problems).toContain("r kind artist name has no fa");
    expect(problems).toContain("r kind venue reuses the path artists of kind artist");
    expect(problems).toContain("r kind venue has filters but is not a timeline");
    expect(
      referenceProblems(
        { ...culture, lists: { artist: culture.lists!.artists! } },
        ["tr", "en"],
        "r",
      ),
    ).toContain("r list artist has the name of a kind");
    expect(problems.some((p) => p.includes("nav names venues"))).toBe(true);
  });
});
