import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { converse, MAX_TOOL_ROUNDS } from "./converse.ts";
import type { ChatLike } from "./model.ts";

const lookup = tool(async () => "a passage", {
  name: "read_lead",
  description: "read",
  schema: z.object({ id: z.string() }),
});

describe("converse", () => {
  it("offers no tools once the model has been told to answer", async () => {
    const offered: boolean[] = [];
    // A model that calls a tool whenever it may.
    const model: ChatLike = {
      async invoke(_m: BaseMessage[], options?: { tools?: unknown[] }) {
        offered.push(Boolean(options?.tools?.length));
        return options?.tools?.length
          ? new AIMessage({
              content: "",
              tool_calls: [{ name: "read_lead", args: { id: "x" }, id: `c${offered.length}` }],
            })
          : new AIMessage("the answer");
      },
    };
    const turn = await converse(model, [], "write", [lookup]);
    expect(turn.at(-1)?.content).toBe("the answer");
    expect(offered).toEqual([...Array(MAX_TOOL_ROUNDS + 1).fill(true), false]);
  });
});
