import { describe, expect, it } from "vitest";
import { pageUrl, publicationPath, siteOrigin } from "./sites.ts";

const site = { subdomain: "ai", rootDomain: "example.org", languages: ["fa", "en"] as const };

describe("site addresses", () => {
  it("serve the primary language at / and others under a prefix", () => {
    expect(pageUrl(site, "fa")).toBe("https://ai.example.org/");
    expect(pageUrl(site, "en")).toBe("https://ai.example.org/en");
    expect(pageUrl(site, "en", "/daily/2026-10-27")).toBe(
      "https://ai.example.org/en/daily/2026-10-27",
    );
  });

  it("use http and the dev port on localhost", () => {
    expect(siteOrigin({ ...site, rootDomain: "localhost", devPort: 4400 })).toBe(
      "http://ai.localhost:4400",
    );
  });

  it("date a publication in its newsroom's timezone", () => {
    const slot = new Date("2026-10-27T22:30:00Z");
    expect(publicationPath("daily-newsletter", slot, "Europe/Istanbul")).toBe(
      "/daily-newsletter/2026-10-28",
    );
    expect(publicationPath("daily-newsletter", slot, "UTC")).toBe("/daily-newsletter/2026-10-27");
  });
});
