// A job continues the trace that sent it (pg-boss's trace_context), and work for a publication found
// by a sweep continues the publication's stored trace, linked to the sweep (D137).
import { recordTelemetry } from "@anr/telemetry/testing";
import { SpanKind, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { createBoss } from "./boss.ts";
import { loadRootEnv, testDatabaseUrl } from "./testing.ts";
import { inStoredTrace, linkTo, traceparent } from "./trace.ts";

const telemetry = recordTelemetry();
loadRootEnv();
const appUrl = testDatabaseUrl(process.env.DATABASE_URL ?? "");
const tracer = trace.getTracer("test");

describe("traces across jobs", () => {
  it("processes a job in the trace of the request that sent it", async () => {
    const boss = createBoss(appUrl, "trace-test");
    await boss.start();
    const queue = `test-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await boss.createQueue(queue);
      const request = await tracer.startActiveSpan("POST /desk", async (span) => {
        await boss.send(queue, { newsroomId: "n1" });
        span.end();
        return span.spanContext();
      });
      const seen = new Promise<string | null>((resolve) => {
        void boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => {
          resolve(traceparent());
        });
      });
      const inJob = await seen;
      await boss.offWork(queue);

      expect(inJob?.split("-")[1]).toBe(request.traceId);
      const process = telemetry
        .spans()
        .find((s) => s.name === `process ${queue}` && s.kind === SpanKind.CONSUMER);
      const send = telemetry.spans().find((s) => s.name === `send ${queue}`);
      expect(process?.spanContext().traceId).toBe(request.traceId);
      expect(process?.parentSpanContext?.spanId).toBe(send?.spanContext().spanId);
    } finally {
      await boss.deleteQueue(queue).catch(() => {});
      await boss.stop({ graceful: false });
    }
  });

  it("continues a stored trace, linked to the span that found it", async () => {
    const stored = await tracer.startActiveSpan("process assign", async (span) => {
      span.end();
      return traceparent();
    });
    const [assign, sweep] = await tracer.startActiveSpan("process publish-sweep", async (span) => {
      await inStoredTrace(stored, "publish", { links: linkTo(stored) }, async () => {});
      span.end();
      return [stored?.split("-")[1], span.spanContext().spanId];
    });
    const publish = telemetry.spans().find((s) => s.name === "publish");
    expect(publish?.spanContext().traceId).toBe(assign);
    expect(publish?.links.map((l) => l.context.spanId)).toContain(sweep);
  });
});
