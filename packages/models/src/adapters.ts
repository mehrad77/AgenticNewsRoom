import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessageLike } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAICompletions } from "@langchain/openai";
import type { CatalogEntry } from "./catalog.ts";

export interface InvokeOptions {
  tools?: BindToolsInput[];
  signal?: AbortSignal;
}

/** The one thing the gateway needs from a provider: a chat call that throws the SDK's error. */
export interface ChatClient {
  invoke(messages: BaseMessageLike[], options: InvokeOptions): Promise<AIMessage>;
}

export type ClientFactory = (entry: CatalogEntry) => ChatClient;

const TIMEOUT_MS = 120_000;

/**
 * LangChain chat models with their own retries off: the gateway decides what a failure means.
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
          timeout: TIMEOUT_MS,
          configuration: { baseURL: entry.baseUrl },
        });
  return {
    async invoke(messages, { tools, signal }) {
      if (!tools?.length) return model.invoke(messages, { signal });
      if (!model.bindTools) throw new Error(`${entry.id} cannot bind tools`);
      return model.bindTools(tools).invoke(messages, { signal });
    },
  };
};
