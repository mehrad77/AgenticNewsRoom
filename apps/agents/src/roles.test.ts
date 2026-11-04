import type { ModelsConfig } from "@anr/models";
import { describe, expect, it } from "vitest";
import { rolesRefresher } from "./roles.ts";
import { ModelRouter } from "./router.ts";

const price = { in: 0, out: 0 };
const catalog: ModelsConfig = {
  providers: { p: { kind: "google", key_env: "P_KEY" } },
  models: {
    a: { provider: "p", model: "a", family: "fa", tools: true, price },
    b: { provider: "p", model: "b", family: "fb", tools: true, price },
    c: { provider: "p", model: "c", family: "fc", tools: true, price },
  },
  roles: {
    planner: ["a"],
    desk: { default: ["a"], by_format: { "newsletter-issue": ["b"] } },
    renderer: ["a"],
    "fact-checker": ["b", "c"],
    "item-matcher": ["b"],
    summariser: ["b"],
  },
  tts: "a",
};
const desk = {
  ...structuredClone(catalog.roles),
  planner: ["c", "a"],
  desk: { default: ["c"] },
  "fact-checker": ["a", "b"],
};
const formats = ["newsletter-issue"];

function setup(values: unknown[]) {
  const router = new ModelRouter(catalog);
  const warnings: string[] = [];
  let reads = 0;
  const refresh = rolesRefresher({
    router,
    catalog,
    formats,
    read: async () => {
      const v = values[Math.min(reads++, values.length - 1)];
      if (v instanceof Error) throw v;
      return v;
    },
    warn: (m) => warnings.push(m),
  });
  return { router, warnings, refresh, reads: () => reads };
}

describe("ModelRouter.setRoles", () => {
  it("swaps the chains resolve() returns, and null puts the file's back", () => {
    const router = new ModelRouter(catalog);
    expect(router.resolve("planner")).toEqual(["a"]);
    router.setRoles(desk);
    expect(router.resolve("planner")).toEqual(["c", "a"]);
    // The desk's chains have no format override: every format uses the default.
    expect(router.resolve("desk", { format: "newsletter-issue" })).toEqual(["c"]);
    expect(router.resolve("fact-checker", { writerFamilies: ["fc"] })).toEqual(["a", "b"]);
    expect(router.resolve("fact-checker", { writerFamilies: ["fa"] })).toEqual(["b"]);
    expect(router.roles()).toBe(desk);
    router.setRoles(null);
    expect(router.resolve("planner")).toEqual(["a"]);
    expect(router.resolve("desk", { format: "newsletter-issue" })).toEqual(["b"]);
  });
});

describe("rolesRefresher", () => {
  it("applies the desk's chains on the next refresh, and the file's once they are reset", async () => {
    const s = setup([undefined, desk, null]);
    await s.refresh();
    expect(s.router.resolve("planner")).toEqual(["a"]);
    await s.refresh();
    expect(s.router.resolve("planner")).toEqual(["c", "a"]);
    await s.refresh();
    expect(s.router.resolve("planner")).toEqual(["a"]);
    expect(s.warnings).toEqual([]);
  });

  it("runs the file's chains when the stored ones no longer fit the catalog, warning once", async () => {
    const stale = { ...desk, summariser: ["removed-by-a-deploy"] };
    const s = setup([desk, stale, stale, stale]);
    await s.refresh();
    for (let i = 0; i < 3; i++) await s.refresh();
    expect(s.router.resolve("summariser")).toEqual(["b"]);
    expect(s.router.resolve("planner")).toEqual(["a"]);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain("summariser: unknown model removed-by-a-deploy");
  });

  it("keeps the chains in force when the read fails", async () => {
    const s = setup([desk, new Error("connection lost")]);
    await s.refresh();
    await s.refresh();
    expect(s.router.resolve("planner")).toEqual(["c", "a"]);
    expect(s.warnings[0]).toContain("connection lost");
  });

  it("shares one read between concurrent jobs", async () => {
    const s = setup([desk]);
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(s.reads()).toBe(1);
    await s.refresh();
    expect(s.reads()).toBe(2);
  });
});
