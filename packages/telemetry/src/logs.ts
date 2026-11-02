// The apps log with console.*; each line also becomes an OpenTelemetry log record, which carries the
// active span's trace and span ids, so a log line in Grafana opens its trace (D137).
import { format } from "node:util";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api";
import { scrubText } from "./scrub.ts";

const LEVELS = [
  ["debug", SeverityNumber.DEBUG, "DEBUG"],
  ["log", SeverityNumber.INFO, "INFO"],
  ["info", SeverityNumber.INFO, "INFO"],
  ["warn", SeverityNumber.WARN, "WARN"],
  ["error", SeverityNumber.ERROR, "ERROR"],
] as const;

/**
 * Wraps console's methods: each still writes to stdout or stderr (Docker's log), and emits a
 * record without reader data (scrubText). A record emitted while one is being emitted is dropped, so nothing can loop.
 */
export function bridgeConsole(logger: Logger = logs.getLogger("console")): () => void {
  const originals = LEVELS.map(([method]) => [method, console[method]] as const);
  let emitting = false;
  for (const [method, severityNumber, severityText] of LEVELS) {
    const write = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      write(...args);
      if (emitting) return;
      emitting = true;
      try {
        logger.emit({ severityNumber, severityText, body: scrubText(format(...args)) });
      } finally {
        emitting = false;
      }
    };
  }
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}
