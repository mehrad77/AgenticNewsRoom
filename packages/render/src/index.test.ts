import { describe, expect, it } from "vitest";
import { createRenderer } from "./index.ts";

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
