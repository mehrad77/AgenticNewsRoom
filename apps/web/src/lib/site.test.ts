import { describe, expect, it } from "vitest";
import { resolveSite, type SiteNewsroom } from "./site.ts";

const newsrooms: SiteNewsroom[] = [
  { slug: "ai", subdomain: "ai", languages: ["fa", "en"], name: {} },
  { slug: "kultur", subdomain: "kultur", languages: ["tr", "en", "fa"], name: {} },
];

describe("resolveSite", () => {
  it("serves the primary language without a prefix", () => {
    const site = resolveSite("ai.example.org", "/", "example.org", newsrooms);
    expect(site).toMatchObject({ kind: "newsroom", language: "fa", direction: "rtl", path: "/" });
  });

  it("serves other languages under /<lang>", () => {
    const site = resolveSite("kultur.example.org:443", "/fa/artists", "example.org", newsrooms);
    expect(site).toMatchObject({ language: "fa", direction: "rtl", path: "/artists" });
    expect(resolveSite("kultur.example.org", "/en", "example.org", newsrooms)).toMatchObject({
      language: "en",
      direction: "ltr",
      path: "/",
    });
  });

  it("routes desk and rejects unknown hosts", () => {
    expect(resolveSite("desk.example.org", "/", "example.org", newsrooms)).toEqual({
      kind: "desk",
    });
    expect(resolveSite("nope.example.org", "/", "example.org", newsrooms)).toEqual({
      kind: "unknown",
    });
    expect(resolveSite("example.com", "/", "example.org", newsrooms)).toEqual({ kind: "unknown" });
  });
});
