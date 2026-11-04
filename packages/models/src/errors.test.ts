import { ContextOverflowError } from "@langchain/core/errors";
import { describe, expect, it } from "vitest";
import { BILLING_COOLDOWN_MS, classify } from "./errors.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const http = (status: number, headers: Record<string, string> = {}, message = `${status}`) =>
  Object.assign(new Error(message), { status, headers: new Headers(headers) });

describe("classify (Anthropic)", () => {
  it("waits for Anthropic's latest rate-limit reset when Retry-After is missing", () => {
    const failure = classify(
      http(429, {
        "anthropic-ratelimit-requests-reset": "2026-11-04T12:00:05Z",
        "anthropic-ratelimit-input-tokens-reset": "2026-11-04T12:00:40Z",
        "anthropic-ratelimit-output-tokens-reset": "2026-11-04T12:00:02Z",
      }),
      now,
    );
    expect(failure).toMatchObject({ kind: "rate-limited", retryAfterMs: 40_000 });
  });

  it("prefers Retry-After over the reset headers", () => {
    const failure = classify(
      http(429, {
        "retry-after": "3",
        "anthropic-ratelimit-tokens-reset": "2026-11-04T12:01:00Z",
      }),
      now,
    );
    expect(failure.retryAfterMs).toBe(3_000);
  });

  it("treats LangChain's context overflow, which has no status, as too large", () => {
    const cause = http(400, {}, "400 prompt is too long: 250123 tokens > 200000 maximum");
    expect(classify(ContextOverflowError.fromError(cause)).kind).toBe("too-large");
  });

  it("treats input plus max_tokens over the context limit as too large", () => {
    const message = "input length and `max_tokens` exceed context limit: 199000 + 8192 > 200000";
    expect(classify(http(400, {}, message)).kind).toBe("too-large");
  });

  it("lets the chain move on when the account is out of credit, for an hour", () => {
    const credit = "400 Your credit balance is too low to access the Anthropic API.";
    expect(classify(http(400, {}, credit))).toMatchObject({
      kind: "rate-limited",
      retryAfterMs: BILLING_COOLDOWN_MS,
    });
    const typed = Object.assign(http(400, {}, "400 billing"), { type: "billing_error" });
    expect(classify(typed).kind).toBe("rate-limited");
    expect(classify(http(402)).retryAfterMs).toBe(BILLING_COOLDOWN_MS);
    expect(classify(http(402, { "retry-after": "60" })).retryAfterMs).toBe(60_000);
  });

  it("keeps any other bad request fatal", () => {
    expect(classify(http(400, {}, "400 messages: at least one message is required")).kind).toBe(
      "fatal",
    );
    expect(classify(http(400, {}, "400 max_tokens: must be a positive integer")).kind).toBe(
      "fatal",
    );
    expect(classify(http(401, {}, "401 invalid x-api-key")).kind).toBe("fatal");
  });
});
