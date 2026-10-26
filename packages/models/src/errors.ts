/**
 * What a failed model call means for the chain:
 * - rate-limited: cool this model down and try the next one;
 * - unavailable: a short cooldown, then the next one;
 * - gone: the model was retired or renamed; skip it until restart;
 * - fatal: a bad key or a bad request; stop, because the next model would hide a real bug.
 */
export type FailureKind = "rate-limited" | "unavailable" | "gone" | "fatal";

export interface Failure {
  kind: FailureKind;
  /** When the provider said to come back, if it did. */
  retryAfterMs?: number;
  message: string;
}

export interface Attempt {
  catalogId: string;
  outcome: "ok" | "skipped" | FailureKind;
  detail?: string;
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Every model in the chain was skipped or failed. The run ends as an error, so the gate holds. */
export class AllModelsExhausted extends Error {
  readonly attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    super(
      `every model in the chain failed or was skipped: ${attempts
        .map((a) => `${a.catalogId} ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`)
        .join("; ")}`,
    );
    this.name = "AllModelsExhausted";
    this.attempts = attempts;
  }
}

/** A failure that falling back would hide: a bad key, a bad request, a bug. */
export class ModelCallFailed extends Error {
  readonly attempts: Attempt[];
  constructor(catalogId: string, message: string, attempts: Attempt[], cause: unknown) {
    super(`${catalogId}: ${message}`, { cause });
    this.name = "ModelCallFailed";
    this.attempts = attempts;
  }
}

type ErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  headers?: unknown;
  response?: { status?: unknown; headers?: unknown };
  error?: { code?: unknown; type?: unknown };
  errorDetails?: unknown;
  cause?: unknown;
};

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_)/;

/** Sorts an error from any provider SDK (OpenAI-compatible or Gemini) into a FailureKind. */
export function classify(error: unknown, now = Date.now()): Failure {
  const e = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  const message = String(e.message ?? error).slice(0, 300);
  const status = [e.status, e.statusCode, e.response?.status].find(
    (s): s is number => typeof s === "number",
  );
  const codes = [e.code, e.error?.code, e.error?.type].map((c) => String(c ?? ""));
  const retryAfterMs = retryAfter(e, now);

  // The text match is for SDK errors without a status; a 401 or 400 that mentions quota is fatal.
  const limitText = status === undefined && /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message);
  if (status === 429 || status === 402 || limitText) {
    return { kind: "rate-limited", retryAfterMs, message };
  }
  const retired =
    codes.some((c) => /model_not_found|model_decommissioned/.test(c)) ||
    /model.{0,80}(not found|does not exist|decommissioned|no longer (available|supported))/i.test(
      message,
    );
  if (status === 404 || ((status === 400 || status === undefined) && retired)) {
    return { kind: "gone", message };
  }
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 425 || status >= 500) {
      return { kind: "unavailable", retryAfterMs, message };
    }
    return { kind: "fatal", message };
  }
  // The OpenAI SDK's APIConnectionError keeps the name "Error" and hides the network code two
  // causes deep (Error → TypeError "fetch failed" → { code: "ECONNRESET" }).
  const chain: ErrorLike[] = [];
  for (
    let c: unknown = e;
    c && typeof c === "object" && chain.length < 5;
    c = (c as ErrorLike).cause
  ) {
    chain.push(c as ErrorLike);
  }
  if (
    chain.some(
      (c) =>
        /TimeoutError|APIConnection/.test(String(c.name ?? "")) ||
        /APIConnection/.test(String((c as object).constructor?.name ?? "")) ||
        NETWORK_CODES.test(String(c.code ?? "")),
    ) ||
    /fetch failed|socket hang up|timed? ?out|connection error/i.test(message)
  ) {
    return { kind: "unavailable", message };
  }
  return { kind: "fatal", message };
}

const header = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

/** Parses Groq's "1h2m3.5s", "7.66s" and "120ms" into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  return parts.reduce((sum, [, n, u]) => sum + Number(n) * unit[u as keyof typeof unit], 0);
}

/**
 * How long the provider asked us to wait: Retry-After (seconds or a date), Groq's
 * x-ratelimit-reset-*, OpenRouter's x-ratelimit-reset (epoch ms), Gemini's RetryInfo.
 */
function retryAfter(e: ErrorLike, now: number): number | undefined {
  const headers = e.headers ?? e.response?.headers;
  const valid = (ms: number) => Number.isFinite(ms) && ms > 0;
  const cap = (ms: number) => Math.min(ms, MAX_RETRY_AFTER_MS);
  // Retry-After answers this request; Groq's reset headers describe whole windows (a day for
  // requests), so they only count when Retry-After is missing.
  const ra = header(headers, "retry-after");
  if (ra) {
    const seconds = Number(ra);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(ra) - now;
    if (valid(ms)) return cap(ms);
  }
  const waits: number[] = [];
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const d = header(headers, name);
    const ms = d === undefined ? undefined : parseDuration(d);
    if (ms !== undefined) waits.push(ms);
  }
  const reset = Number(header(headers, "x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) waits.push(reset > 1e12 ? reset - now : reset * 1000);
  if (Array.isArray(e.errorDetails)) {
    for (const d of e.errorDetails as { retryDelay?: unknown }[]) {
      const ms = typeof d?.retryDelay === "string" ? parseDuration(d.retryDelay) : undefined;
      if (ms !== undefined) waits.push(ms);
    }
  }
  const known = waits.filter(valid);
  return known.length > 0 ? cap(Math.max(...known)) : undefined;
}
