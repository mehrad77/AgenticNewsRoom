import { describe, expect, it } from "vitest";
import { app } from "./app.ts";

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "api" });
  });
});
