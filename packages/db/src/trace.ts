// Traces that outlive one job (D137). A publication's trace starts at its assignment and its
// context is stored on the publication; work done for it later continues that trace, linked to the
// span that did it (a sweep's). Leads store the context of the ingest span that stored them.
import {
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const tracer = trace.getTracer("@anr/db");

/** The active span's W3C traceparent; null with no span or no SDK. */
export function traceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** A link to the span a stored traceparent names, or none. */
export function linkTo(stored: string | null | undefined): Link[] {
  if (!stored) return [];
  const spanContext = trace.getSpanContext(
    propagation.extract(ROOT_CONTEXT, { traceparent: stored }),
  );
  return spanContext ? [{ context: spanContext }] : [];
}

/**
 * Runs `fn` in a span continuing a stored trace (a publication's), linked to the span active now
 * (the sweep that found it). Without a stored trace the span starts its own. A throw marks the
 * span as an error and is rethrown.
 */
export async function inStoredTrace<T>(
  stored: string | null | undefined,
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = stored ? propagation.extract(ROOT_CONTEXT, { traceparent: stored }) : ROOT_CONTEXT;
  const current = trace.getSpanContext(context.active());
  const links = [...(options.links ?? []), ...(current ? [{ context: current }] : [])];
  return tracer.startActiveSpan(name, { ...options, links }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
