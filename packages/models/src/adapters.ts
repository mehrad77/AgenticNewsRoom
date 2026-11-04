import { ChatAnthropic } from "@langchain/anthropic";
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
 * Most tokens one call may write, thinking included: room for the longest JSON answer (a desk's
 * claims and rendition) and a model's reasoning, while a model that loops stops in minutes, not
 * at its timeout or its context's end.
 */
export const MAX_OUTPUT_TOKENS = 8_192;

/**
 * LangChain chat models with their own retries and timeouts off: the gateway decides what a failure means.
 * Temperature 0 where the API takes one: agents answer to a schema and should answer the same way twice.
 * OpenAI-compatible providers use Chat Completions only, so no built-in (web) tools exist.
 * Anthropic gets only the tools ANR binds; its server tools (web search, fetch, code) are never
 * added (invariant 2).
 */
export const langchainClient: ClientFactory = (entry) => {
  const model = chatModel(entry);
  // Anthropic rejects a forced tool choice while a model thinks (Opus and Sonnet 5.5 always do),
  // so "any" is sent as "auto"; the probe still sees whether a tool was called.
  const choice = (c: "any") => (entry.kind === "anthropic" ? "auto" : c);
  return {
    invoke(messages, { tools, toolChoice, signal }) {
      const ms = entry.timeoutMs;
      if (!tools?.length)
        return withTimeout((s) => model.invoke(messages, { signal: s }), ms, signal);
      if (!model.bindTools) throw new Error(`${entry.id} cannot bind tools`);
      const bound = model.bindTools(
        tools,
        toolChoice ? { tool_choice: choice(toolChoice) } : undefined,
      );
      return withTimeout((s) => bound.invoke(messages, { signal: s }), ms, signal);
    },
  };
};

function chatModel(entry: CatalogEntry): BaseChatModel {
  switch (entry.kind) {
    case "google":
      return new ChatGoogleGenerativeAI({
        model: entry.model,
        apiKey: entry.apiKey,
        temperature: 0,
        maxRetries: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
    case "anthropic":
      // No temperature, top_p or top_k: the Messages API answers 400 to any of them (since
      // 2026-10-21), and ChatAnthropic sends none it is not given. No thinking parameter either:
      // the models that think decide how much themselves, and a budget is a 400.
      // The URL is pinned so ANTHROPIC_BASE_URL or a LangSmith gateway in the env cannot redirect calls.
      return new ChatAnthropic({
        model: entry.model,
        apiKey: entry.apiKey,
        anthropicApiUrl: "https://api.anthropic.com",
        maxRetries: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
        clientOptions: slowServer(entry.timeoutMs),
      });
    default:
      return new ChatOpenAICompletions({
        model: entry.model,
        apiKey: entry.apiKey,
        temperature: 0,
        maxRetries: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(entry.reasoningEffort && {
          modelKwargs: { reasoning_effort: entry.reasoningEffort },
        }),
        configuration: { baseURL: entry.baseUrl, ...slowServer(entry.timeoutMs) },
      });
  }
}

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
