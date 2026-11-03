// What apps import from @anr/telemetry; the SDK itself starts in register.ts. Libraries
// (@anr/db, @anr/models) use @opentelemetry/api alone, which is a no-op until the SDK is started.
export { setHttpRoute } from "./http.ts";
export { bridgeConsole } from "./logs.ts";
export {
  DROPPED_ATTRIBUTES,
  scrubAttributes,
  scrubText,
  URL_ATTRIBUTES,
  withoutQuery,
} from "./scrub.ts";

export const SDK_KEY = Symbol.for("anr.telemetry.sdk");
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Telemetry runs only where an OTLP endpoint is set and the SDK is not turned off. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) && env.OTEL_SDK_DISABLED !== "true";
}

let stopping: Promise<void> | undefined;

/**
 * Exports what is buffered and stops the SDK; at most 5 seconds, so a collector that is down never
 * holds up a stop. Call it once before process.exit(); later calls wait for the first.
 */
export function shutdownTelemetry(): Promise<void> {
  const sdk = (globalThis as Record<symbol, { shutdown(): Promise<void> } | undefined>)[SDK_KEY];
  if (!sdk) return Promise.resolve();
  stopping ??= Promise.race([
    sdk.shutdown().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
  ]);
  return stopping;
}
