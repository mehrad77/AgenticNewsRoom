// Telemetry carries no reader data (D137): no client address, user agent, query string or email
// address leaves an app. The collector drops the same attributes again (infra/observability/collector.yaml), so a
// span from an app without this processor is scrubbed too.
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";

/** Dropped from every span: old and current semantic-convention names. */
export const DROPPED_ATTRIBUTES: readonly string[] = [
  "client.address",
  "client.port",
  "http.client_ip",
  "net.peer.ip",
  "net.peer.port",
  "net.sock.peer.addr",
  "net.sock.peer.port",
  "network.peer.address",
  "network.peer.port",
  "user_agent.original",
  "user_agent.name",
  "user_agent.version",
  "user_agent.synthetic.type",
  "http.user_agent",
  "url.query",
  "enduser.id",
  "user.id",
  "user.email",
];
/** Request and response headers, whatever their name (`http.request.header.cf-connecting-ip`). */
const DROPPED_PREFIXES = ["http.request.header.", "http.response.header."];
/** Kept without their query string: a reader's challenge link carries its token there (D114). */
export const URL_ATTRIBUTES: readonly string[] = [
  "url.full",
  "url.original",
  "http.url",
  "http.target",
];

export const withoutQuery = (url: string): string => url.replace(/[?#].*$/s, "");

/**
 * In free text (log lines, error messages, URLs): a JWT (Access's carries an email), a Telegram bot
 * token (in the path of every Bot API call), a query string, an email address, an IP address.
 */
const TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"],
  [/\bbot\d+:[\w-]{20,}/g, "bot<token>"],
  [/\?[^\s"'<>?]*=[^\s"'<>]*/g, ""],
  [/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, "<email>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  // Four or more groups, or a `::`: times such as 14:02:06 are left alone.
  [
    /(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi,
    "<ip>",
  ],
];

export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Removes reader data from attributes in place. */
export function scrubAttributes(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (DROPPED_ATTRIBUTES.includes(key) || DROPPED_PREFIXES.some((p) => key.startsWith(p))) {
      delete attributes[key];
    } else if (typeof value === "string") {
      attributes[key] = scrubText(URL_ATTRIBUTES.includes(key) ? withoutQuery(value) : value);
    }
  }
}

/** Scrubs each span while it can still change, before any exporter sees it. */
export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parent: Context): void {}
  onEnding(span: Span): void {
    scrubAttributes(span.attributes as Record<string, unknown>);
    // Recorded exceptions: a constraint error's message can name the row's values.
    for (const event of span.events)
      if (event.attributes) scrubAttributes(event.attributes as Record<string, unknown>);
    if (span.status.message) span.status.message = scrubText(span.status.message);
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
