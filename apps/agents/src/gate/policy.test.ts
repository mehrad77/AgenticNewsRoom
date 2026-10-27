import { describe, expect, it } from "vitest";
import { decide, missingChecks, type PublicationFacts, type StoredCheck } from "./policy.ts";

const R = "rendition";
const check = (over: Partial<StoredCheck>): StoredCheck => ({
  kind: "code",
  name: "x",
  result: "pass",
  claimId: null,
  renditionId: null,
  item: null,
  ...over,
});

/** A daily newsletter whose every expected check exists and passed. */
function complete(): PublicationFacts {
  return {
    renditionId: R,
    items: ["items.0"],
    claims: [{ id: "c1", kind: "fact", sources: 2 }],
    checks: [
      ...["schema", "beats", "style-lint", "disclosure"].map((name) =>
        check({ name, renditionId: R }),
      ),
      check({ name: "quote-match", claimId: "c1" }),
      check({ name: "source-independence", claimId: "c1" }),
      check({ kind: "fact-check", name: "fact-check", claimId: "c1", position: 0 }),
      check({ kind: "fact-check", name: "fact-check", claimId: "c1", position: 1 }),
      check({ name: "item-claims", renditionId: R, item: "items.0" }),
      check({ kind: "item-match", name: "item-match", renditionId: R, item: "items.0" }),
    ],
    themed: false,
    format: "newsletter-issue",
    autoPublish: ["newsletter-issue"],
    restricted: [],
  };
}

describe("gate policy (D80)", () => {
  it("schedules daily news only when every expected check exists and passed", () => {
    expect(missingChecks(complete())).toEqual([]);
    expect(decide(complete())).toEqual({ status: "scheduled" });
  });

  it.each(["fail", "partial", "error", "timed-out"] as const)("holds on any %s check", (result) => {
    const f = complete();
    f.checks = [
      ...f.checks,
      check({ kind: "fact-check", name: "fact-check", claimId: "c1", result }),
    ];
    const d = decide(f);
    expect(d.status).toBe("with-editor");
    if (d.status === "with-editor") expect(d.holds[0]).toMatchObject({ name: "checks", result });
  });

  it("holds when a check never ran: no finding is not a pass", () => {
    const f = complete();
    f.checks = f.checks.filter((c) => c.kind !== "fact-check" && c.name !== "disclosure");
    const d = decide(f);
    expect(d).toMatchObject({
      status: "with-editor",
      holds: [{ name: "checks-missing", result: "error" }],
    });
    expect(missingChecks(f)).toEqual(["disclosure", "fact-check c1#0", "fact-check c1#1"]);
    // The same source checked twice (overlapping gates) still leaves the other one missing.
    const twice = check({ kind: "fact-check", name: "fact-check", claimId: "c1", position: 0 });
    f.checks = [...f.checks, twice, twice];
    expect(missingChecks(f)).toEqual(["disclosure", "fact-check c1#1"]);
  });

  it("holds a publication without a rendition", () => {
    expect(decide({ ...complete(), renditionId: null })).toMatchObject({
      holds: [{ name: "checks-missing", detail: { missing: ["rendition"] } }],
    });
  });

  it("sends themed work, restricted beats and other formats to an editor", () => {
    const names = (f: PublicationFacts) => {
      const d = decide(f);
      return d.status === "with-editor" ? d.holds.map((h) => h.name) : [];
    };
    expect(names({ ...complete(), themed: true })).toEqual(["themed"]);
    expect(names({ ...complete(), restricted: ["policy"] })).toEqual(["restricted-beat"]);
    expect(names({ ...complete(), autoPublish: [] })).toEqual(["not-auto-published"]);
  });
});
