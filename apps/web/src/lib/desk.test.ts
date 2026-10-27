import { describe, expect, it } from "vitest";
import { deskApi, deskRoute } from "./desk.ts";

describe("deskRoute", () => {
  it("knows the desk's pages", () => {
    expect(deskRoute("/")).toEqual({ kind: "home" });
    expect(deskRoute("/ai")).toEqual({ kind: "queue", newsroom: "ai" });
    expect(deskRoute("/ai/channels")).toEqual({ kind: "channels", newsroom: "ai" });
    const id = "0b2f6f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(deskRoute(`/ai/p/${id}`)).toEqual({ kind: "publication", newsroom: "ai", id });
    expect(deskRoute("/ai/p/1")).toEqual({ kind: "not-found" });
    expect(deskRoute("/AI")).toEqual({ kind: "not-found" });
  });
});

describe("deskApi", () => {
  it("forwards the Access JWT and posts a form's action to the API", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "x", status: "assigned" }));
    }) as unknown as typeof fetch;
    const api = deskApi("http://api.test", "jwt-token", fetchFn);
    const form = new FormData();
    form.set("action", "return");
    form.set("id", "p1");
    form.set("note", "  Use the primary source. ");
    expect(await api.act({ kind: "queue", newsroom: "ai" }, form)).toBe("/ai");
    expect(calls[0]?.url).toBe("http://api.test/desk/newsrooms/ai/publications/p1/return");
    expect(calls[0]?.init.headers).toMatchObject({ "cf-access-jwt-assertion": "jwt-token" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ note: "Use the primary source." });
  });

  it("raises the API's error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 409 })) as unknown as typeof fetch;
    await expect(deskApi("http://api.test", null, fetchFn).me()).rejects.toMatchObject({
      status: 409,
      message: "nope",
    });
  });
});
