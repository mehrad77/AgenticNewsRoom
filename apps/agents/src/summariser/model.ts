// The summariser's model: the gateway called through the role's chain (D56). Keys come only from
// the environment (D47); the gateway skips models without one.

import type { ModelGateway } from "@anr/models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatLike } from "./graph.ts";

export interface RunModel extends ChatLike {
  /** The model that answered last, for the Agent run row; undefined before the first answer. */
  answered?(): { provider: string; model: string } | undefined;
}

export type ModelFactory = (chain: readonly string[]) => RunModel;

export function gatewayModel(
  gateway: Pick<ModelGateway, "chat">,
  chain: readonly string[],
): RunModel {
  let sticky: string | undefined;
  let answered: { provider: string; model: string } | undefined;
  return {
    async invoke(messages: BaseMessage[]) {
      const result = await gateway.chat({ chain, messages, sticky });
      // A run changes model only when forced to (rate limit, outage).
      sticky = result.catalogId;
      answered = { provider: result.provider, model: result.model };
      return result.message;
    },
    answered: () => answered,
  };
}
