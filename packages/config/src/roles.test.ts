import { fileURLToPath } from "node:url";
import type { ModelsSchema } from "@anr/schemas";
import { describe, expect, it } from "vitest";
import { formatNames } from "./load.ts";
import { effectiveRoles, parseRoles, type Roles, roleProblems } from "./roles.ts";

const price = { in: 1, out: 2 };
const catalog: ModelsSchema = {
  providers: { p: { kind: "google", key_env: "P_KEY" } },
  models: {
    a: { provider: "p", model: "a", family: "fa", tools: true, price },
    b: { provider: "p", model: "b", family: "fb", tools: true, price },
    a2: { provider: "p", model: "a2", family: "fa", tools: true, price },
    mute: { provider: "p", model: "mute", family: "fm", tools: false, price },
    free: { provider: "p", model: "free", family: "ff", tools: true },
  },
  roles: {
    planner: ["a"],
    desk: { default: ["a", "b"] },
    renderer: ["a"],
    "fact-checker": ["b", "a"],
    "item-matcher": ["b"],
    summariser: ["b"],
  },
  tts: "a",
};
const formats = ["newsletter-issue", "classic-article"];
const roles = (change: (r: Roles) => void): Roles => {
  const r = structuredClone(catalog.roles);
  change(r);
  return r;
};

describe("roleProblems", () => {
  it("accepts the catalog's own chains", () => {
    expect(roleProblems(catalog, catalog.roles, formats)).toEqual([]);
  });

  it("names unknown models, models without tools or a price, and unknown formats", () => {
    const r = roles((r) => {
      r.planner = ["nope", "mute"];
      r.desk.by_format = { "classic-article": ["free"], podcast: ["a"] };
    });
    expect(roleProblems(catalog, r, formats)).toEqual([
      "desk.by_format: unknown format podcast",
      "planner: unknown model nope",
      "planner: mute has no tool calling",
      "desk.by_format.classic-article: free has no price",
    ]);
  });

  it("requires two fact-checker families, not just two ids (invariant 4)", () => {
    const r = roles((r) => {
      r["fact-checker"] = ["a", "a2"];
    });
    expect(roleProblems(catalog, r, formats)).toEqual([
      "fact-checker needs models from at least two families",
    ]);
  });
});

describe("effectiveRoles", () => {
  it("uses the models file without a stored setting, or with JSON null", () => {
    for (const stored of [undefined, null]) {
      expect(effectiveRoles(catalog, stored, formats)).toEqual({
        roles: catalog.roles,
        source: "file",
        problems: [],
      });
    }
  });

  it("uses valid stored chains", () => {
    const r = roles((r) => {
      r.planner = ["b", "a"];
    });
    expect(effectiveRoles(catalog, r, formats)).toEqual({ roles: r, source: "desk", problems: [] });
  });

  it("falls back to the file, with the reason, when the stored chains no longer fit", () => {
    // A deploy removed a model the admin had chosen.
    const r = roles((r) => {
      r.summariser = ["gone"];
    });
    expect(effectiveRoles(catalog, r, formats)).toEqual({
      roles: catalog.roles,
      source: "file",
      problems: ["summariser: unknown model gone"],
    });
  });

  it("falls back to the file when the stored value is not chains at all", () => {
    const e = effectiveRoles(catalog, { planner: [] }, formats);
    expect(e.source).toBe("file");
    expect(e.roles).toBe(catalog.roles);
    expect(e.problems.length).toBeGreaterThan(0);
    expect(parseRoles("x")).toHaveProperty("problems");
    expect(parseRoles(catalog.roles)).toEqual({ roles: catalog.roles });
  });
});

describe("formatNames", () => {
  it("lists the config's formats, without _partials", () => {
    const names = formatNames(fileURLToPath(new URL("../../../config", import.meta.url)));
    expect(names).toContain("newsletter-issue");
    expect(names).not.toContain("_partials");
  });
});
