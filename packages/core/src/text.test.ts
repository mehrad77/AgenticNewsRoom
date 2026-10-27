import { describe, expect, it } from "vitest";
import { textFields, withText } from "./text.ts";

const body = {
  language: "en",
  title: "Today",
  items: [
    { kind: "news", headline: "A", body: "B", claim_ids: ["c1"] },
    { kind: "article", title: "T", lead_id: "x", reason: "R", claim_ids: [] },
    { paragraphs: ["p1", "p2"], "a/b": "slash" },
  ],
};

describe("textFields", () => {
  it("lists reader-facing strings and skips structure", () => {
    expect(textFields(body).map((f) => f.pointer)).toEqual([
      "/title",
      "/items/0/headline",
      "/items/0/body",
      "/items/1/title",
      "/items/1/reason",
      "/items/2/paragraphs/0",
      "/items/2/paragraphs/1",
      "/items/2/a~1b",
    ]);
  });
});

describe("withText", () => {
  it("replaces text at pointers without touching the original", () => {
    const out = withText(body, [
      { pointer: "/items/0/body", text: "New" },
      { pointer: "/items/2/a~1b", text: "s" },
    ]) as typeof body;
    expect(out.items[0]).toMatchObject({ body: "New", claim_ids: ["c1"] });
    expect((out.items[2] as Record<string, unknown>)["a/b"]).toBe("s");
    expect(body.items[0]?.body).toBe("B");
  });

  it("refuses structure and unknown pointers", () => {
    expect(() => withText(body, [{ pointer: "/items/1/lead_id", text: "y" }])).toThrow(
      "/items/1/lead_id is not a text field",
    );
    expect(() => withText(body, [{ pointer: "/items/9/body", text: "y" }])).toThrow();
    expect(() => withText(body, [{ pointer: "/language", text: "fa" }])).toThrow();
  });
});
