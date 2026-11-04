// API-first (D190): every desk route is in the contract, and every operation in the contract is an
// MCP tool or one of the few only a desk session may call. A new desk action that skips the spec
// or the MCP server fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createApp } from "./app.ts";
import { BROWSER_ONLY, MCP_TOOLS } from "./generated/mcp-tools.ts";
import { toolRequest } from "./mcp.ts";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const METHODS = ["get", "post", "put", "delete", "patch"];
const deskOperations = Object.entries(spec.paths)
  .filter(([path]) => path.startsWith("/desk/"))
  .flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`),
  );

describe("the MCP server", () => {
  it("has a tool for every desk operation a token may call, and no other", () => {
    const covered = [...MCP_TOOLS, ...BROWSER_ONLY].map((t) => `${t.method} ${t.path}`);
    expect(covered.sort()).toEqual([...deskOperations].sort());
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  it("leaves only token management to the desk session", () => {
    expect(BROWSER_ONLY.map((o) => o.path).every((p) => p.includes("/tokens"))).toBe(true);
  });

  it("covers every desk route the app serves", () => {
    const app = createApp({
      pool: {} as never,
      boss: {} as never,
      platform: {} as never,
      verify: async () => null,
      site: { rootDomain: "example.test" },
    });
    const served = app.routes
      .filter((r) => r.path.startsWith("/desk/") && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace(/:([a-z]+)/gi, "{$1}")}`);
    expect([...new Set(served)].sort()).toEqual([...deskOperations].sort());
  });

  it("fills path parameters, sends the rest as query and the body as JSON", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "getSchedule");
    if (!tool) throw new Error("getSchedule missing");
    expect(toolRequest(tool, { newsroom: "ai", days: 7 })).toEqual({
      path: "/desk/newsrooms/ai/schedule?days=7",
    });
    const approve = MCP_TOOLS.find((t) => t.name === "approvePublication");
    if (!approve) throw new Error("approvePublication missing");
    expect(approve).toMatchObject({ readOnly: false, destructive: true });
    expect(
      toolRequest(approve, { newsroom: "ai", publication: "p 1", body: { version: "v" } }),
    ).toEqual({ path: "/desk/newsrooms/ai/publications/p%201/approve", body: '{"version":"v"}' });
    expect(() => toolRequest(approve, { body: {} })).toThrow("newsroom is required");
  });
});
