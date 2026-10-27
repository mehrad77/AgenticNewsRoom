import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessageLike } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAICompletions } from "@langchain/openai";
import { Agent, fetch as undiciFetch } from "undici";
import type { CatalogEntry } from "./catalog.ts";

export interface InvokeOptions {
  tools?: BindToolsInput[];
  /** "any" makes the model call one of the tools (the probe uses it). */
  toolChoice?: "any";
  signal?: AbortSignal;
}

/** The one thing the gateway needs from a provider: a chat call that throws the SDK's error. */
export interface ChatClient {
  invoke(messages: BaseMessageLike[], options: InvokeOptions): Promise<AIMessage>;
}

export type ClientFactory = (entry: CatalogEntry) => ChatClient;

/**
 * LangChain chat models with their own retries and timeouts off: the gateway decides what a failure means.
 * Temperature 0: agents answer to a schema and should answer the same way twice.
 * OpenAI-compatible providers use Chat Completions only, so no built-in (web) tools exist.
 */
export const langchainClient: ClientFactory = (entry) => {
  const model: BaseChatModel =
    entry.kind === "google"
      ? new ChatGoogleGenerativeAI({
          model: entry.model,
          apiKey: entry.apiKey,
          temperature: 0,
          maxRetries: 0,
        })
      : new ChatOpenAICompletions({
          model: entry.model,
          apiKey: entry.apiKey,
          temperature: 0,
          maxRetries: 0,
          configuration: { baseURL: entry.baseUrl, ...slowServer(entry.timeoutMs) },
        });
  return {
    invoke(messages, { tools, toolChoice, signal }) {
      const ms = entry.timeoutMs;
      if (!tools?.length)
        return withTimeout((s) => model.invoke(messages, { signal: s }), ms, signal);
      if (!model.bindTools) throw new Error(`${entry.id} cannot bind tools`);
      const bound = model.bindTools(tools, toolChoice ? { tool_choice: toolChoice } : undefined);
      return withTimeout((s) => bound.invoke(messages, { signal: s }), ms, signal);
    },
  };
};

/**
 * Node's fetch gives up after 300 s without response headers, and a non-streamed answer has none
 * until it is complete. A provider allowed longer (a local model, D84) gets a fetch whose own
 * timeouts match its deadline; the others keep the default.
 */
const NODE_HEADERS_TIMEOUT_MS = 300_000;
function slowServer(timeoutMs: number) {
  if (timeoutMs <= NODE_HEADERS_TIMEOUT_MS) return {};
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return { fetch: undiciFetch as unknown as typeof fetch, fetchOptions: { dispatcher } };
}

/**
 * Every provider call gets a deadline, the provider's `timeout_s` or 120 s (Gemini's client has none of its own). On expiry
 * it rejects with a TimeoutError, which the gateway treats as an outage, then aborts the call.
 */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no answer after ${timeoutMs / 1000}s`);
      error.name = "TimeoutError";
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
  }
}
