import { describe, expect, it } from "vitest";
import { rateLimitDelayMs, Throttle } from "./throttle.ts";

describe("Throttle", () => {
  it("spaces calls by the gap and honours a pause", async () => {
    let now = 0;
    const slept: number[] = [];
    const t = new Throttle(
      6000,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    await t.wait();
    await t.wait();
    expect(slept).toEqual([6000]);
    t.pauseFor(60_000);
    expect(t.delayMs()).toBe(60_000);
    await t.wait();
    expect(slept).toEqual([6000, 60_000]);
  });

  it("derives the gap from requests per minute", () => {
    expect(() => Throttle.perMinute(0)).toThrow();
  });
});

describe("rateLimitDelayMs", () => {
  it("reads Gemini's suggested retry delay", () => {
    const error = Object.assign(new Error("[429 Too Many Requests] Resource has been exhausted"), {
      status: 429,
      errorDetails: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
    });
    expect(rateLimitDelayMs(error)).toBe(37_000);
  });

  it("waits an hour for a daily quota, a minute when no delay is given", () => {
    const daily = Object.assign(new Error("429 RESOURCE_EXHAUSTED"), {
      errorDetails: [
        { violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
      ],
    });
    expect(rateLimitDelayMs(daily)).toBe(3_600_000);
    expect(rateLimitDelayMs(new Error("429 Too Many Requests"))).toBe(60_000);
  });

  it("ignores other errors", () => {
    expect(rateLimitDelayMs(new Error("500 Internal"))).toBeNull();
    expect(rateLimitDelayMs(undefined)).toBeNull();
  });
});
