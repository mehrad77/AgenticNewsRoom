// The summariser's model: the gateway called through the role's chain (D72). Keys come only from
// the environment (D47); the gateway skips models without one.

import type { ModelGateway } from "@anr/models";
import type { BaseMessage } from "@langchain/core/messages";
import { type Meter, meteredModel } from "../model.ts";
import type { ChatLike } from "./graph.ts";

export interface RunModel extends ChatLike {
  /** The model that answered last, for the Agent run row; undefined before the first answer. */
  answered?(): { provider: string; model: string } | undefined;
  /** Tokens, cost and families over the run's calls (D76, D71). */
  meter?: Meter;
}

export type ModelFactory = (chain: readonly string[]) => RunModel;

export function gatewayModel(
  gateway: Pick<ModelGateway, "chat">,
  chain: readonly string[],
): RunModel {
  const model = meteredModel(gateway, chain);
  return {
    invoke: (messages: BaseMessage[]) => model.invoke(messages),
    answered: () => model.meter.answered,
    meter: model.meter,
  };
}
