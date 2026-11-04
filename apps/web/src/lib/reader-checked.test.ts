import { itemHash } from "@anr/core";
import { describe, expect, it } from "vitest";
import { allChecked } from "./reader.ts";

describe("allChecked (D184)", () => {
  const a = { kind: "news", headline: "A", body: "One.", claim_ids: ["c1"] };
  const b = { kind: "news", headline: "B", body: "Two.", claim_ids: [] };

  it("hold only when every item was checked as it reads now", () => {
    expect(allChecked({ items: [a] }, { "items.0": itemHash(a) })).toBe(true);
    expect(allChecked({ items: [a, b] }, { "items.0": itemHash(a) })).toBe(false);
    expect(allChecked({ items: [{ ...a, body: "Changed." }] }, { "items.0": itemHash(a) })).toBe(
      false,
    );
    expect(allChecked({ items: [] }, {})).toBe(false);
  });
});
