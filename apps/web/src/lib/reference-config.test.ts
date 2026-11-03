import { describe, expect, it } from "vitest";
import {
  entryPath,
  hasReference,
  nameOf,
  type ReferenceConfig,
  targetByKey,
  targetOf,
  targetPath,
} from "./reference-config.ts";

// A culture newsroom's Reference: the site must not assume AI's kinds.
const culture: ReferenceConfig = {
  nav: ["rising", "concert"],
  kinds: {
    artist: {
      path: "artists",
      layout: "profile",
      name: { tr: "Sanatçılar", en: "Artists" },
      one: { tr: "Sanatçı", en: "Artist" },
    },
    concert: {
      path: "concerts",
      layout: "timeline",
      name: { tr: "Konserler", en: "Concerts" },
      one: { tr: "Konser", en: "Concert" },
    },
  },
  lists: {
    rising: {
      path: "rising",
      kind: "artist",
      fact: "rising",
      name: { tr: "Yükselenler", en: "Rising artists" },
      one: { tr: "Yükselen", en: "Rising artist" },
    },
  },
};

describe("the Reference config", () => {
  it("resolves any newsroom's paths to its kinds and lists", () => {
    expect(targetOf(culture, "artists")).toMatchObject({ type: "kind", kindKey: "artist" });
    expect(targetOf(culture, "rising")).toMatchObject({ type: "list", kindKey: "artist" });
    expect(targetOf(culture, "papers")).toBeNull();
    const nav = (culture.nav ?? []).map((k) => targetByKey(culture, k));
    expect(nav.map((t) => t && targetPath(t))).toEqual([
      "/reference/rising",
      "/reference/concerts",
    ]);
  });

  it("puts profile entries on pages and timeline entries on their index", () => {
    expect(entryPath(culture, "artist", "sezen-aksu")).toBe("/reference/artists/sezen-aksu");
    expect(entryPath(culture, "concert", "2026-05-01-x")).toBe("/reference/concerts#2026-05-01-x");
    expect(entryPath(culture, "paper", "x")).toBeNull();
  });

  it("knows when a newsroom has no Reference, and falls back across languages", () => {
    expect(hasReference({ kinds: {} })).toBe(false);
    expect(hasReference(culture)).toBe(true);
    expect(nameOf({ tr: "Sanatçı" }, "en")).toBe("Sanatçı");
    expect(nameOf({ tr: "Sanatçı", en: "Artist" }, "en")).toBe("Artist");
  });
});
