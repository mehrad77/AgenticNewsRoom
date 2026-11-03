// For tests: an in-memory SDK registered globally, so code under test that uses @opentelemetry/api
// records real spans and metrics, and nothing leaves the process. Call it before importing a module
// that creates metric instruments at load: a meter taken before a provider is set stays a no-op.
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type CollectionResult,
  MeterProvider,
  type MetricData,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { ScrubbingSpanProcessor } from "./scrub.ts";

class TestReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RecordedTelemetry {
  /** Finished spans, oldest first. */
  spans(): ReadableSpan[];
  /** Every metric now, by name. */
  metrics(): Promise<Map<string, MetricData>>;
  reset(): void;
}

let recorded: RecordedTelemetry | undefined;

/** Registers the in-memory SDK once per test file and returns it. */
export function recordTelemetry(): RecordedTelemetry {
  if (recorded) return recorded;
  const exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new ScrubbingSpanProcessor(), new SimpleSpanProcessor({ exporter })],
    }),
  );
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const reader = new TestReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  recorded = {
    spans: () => exporter.getFinishedSpans(),
    async metrics() {
      const { resourceMetrics }: CollectionResult = await reader.collect();
      const byName = new Map<string, MetricData>();
      for (const scope of resourceMetrics.scopeMetrics)
        for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
      return byName;
    },
    reset: () => exporter.reset(),
  };
  return recorded;
}
