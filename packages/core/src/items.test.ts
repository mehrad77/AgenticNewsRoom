import { describe, expect, it } from "vitest";
import { itemHash, itemPaths, itemText } from "./items.ts";

describe("items", () => {
  const body = {
    items: [
      { kind: "news", headline: "A model", body: "It shipped.", claim_ids: ["c1"], anchor: "a" },
      { kind: "news", headline: "Another", body: "Also.", claim_ids: [] },
    ],
  };

  it("name each item by its path", () => {
    expect(itemPaths(body).map(([p]) => p)).toEqual(["items.0", "items.1"]);
  });

  it("read an item's text without its labels", () => {
    expect(itemText(body.items[0] ?? {})).toBe("A model\nIt shipped.");
  });

  it("hash the same text the same, and changed text differently, whatever its claims", () => {
    const [a] = body.items;
    expect(itemHash({ ...a, claim_ids: ["c9"] })).toBe(itemHash(a ?? {}));
    expect(itemHash({ ...a, body: "It shipped late." })).not.toBe(itemHash(a ?? {}));
  });
});
