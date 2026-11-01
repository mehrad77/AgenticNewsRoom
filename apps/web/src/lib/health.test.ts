import { describe, expect, it } from "vitest";
import { healthResponse } from "./health.ts";

const pool = (workers: string[] | Error) => ({
  query: async () => {
    if (workers instanceof Error) throw workers;
    return { rows: workers.map((worker) => ({ worker })) };
  },
});

describe("/healthz", () => {
  it("answers 200, never cached, while every worker beat recently", async () => {
    const all = ["agents", "publisher", "ingestion", "verifier", "web", "api"];
    const res = await healthResponse(pool(all) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 naming the workers that are late", async () => {
    const res = await healthResponse(pool(["agents", "web", "api", "ingestion"]) as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "late", workers: ["publisher", "verifier"] });
  });

  it("answers 503 when Postgres does not", async () => {
    const res = await healthResponse(pool(new Error("connection refused")) as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "no-database" });
  });
});
