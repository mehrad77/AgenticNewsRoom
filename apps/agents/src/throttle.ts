// Pacing for model calls: a minimum gap between calls from this worker, and a pause after the
// provider says "too many requests". Provider limits depend on the API key's tier, so the rate
// is a deployment setting (ANR_SUMMARISER_RPM), not newsroom config.

export class Throttle {
  private nextAt = 0;
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    gapMs: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.gapMs = gapMs;
    this.now = now;
    this.sleep = sleep;
  }

  static perMinute(rpm: number): Throttle {
    if (!(rpm > 0)) throw new Error(`requests per minute must be positive, not ${rpm}`);
    return new Throttle(60_000 / rpm);
  }

  /** How long until the next call may start. */
  delayMs(): number {
    return Math.max(0, this.nextAt - this.now());
  }

  /** Reserves the next slot and waits for it. */
  async wait(): Promise<void> {
    const now = this.now();
    const start = Math.max(now, this.nextAt);
    this.nextAt = start + this.gapMs;
    if (start > now) await this.sleep(start - now);
  }

  /** No calls for `ms` (after a rate-limit answer). */
  pauseFor(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + ms);
  }
}

const HOUR = 60 * 60_000;

/**
 * How long to wait after a rate-limit error, or null for any other error. Gemini answers 429
 * (RESOURCE_EXHAUSTED) with a suggested `retryDelay`; a daily quota means waiting much longer.
 */
export function rateLimitDelayMs(error: unknown): number | null {
  const e = (error ?? {}) as { status?: unknown; message?: unknown; errorDetails?: unknown };
  const message = String(e.message ?? "");
  const limited = e.status === 429 || /\b429\b|RESOURCE_EXHAUSTED|Too Many Requests/i.test(message);
  if (!limited) return null;
  const text = `${JSON.stringify(e.errorDetails ?? [])} ${message}`;
  if (/PerDay/i.test(text)) return HOUR;
  const suggested = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/.exec(text);
  return suggested ? Math.ceil(Number(suggested[1]) * 1000) : 60_000;
}
