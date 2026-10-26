// Chat models for the router's choices. Keys come only from the environment (D47).
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { ModelChoice } from "../router.ts";

export function chatModel(choice: ModelChoice, env = process.env): BaseChatModel {
  if (choice.provider !== "gemini")
    throw new Error(`no chat model for provider ${choice.provider}`);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set; summaries wait until it is (.env)");
  // maxRetries 0: LangChain would otherwise retry a 429 itself, hiding it from the throttle.
  return new ChatGoogleGenerativeAI({ model: choice.model, apiKey, temperature: 0, maxRetries: 0 });
}
