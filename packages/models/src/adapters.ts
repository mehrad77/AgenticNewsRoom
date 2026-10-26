import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessageLike } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAICompletions } from "@langchain/openai";
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

const TIMEOUT_MS = 120_000;

/**
 * LangChain chat models with their own retries and timeouts off: the gateway decides what a failure means.
 * OpenAI-compatible providers use Chat Completions only, so no built-in (web) tools exist.
 */
export const langchainClient: ClientFactory = (entry) => {
  const model: BaseChatModel =
    entry.kind === "google"
      ? new ChatGoogleGenerativeAI({ model: entry.model, apiKey: entry.apiKey, maxRetries: 0 })
      : new ChatOpenAICompletions({
          model: entry.model,
          apiKey: entry.apiKey,
          maxRetries: 0,
          configuration: { baseURL: entry.baseUrl },
        });
  return {
    invoke(messages, { tools, toolChoice, signal }) {
      if (!tools?.length) return withTimeout((s) => model.invoke(messages, { signal: s }), signal);
      if (!model.bindTools) throw new Error(`${entry.id} cannot bind tools`);
      const bound = model.bindTools(tools, toolChoice ? { tool_choice: toolChoice } : undefined);
      return withTimeout((s) => bound.invoke(messages, { signal: s }), signal);
    },
  };
};

/**
 * Every provider call gets the same deadline (Gemini's client has none of its own). On expiry
 * it rejects with a TimeoutError, which the gateway treats as an outage, then aborts the call.
 */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no answer after ${TIMEOUT_MS / 1000}s`);
      error.name = "TimeoutError";
      reject(error);
      controller.abort(error);
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
  }
}
