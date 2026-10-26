import type { CatalogEntry, Limits } from "./catalog.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Cooldown after a 429 that named no reset time: 1 min, doubling per strike, up to 1 h. */
const BACKOFF_BASE_MS = MINUTE;
const BACKOFF_MAX_MS = 60 * MINUTE;
/** Cooldown after a 5xx, timeout or network error. */
export const UNAVAILABLE_COOLDOWN_MS = 30_000;

interface Usage {
  /** Request start times. */
  requests: number[];
  /** [time, tokens] per successful call. */
  tokens: [number, number][];
}

interface ModelState {
  cooldownUntil: number;
  strikes: number;
  disabled?: string;
}

/**
 * In-memory rate-limit state for one process (D54: one laptop). Requests count against the
 * model's and its provider's published limits; cooldowns and retirements are per model.
 */
export class LimitTracker {
  readonly #now: () => number;
  readonly #usage = new Map<string, Usage>();
  readonly #models = new Map<string, ModelState>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Why the model cannot be called now, or undefined if it can. */
  blocked(entry: CatalogEntry): string | undefined {
    const state = this.#models.get(entry.id);
    if (state?.disabled) return `disabled: ${state.disabled}`;
    const now = this.#now();
    if (state && state.cooldownUntil > now) {
      return `cooling down for ${Math.ceil((state.cooldownUntil - now) / 1000)}s`;
    }
    return (
      this.#overLimit(`model:${entry.id}`, entry.limits, "model") ??
      this.#overLimit(`provider:${entry.provider}`, entry.providerLimits, entry.provider)
    );
  }

  recordRequest(entry: CatalogEntry): void {
    const now = this.#now();
    for (const key of this.#keys(entry)) this.#use(key).requests.push(now);
  }

  recordSuccess(entry: CatalogEntry, tokens: number): void {
    const now = this.#now();
    for (const key of this.#keys(entry)) this.#use(key).tokens.push([now, tokens]);
    const state = this.#models.get(entry.id);
    if (state) state.strikes = 0;
  }

  /** After a 429 (or 5xx): wait as long as the provider said, else back off. */
  coolDown(entry: CatalogEntry, retryAfterMs?: number): number {
    const state = this.#state(entry.id);
    state.strikes += 1;
    const wait =
      retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (state.strikes - 1), BACKOFF_MAX_MS);
    state.cooldownUntil = this.#now() + wait;
    return wait;
  }

  disable(entry: CatalogEntry, reason: string): void {
    this.#state(entry.id).disabled = reason;
  }

  #keys(entry: CatalogEntry): string[] {
    return [`model:${entry.id}`, `provider:${entry.provider}`];
  }

  #use(key: string): Usage {
    let usage = this.#usage.get(key);
    if (!usage) {
      usage = { requests: [], tokens: [] };
      this.#usage.set(key, usage);
    }
    const since = this.#now() - DAY;
    usage.requests = usage.requests.filter((t) => t > since);
    usage.tokens = usage.tokens.filter(([t]) => t > since);
    return usage;
  }

  #state(id: string): ModelState {
    let state = this.#models.get(id);
    if (!state) {
      state = { cooldownUntil: 0, strikes: 0 };
      this.#models.set(id, state);
    }
    return state;
  }

  #overLimit(key: string, limits: Limits | undefined, who: string): string | undefined {
    if (!limits) return undefined;
    const usage = this.#use(key);
    const minuteAgo = this.#now() - MINUTE;
    const lastMinute = usage.requests.filter((t) => t > minuteAgo).length;
    const tokens = (since: number) =>
      usage.tokens.reduce((sum, [t, n]) => (t > since ? sum + n : sum), 0);
    if (limits.rpm !== undefined && lastMinute >= limits.rpm) return `${who} rpm limit`;
    if (limits.rpd !== undefined && usage.requests.length >= limits.rpd) return `${who} rpd limit`;
    if (limits.tpm !== undefined && tokens(minuteAgo) >= limits.tpm) return `${who} tpm limit`;
    if (limits.tpd !== undefined && tokens(0) >= limits.tpd) return `${who} tpd limit`;
    return undefined;
  }
}
