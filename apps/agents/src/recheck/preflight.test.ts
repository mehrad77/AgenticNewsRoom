import type { CatalogEntry } from "@anr/models";
import { describe, expect, it } from "vitest";
import { notLoaded } from "./preflight.ts";

const entry = (id: string, model: string, baseUrl?: string) =>
  ({ id, model, baseUrl }) as CatalogEntry;

describe("notLoaded", () => {
  it("name the local models the server has not loaded, and skip remote ones", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }))) as typeof fetch;
    const out = await notLoaded(
      [
        entry("oss", "openai/gpt-oss-20b", "http://127.0.0.1:1234/v1"),
        entry("gemma", "google/gemma-4-12b", "http://127.0.0.1:1234/v1/"),
        entry("gemini", "gemini-flash"),
        entry("remote", "x", "https://api.example.com/v1"),
      ],
      fetchImpl,
    );
    expect(out).toEqual(["gemma (google/gemma-4-12b at http://127.0.0.1:1234/v1)"]);
  });

  it("count every model of an unreachable server as not loaded", async () => {
    const fetchImpl = (async () => {
      throw new Error("refused");
    }) as typeof fetch;
    expect(
      await notLoaded(
        [entry("oss", "openai/gpt-oss-20b", "http://host.docker.internal:1234/v1")],
        fetchImpl,
      ),
    ).toEqual(["oss (openai/gpt-oss-20b at http://host.docker.internal:1234/v1)"]);
  });
});
