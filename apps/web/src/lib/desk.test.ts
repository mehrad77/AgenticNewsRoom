import { describe, expect, it } from "vitest";
import { deskApi, deskRoute, editedFields, editForm, issueLink, type Sample } from "./desk.ts";

describe("deskRoute", () => {
  it("knows the desk's pages", () => {
    expect(deskRoute("/")).toEqual({ kind: "home" });
    expect(deskRoute("/ai")).toEqual({ kind: "queue", newsroom: "ai" });
    expect(deskRoute("/ai/channels")).toEqual({ kind: "channels", newsroom: "ai" });
    const id = "0b2f6f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(deskRoute(`/ai/p/${id}`)).toEqual({ kind: "publication", newsroom: "ai", id });
    expect(deskRoute("/ai/p/1")).toEqual({ kind: "not-found" });
    expect(deskRoute("/AI")).toEqual({ kind: "not-found" });
    for (const page of ["schedule", "budget", "sources", "measures"])
      expect(deskRoute(`/ai/${page}/`)).toEqual({ kind: page, newsroom: "ai" });
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

describe("the edit form", () => {
  it("shows each text field and posts back what changed, with plain line breaks", async () => {
    const rendition = {
      language: "en",
      title: "Today",
      items: [{ kind: "news", headline: "A", body: "Line one\nline two", claim_ids: ["c1"] }],
    };
    const fields = editForm(rendition);
    expect(fields.map((f) => [f.name, f.label, f.long])).toEqual([
      ["text:/title", "title", false],
      ["text:/items/0/headline", "items › 0 › headline", false],
      ["text:/items/0/body", "items › 0 › body", true],
    ]);
    const form = new FormData();
    form.set("action", "edit");
    form.set("id", "p1");
    form.set("version", "v1");
    for (const f of fields) form.set(f.name, f.text.replace("\n", "\r\n"));
    form.set("text:/title", "Tonight");
    const calls: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const route = { kind: "publication", newsroom: "ai", id: "p1" } as const;
    expect(await deskApi("http://api.test", null, fetchFn).act(route, form)).toBe("/ai/p/p1");
    expect(calls[0]).toEqual({
      version: "v1",
      changes: [
        { pointer: "/title", text: "Tonight" },
        { pointer: "/items/0/headline", text: "A" },
        { pointer: "/items/0/body", text: "Line one\nline two" },
      ],
    });
    expect(editedFields(new FormData())).toEqual([]);
  });
});

describe("issueLink", () => {
  it("prefills a new issue with the miss and where the publication is", () => {
    const sample = {
      id: "s1",
      publication: "p1",
      title: "Today in AI",
      language: "en",
      sampled_at: "2026-10-27T18:00:00Z",
      outcome: "miss",
      note: "A date was wrong.\nCheck dates.",
    } as Sample;
    const url = new URL(issueLink("https://github.com/o/r/issues/new", "ai", sample));
    expect(url.origin + url.pathname).toBe("https://github.com/o/r/issues/new");
    expect(url.searchParams.get("title")).toBe("Sample miss (ai): Today in AI");
    expect(url.searchParams.get("body")).toContain("> A date was wrong.\n> Check dates.");
  });
});
