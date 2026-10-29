import { describe, expect, it } from "vitest";
import {
  CHANNEL_LIMITS,
  createRenderer,
  introProblems,
  occurrences,
  opinionItems,
  splitParts,
  unmarkOpinion,
  visibleLength,
} from "./index.ts";

const renderer = createRenderer();
const rendition = {
  title: "Today in AI",
  items: [{ kind: "news", headline: "A headline", body: "A body.", claim_ids: ["c1"] }],
};

describe("channel templates", () => {
  it("give the disclosure label alone, per language", async () => {
    expect(await renderer.disclosureLabel("en")).toBe("AI-made");
    expect(await renderer.disclosureLabel("fa", true)).toBe(
      "ساخته‌شده با هوش مصنوعی، ویراسته‌ی یک انسان",
    );
  });

  it("label every Telegram post as AI-made", async () => {
    const out = await renderer.render("newsletter-issue", "telegram", "en", {
      rendition,
      edited: false,
      site_url: "https://ai.example.test/en",
    });
    expect(out).toContain("AI-made");
    expect(out).toContain("A headline");
  });

  it("switch the label once an editor changed the text", async () => {
    const out = await renderer.render("newsletter-issue", "telegram", "en", {
      rendition,
      edited: true,
      site_url: "",
    });
    expect(out).toContain("AI-made, edited by a person");
  });

  it("set direction from the language on the site", async () => {
    const out = await renderer.render("newsletter-issue", "site", "fa", {
      rendition,
      edited: false,
      ai_policy_url: "/fa/ai-policy",
      leads: {},
    });
    expect(out).toContain('dir="rtl"');
  });

  it("label each item marked opinion, in its language", async () => {
    const story = {
      title: "Bir sanatçı",
      items: [
        { heading: "Hayat", paragraphs: ["Bir paragraf."], claim_ids: ["c1"] },
        { paragraphs: ["Bence harika."], opinion: true, claim_ids: ["c2"] },
        { paragraphs: ["Bence de."], opinion: true, claim_ids: ["c3"] },
      ],
    };
    const label = await renderer.opinionLabel("tr");
    expect(label).toBe("Görüş");
    expect(await renderer.opinionLabel("fa")).toBe("دیدگاه");
    const out = await renderer.render("artist-story", "site", "tr", {
      rendition: story,
      edited: false,
      ai_policy_url: "/ai-policy",
    });
    expect(opinionItems(story)).toBe(2);
    expect(occurrences(out, label)).toBe(2);
    // The word in a sentence is no label: the gate counts against the output without the marks.
    const words = {
      ...story,
      items: [...story.items, { paragraphs: ["Görüş ayrılığı var."], claim_ids: ["c4"] }],
    };
    const render = (r: unknown) =>
      renderer.render("artist-story", "site", "tr", {
        rendition: r,
        edited: false,
        ai_policy_url: "/",
      });
    expect(
      occurrences(await render(words), label) -
        occurrences(await render(unmarkOpinion(words)), label),
    ).toBe(2);
  });

  it("escape agent-written text", async () => {
    const out = await renderer.render("newsletter-issue", "telegram", "en", {
      rendition: { ...rendition, title: "<script>x</script>" },
      edited: false,
      site_url: "",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("splitting a post to a channel's limit", () => {
  it("counts visible text: tags dropped, entities decoded, emoji as two units", () => {
    expect(visibleLength("<b>a&amp;b</b> &lt;i&gt;")).toBe(7);
    expect(visibleLength("🎙x")).toBe(3);
  });

  it("packs blocks greedily and ends every part with the label block", () => {
    const parts = splitParts("<b>T</b>\n\nblock one\n\n \nblock two\n\nAI-made · u", "AI-made", 30);
    expect(parts).toEqual(["<b>T</b>\n\nblock one\n\nAI-made · u", "block two\n\nAI-made · u"]);
    for (const p of parts) expect(visibleLength(p)).toBeLessThanOrEqual(30);
  });

  it("refuses a block that cannot fit", () => {
    expect(() => splitParts(`${"x".repeat(50)}\n\nAI-made`, "AI-made", 30)).toThrow(/cannot fit/);
  });

  it("takes only the lines from the label onwards as the footer", () => {
    const parts = splitParts("<b>T</b>\n\nnotes one\nnotes two\nAI-made · u", "AI-made", 4096);
    expect(parts).toEqual(["<b>T</b>\n\nnotes one\nnotes two\n\nAI-made · u"]);
    const split = splitParts("aaaa\n\nnotes\nAI-made", "AI-made", 14);
    expect(split).toEqual(["aaaa\n\nAI-made", "notes\n\nAI-made"]);
  });

  it("refuses a post without the label, a footer over the limit, or a broken tag", () => {
    expect(() => splitParts("a\n\nb", "AI-made", 4096)).toThrow(/label is missing/);
    expect(() => splitParts(`AI-made ${"x".repeat(40)}`, "AI-made", 30)).toThrow(/footer/);
    // A blank line inside agent text in a tag: the split cuts the tag apart.
    expect(() => splitParts("<b>title\n\nrest</b>\n\nL", "L", 9)).toThrow(/unbalanced/);
  });

  it("keeps a short post whole", () => {
    expect(splitParts("a\n\nAI-made", "AI-made", 4096)).toEqual(["a\n\nAI-made"]);
  });

  it("splits a long Telegram issue with the label on every message", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      kind: "news",
      headline: `خبر ${i}`,
      body: "متن خبر. ".repeat(60),
      claim_ids: ["c1"],
    }));
    const label = await renderer.disclosureLabel("fa");
    const parts = await renderer.renderParts("newsletter-issue", "telegram", "fa", {
      rendition: { title: "امروز", items },
      edited: false,
      site_url: "https://ai.example.test/",
    });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(CHANNEL_LIMITS.telegram ?? 0);
      expect(p).toContain(label);
    }
    expect(parts.join("")).toContain("خبر 11");
  });

  it("gives other channels one part", async () => {
    const parts = await renderer.renderParts("newsletter-issue", "site", "en", {
      rendition,
      edited: false,
      ai_policy_url: "/ai-policy",
      leads: {},
    });
    expect(parts).toHaveLength(1);
  });
});

describe("AI-voice intro", () => {
  it("introduces every host and the narrator as AI, in each language", async () => {
    for (const [language, hosts] of [
      ["en", ["maya", "leo"]],
      ["fa", ["niloofar", "farzad"]],
      ["tr", ["deniz", "emre"]],
    ] as const) {
      const lines = await renderer.introLines(language, "Weekly", hosts, true);
      expect(lines.map((l) => l.speaker)).toEqual([...hosts, "narrator"]);
      expect(introProblems(lines, language, hosts, true)).toEqual([]);
    }
  });

  it("names hosts in their language's script when the series gives names", async () => {
    const names = { niloofar: "نیلوفر", farzad: "فرزاد" };
    const lines = await renderer.introLines("fa", "پادکست", ["niloofar", "farzad"], false, names);
    expect(lines[0]?.text).toContain("نیلوفر");
    expect(lines.map((l) => l.text).join(" ")).not.toMatch(/[A-Za-z]/);
    expect(introProblems(lines, "fa", ["niloofar", "farzad"], false, names)).toEqual([]);
    expect(await renderer.voicesNote("fa", ["niloofar", "farzad"], false, names)).toContain(
      "نیلوفر و فرزاد",
    );
  });

  it("names what is missing", () => {
    const lines = [{ speaker: "maya", text: "Welcome. I'm Maya." }];
    expect(introProblems(lines, "en", ["maya", "leo"], true)).toEqual([
      `maya's line does not say "AI"`,
      "leo is not introduced",
      "narrator is not introduced",
    ]);
  });
});
