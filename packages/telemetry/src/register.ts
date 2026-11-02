// Loaded before the app with `node --import @anr/telemetry/register` (D137). With
// OTEL_EXPORTER_OTLP_ENDPOINT set it starts the OpenTelemetry SDK: traces, metrics and logs over
// OTLP to the collector, and the HTTP, fetch and pg instrumentation. Without it (tests, dev without
// the telemetry stack) it does nothing, and every span and metric the code makes is a no-op.
import { hostname } from "node:os";
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { register as registerHooks } from "import-in-the-middle/register-hooks.mjs";
import { SDK_KEY, shutdownTelemetry, telemetryEnabled } from "./index.ts";
import { bridgeConsole } from "./logs.ts";
import { ScrubbingSpanProcessor } from "./scrub.ts";

if (telemetryEnabled()) {
  // ESM imports are patched through Node's in-thread module hooks, only for the modules the
  // instrumentation below wraps.
  registerHooks({ include: ["http", "https", "node:http", "node:https", "pg", "pg-pool"] });
  // The SDK's own warnings (an export that failed) go straight to stderr: through console they
  // would become log records that fail to export in turn.
  diag.setLogger(
    {
      error: (...a) => process.stderr.write(`[otel] ${a.join(" ")}\n`),
      warn: (...a) => process.stderr.write(`[otel] ${a.join(" ")}\n`),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );

  const sdk = new NodeSDK({
    // npm_package_name is set by `pnpm start` and `pnpm dev`: @anr/agents → agents.
    serviceName:
      process.env.OTEL_SERVICE_NAME ??
      process.env.npm_package_name?.replace(/^@anr\//, "") ??
      "unknown",
    // Merged with OTEL_RESOURCE_ATTRIBUTES (service.version, deployment.environment.name).
    resource: resourceFromAttributes({
      "service.namespace": "anr",
      "service.instance.id": hostname(),
    }),
    spanProcessors: [
      new ScrubbingSpanProcessor(),
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000),
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      // Uptime checks and Compose health checks would be most of the traces.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === "/healthz" }),
      // fetch(): the agents worker's calls to ingestion, the verifier and model providers.
      new UndiciInstrumentation(),
      // Only queries inside a span: pg-boss polls every queue every few seconds, and heartbeats
      // beat every 30. Statements are recorded with their placeholders, never their values.
      new PgInstrumentation({
        requireParentSpan: true,
        enhancedDatabaseReporting: false,
        ignoreConnectSpans: true,
      }),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  bridgeConsole();
  (globalThis as Record<symbol, unknown>)[SDK_KEY] = sdk;

  // Flushes what is buffered when the process is told to stop. An app with its own handler awaits
  // shutdownTelemetry() before it exits; otherwise this ends the process as Node would have.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdownTelemetry().finally(() => {
        if (process.listenerCount(signal) === 1) process.exit(0);
      });
    });
  }
}
