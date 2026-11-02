import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { scrubText } from "./scrub.ts";
import { recordTelemetry } from "./testing.ts";

describe("scrubText", () => {
  it("drops query strings, emails and IP addresses, and keeps the rest", () => {
    expect(scrubText("GET /challenge/0b0c?k=s3cret&x=1 200")).toBe("GET /challenge/0b0c 200");
    expect(scrubText("https://ai.example.org/search?q=war took 12ms")).toBe(
      "https://ai.example.org/search took 12ms",
    );
    expect(scrubText("Key (email)=(ed.itor+desk@news.example.org) already exists")).toBe(
      "Key (email)=(<email>) already exists",
    );
    expect(scrubText("from 203.0.113.7 and 2001:db8:85a3::8a2e:370:7334 and ::1")).toBe(
      "from <ip> and <ip> and <ip>",
    );
    expect(scrubText('"Cf-Access-Jwt-Assertion":["eyJhbGciOi.eyJlbWFpbCI6.c2lnbmF0dXJl"]')).toBe(
      '"Cf-Access-Jwt-Assertion":["<jwt>"]',
    );
    expect(
      scrubText("https://api.telegram.org/bot123456:AAH-x_9kLmNoPqRsTuVwXyZ012/sendMessage"),
    ).toBe("https://api.telegram.org/bot<token>/sendMessage");
    expect(scrubText("2026-11-02T14:02:06Z run a1b2 took 3.2s")).toBe(
      "2026-11-02T14:02:06Z run a1b2 took 3.2s",
    );
  });
});

describe("ScrubbingSpanProcessor", () => {
  it("removes reader data from a span before it is exported", () => {
    const telemetry = recordTelemetry();
    const span = trace.getTracer("test").startSpan("GET /newsroom", {
      kind: SpanKind.SERVER,
      attributes: {
        "client.address": "203.0.113.7",
        "net.peer.ip": "203.0.113.7",
        "user_agent.original": "Mozilla/5.0",
        "http.user_agent": "Mozilla/5.0",
        "http.request.header.cf-connecting-ip": "203.0.113.7",
        "url.full": "https://ai.example.org/challenge/1?k=token",
        "url.query": "k=token",
        "http.target": "/challenge/1?k=token",
        "http.route": "/newsroom",
      },
    });
    span.recordException(new Error("duplicate key: (email)=(a@b.org)"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: "for a@b.org" });
    span.end();

    const [exported] = telemetry.spans();
    expect(exported?.attributes).toEqual({
      "url.full": "https://ai.example.org/challenge/1",
      "http.target": "/challenge/1",
      "http.route": "/newsroom",
    });
    expect(exported?.events[0]?.attributes?.["exception.message"]).toBe(
      "duplicate key: (email)=(<email>)",
    );
    expect(exported?.status.message).toBe("for <email>");
  });
});
