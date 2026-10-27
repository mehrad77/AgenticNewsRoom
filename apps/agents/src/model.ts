// One run's model: the gateway called through the role's chain (D72), metered across every call
// of the run. The meter is what the Agent run row records: summed tokens and cost, and every
// family that answered, which the fact-checker must avoid (D71). A run stops at its token cap (D76).
import type { ChatResult, ModelGateway } from "@anr/models";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface Meter {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  families: Set<string>;
  calls: number;
  /** The model that answered last, for the Agent run row. */
  answered?: { provider: string; model: string };
}

export const newMeter = (): Meter => ({
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  families: new Set(),
  calls: 0,
});

export class TokenCapReached extends Error {
  readonly used: number;
  readonly cap: number;
  constructor(used: number, cap: number) {
    super(`the run used ${used} tokens; its format allows ${cap}`);
    this.used = used;
    this.cap = cap;
  }
}

export interface CallOptions {
  tools?: StructuredToolInterface[];
}

/** What a graph needs from a model: a LangChain chat model in tests, the gateway in the worker. */
export interface ChatLike {
  invoke(messages: BaseMessage[], options?: CallOptions): Promise<BaseMessage>;
}

export interface RunModel extends ChatLike {
  readonly meter: Meter;
}

export function meteredModel(
  gateway: Pick<ModelGateway, "chat">,
  chain: readonly string[],
  options: { tokenCap?: number; meter?: Meter } = {},
): RunModel {
  const meter = options.meter ?? newMeter();
  let sticky: string | undefined;
  return {
    meter,
    async invoke(messages, callOptions) {
      const used = meter.tokensIn + meter.tokensOut;
      if (options.tokenCap !== undefined && used >= options.tokenCap) {
        throw new TokenCapReached(used, options.tokenCap);
      }
      const result: ChatResult = await gateway.chat({
        chain,
        messages,
        sticky,
        tools: callOptions?.tools,
      });
      // A run changes model only when forced to (rate limit, outage).
      sticky = result.catalogId;
      record(meter, result);
      return result.message;
    },
  };
}

export function record(
  meter: Meter,
  result: Pick<ChatResult, "usage" | "costUsd" | "family" | "provider" | "model">,
): void {
  meter.tokensIn += result.usage.input;
  meter.tokensOut += result.usage.output;
  meter.costUsd += result.costUsd ?? 0;
  meter.families.add(result.family);
  meter.calls += 1;
  meter.answered = { provider: result.provider, model: result.model };
}

/**
 * A LangChain chat model metered like the gateway (tests): usage from the message, one family
 * per model, no cost. Lets a FakeListChatModel stand in for the gateway.
 */
export function meteredChat(
  model: {
    invoke(m: BaseMessage[]): Promise<BaseMessage>;
    bindTools?(t: StructuredToolInterface[]): { invoke(m: BaseMessage[]): Promise<BaseMessage> };
  },
  family: string,
  options: { tokenCap?: number } = {},
): RunModel {
  const meter = newMeter();
  return {
    meter,
    async invoke(messages, callOptions) {
      const used = meter.tokensIn + meter.tokensOut;
      if (options.tokenCap !== undefined && used >= options.tokenCap) {
        throw new TokenCapReached(used, options.tokenCap);
      }
      const bound =
        callOptions?.tools?.length && model.bindTools ? model.bindTools(callOptions.tools) : model;
      const message = await bound.invoke(messages);
      const usage = (
        message as { usage_metadata?: { input_tokens: number; output_tokens: number } }
      ).usage_metadata;
      record(meter, {
        usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 },
        costUsd: null,
        family,
        provider: "test",
        model: family,
      });
      return message;
    },
  };
}
