import { describe, expect, it } from "vitest";
import { route } from "./routes.ts";

describe("route", () => {
  it("knows the site's pages", () => {
    expect(route("/")).toEqual({ kind: "home" });
    expect(route("/search")).toEqual({ kind: "search" });
    expect(route("/ai-policy/")).toEqual({ kind: "ai-policy" });
    expect(route("/corrections")).toEqual({ kind: "corrections" });
    expect(route("/challenge/0b9c6f5e-1d2a-4c3b-8e7f-123456789abc")).toEqual({
      kind: "challenge",
      id: "0b9c6f5e-1d2a-4c3b-8e7f-123456789abc",
    });
  });

  it("finds a publication and its ninjs twin", () => {
    expect(route("/daily-newsletter/2026-10-27")).toEqual({
      kind: "publication",
      path: "/daily-newsletter/2026-10-27",
    });
    expect(route("/daily-newsletter/2026-10-27.json")).toEqual({
      kind: "ninjs",
      path: "/daily-newsletter/2026-10-27",
    });
    expect(route("/daily-newsletter/2026-10-27-1a2b3c4d")).toMatchObject({ kind: "publication" });
  });

  it("refuses anything else", () => {
    for (const p of [
      "/x",
      "/daily/today",
      "/../etc/passwd",
      "/Daily/2026-10-27",
      "/a/2026-10-27.json.json",
    ])
      expect(route(p)).toEqual({ kind: "not-found" });
  });
});
