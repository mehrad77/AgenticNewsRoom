import type { AIMessage, BaseMessageLike } from "@langchain/core/messages";
import {
  type ChatClient,
  type ClientFactory,
  type InvokeOptions,
  langchainClient,
} from "./adapters.ts";
import type { Catalog, CatalogEntry } from "./catalog.ts";
import { AllModelsExhausted, type Attempt, classify, ModelCallFailed } from "./errors.ts";
import { LimitTracker, UNAVAILABLE_COOLDOWN_MS } from "./limits.ts";

export interface ChatRequest extends InvokeOptions {
  /** Catalog ids in order, from the router. */
  chain: readonly string[];
  messages: BaseMessageLike[];
  /** The model that answered earlier in this run; tried first so a run changes model only when forced. */
  sticky?: string;
}

export interface ChatResult {
  message: AIMessage;
  /** The model that answered: what the Agent run row records. */
  catalogId: string;
  provider: string;
  model: string;
  family: string;
  usage: { input: number; output: number };
  /** Null when the catalog has no price for the model. */
  costUsd: number | null;
  attempts: Attempt[];
}

export interface GatewayOptions {
  client?: ClientFactory;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Calls a chain of models, falling through on rate limits, outages and retired models.
 * It never falls through on a bad key or a bad request, and it never picks models: the router does.
 */
export class ModelGateway {
  readonly #catalog: Catalog;
  readonly #factory: ClientFactory;
  readonly #limits: LimitTracker;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #clients = new Map<string, ChatClient>();

  constructor(catalog: Catalog, options: GatewayOptions = {}) {
    this.#catalog = catalog;
    this.#factory = options.client ?? langchainClient;
    this.#now = options.now ?? Date.now;
    this.#limits = new LimitTracker(this.#now);
    this.#log = options.log ?? ((line) => console.warn(`[models] ${line}`));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const order =
      req.sticky && req.chain.includes(req.sticky)
        ? [req.sticky, ...req.chain.filter((id) => id !== req.sticky)]
        : [...req.chain];
    const attempts: Attempt[] = [];
    for (const id of order) {
      const entry = this.#entry(id);
      const blocked = entry.apiKey
        ? this.#limits.blocked(entry)
        : `no ${entry.missingEnv.join(", ")}`;
      if (blocked) {
        attempts.push({ catalogId: id, outcome: "skipped", detail: blocked });
        continue;
      }
      this.#limits.recordRequest(entry);
      try {
        const message = await this.#client(entry).invoke(req.messages, {
          tools: req.tools,
          signal: req.signal,
        });
        const usage = {
          input: message.usage_metadata?.input_tokens ?? 0,
          output: message.usage_metadata?.output_tokens ?? 0,
        };
        this.#limits.recordSuccess(entry, usage.input + usage.output);
        attempts.push({ catalogId: id, outcome: "ok" });
        if (attempts.length > 1) this.#log(`${id} answered after ${describe(attempts)}`);
        return {
          message,
          catalogId: id,
          provider: entry.provider,
          model: entry.model,
          family: entry.family,
          usage,
          costUsd: entry.price
            ? (entry.price.in * usage.input + entry.price.out * usage.output) / 1e6
            : null,
          attempts,
        };
      } catch (error) {
        if (req.signal?.aborted) throw error;
        const failure = classify(error, this.#now());
        attempts.push({ catalogId: id, outcome: failure.kind, detail: failure.message });
        switch (failure.kind) {
          case "fatal":
            throw new ModelCallFailed(id, failure.message, attempts, error);
          case "rate-limited": {
            const wait = this.#limits.coolDown(entry, failure.retryAfterMs);
            const scope = entry.sharedQuota ? `${entry.provider} account` : id;
            this.#log(`${id} rate-limited; cooling down ${scope} ${Math.ceil(wait / 1000)}s`);
            break;
          }
          case "unavailable":
            this.#limits.pause(entry, failure.retryAfterMs ?? UNAVAILABLE_COOLDOWN_MS);
            this.#log(`${id} unavailable: ${failure.message}`);
            break;
          case "gone":
            this.#limits.disable(entry, failure.message);
            this.#log(`${id} (${entry.model}) is gone; fix the models file: ${failure.message}`);
            break;
        }
      }
    }
    throw new AllModelsExhausted(attempts);
  }

  #entry(id: string): CatalogEntry {
    const entry = this.#catalog.entries.get(id);
    if (!entry) throw new Error(`unknown model ${id}`);
    return entry;
  }

  #client(entry: CatalogEntry): ChatClient {
    let client = this.#clients.get(entry.id);
    if (!client) {
      client = this.#factory(entry);
      this.#clients.set(entry.id, client);
    }
    return client;
  }
}

const describe = (attempts: Attempt[]) =>
  attempts
    .slice(0, -1)
    .map((a) => `${a.catalogId} ${a.outcome}`)
    .join(", ");
