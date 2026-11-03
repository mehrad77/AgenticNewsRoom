import { describe, expect, it } from "vitest";
import { isExternal, markExternalLinks } from "./external-links.ts";

describe("markExternalLinks", () => {
  it("marks links that leave the site, and leaves the site's own alone", () => {
    const html =
      '<p><a href="https://openai.com/x?a=1&amp;b=2">OpenAI</a> and <a href="https://ai.example.org/en/reference">ours</a> and <a href="#c1">a note</a></p>';
    const out = markExternalLinks(html, "ai.example.org", "(opens in a new tab)");
    expect(out).toContain(
      '<a class="external-link" href="https://openai.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"><bdi>OpenAI</bdi><svg class="icon external-link-icon"',
    );
    expect(out).toContain('<span class="visually-hidden"> (opens in a new tab)</span></a>');
    expect(out).toContain('<a href="https://ai.example.org/en/reference">ours</a>');
    expect(out).toContain('<a href="#c1">a note</a>');
  });

  it("keeps a link's other attributes and does not mark a link twice", () => {
    const once = markExternalLinks(
      '<a class="lead" href="https://x.org" rel="nofollow">x</a>',
      "ai.example.org",
      "",
    );
    expect(once).toMatch(/^<a class="lead external-link" href="https:\/\/x.org" target="_blank"/);
    expect(markExternalLinks(once, "ai.example.org", "")).toBe(once);
  });

  it("knows a site's own host", () => {
    expect(isExternal("https://ai.example.org/x", "ai.example.org")).toBe(false);
    expect(isExternal("https://example.org/x", "ai.example.org")).toBe(true);
    expect(isExternal("not a url", "ai.example.org")).toBe(false);
  });
});
