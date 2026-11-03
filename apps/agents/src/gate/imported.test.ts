import { describe, expect, it } from "vitest";
import { checkedItems } from "./imported.ts";
import type { StoredCheck } from "./policy.ts";

const claim = (id: string, ref: string) => ({ id, ref, kind: "fact", sources: [{}] });
const check = (
  over: Partial<StoredCheck & { detail: unknown }>,
): StoredCheck & { detail: unknown } => ({
  kind: "code",
  name: "x",
  result: "pass",
  claimId: null,
  renditionId: null,
  item: null,
  position: null,
  detail: null,
  ...over,
});
const body = {
  items: [
    { kind: "news", headline: "A", body: "One.", claim_ids: ["c1"] },
    { kind: "news", headline: "B", body: "Two.", claim_ids: ["c2"] },
    { kind: "news", headline: "C", body: "No source.", claim_ids: [] },
  ],
};
const publications = [{ id: "p1", rendition_id: "r1" }];
const renditions = [{ id: "r1", body }];
const claims = [claim("k1", "c1"), claim("k2", "c2")];
// Everything about the first item and the rendition passed.
const passing = [
  check({ name: "schema", renditionId: "r1" }),
  check({ name: "beats", renditionId: "r1", detail: { restricted: [] } }),
  check({ name: "quote-match", claimId: "k1" }),
  check({ kind: "fact-check", name: "fact-check", claimId: "k1", position: 0 }),
  check({ name: "item-claims", renditionId: "r1", item: "items.0" }),
  check({ kind: "item-match", name: "item-match", renditionId: "r1", item: "items.0" }),
];

describe("an imported story's checked items (D184)", () => {
  it("count an item only when its claims, its own checks and the item matcher all passed", () => {
    const out = checkedItems(publications, renditions, claims, [
      ...passing,
      check({ name: "quote-match", claimId: "k2" }),
      check({
        kind: "fact-check",
        name: "fact-check",
        claimId: "k2",
        position: 0,
        result: "partial",
      }),
    ]);
    expect(out.map((x) => x.item)).toEqual(["items.0"]);
    expect(out[0]?.textHash).toMatch(/^[0-9a-z]+$/);
  });

  it("count nothing without the item matcher's pass, or with a missing fact-check", () => {
    expect(checkedItems(publications, renditions, claims, passing.slice(0, 5))).toEqual([]);
    expect(
      checkedItems(
        publications,
        renditions,
        claims,
        passing.filter((c) => c.kind !== "fact-check"),
      ),
    ).toEqual([]);
  });

  it("count nothing when the rendition failed its schema, or its beats are restricted", () => {
    const failing = (name: string, over: object) =>
      passing.map((c) => (c.name === name ? { ...c, ...over } : c));
    expect(
      checkedItems(publications, renditions, claims, failing("schema", { result: "fail" })),
    ).toEqual([]);
    expect(
      checkedItems(
        publications,
        renditions,
        claims,
        failing("beats", { detail: { restricted: ["x"] } }),
      ),
    ).toEqual([]);
  });

  it("never count an item that cites no claim", () => {
    const out = checkedItems(publications, renditions, claims, [
      ...passing,
      check({ kind: "item-match", name: "item-match", renditionId: "r1", item: "items.2" }),
    ]);
    expect(out.map((x) => x.item)).toEqual(["items.0"]);
  });
});
