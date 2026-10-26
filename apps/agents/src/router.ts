import { readFileSync } from "node:fs";
import type { AgentRole } from "@anr/core";
import { ModelsSchema } from "@anr/schemas";
import { parse } from "yaml";

type ModelsConfig = ModelsSchema;
export interface ModelChoice {
  provider: string;
  model: string;
}

export interface RouteContext {
  /** The format being written; the desk may use a cheaper model for some formats. */
  format?: string;
  /** The model that wrote the story under check. Required for the fact-checker. */
  writerModel?: string;
}

/**
 * Maps a role to a provider and model. Agents name a role, never a model.
 * Changing a model or vendor is a change to config/models.yaml, not to code.
 */
export class ModelRouter {
  private readonly config: ModelsConfig;

  constructor(config: ModelsConfig) {
    this.config = config;
  }

  static fromFile(path: string): ModelRouter {
    return new ModelRouter(ModelsSchema.parse(parse(readFileSync(path, "utf8"))));
  }

  resolve(role: AgentRole, ctx: RouteContext = {}): ModelChoice {
    const roles = this.config.roles;
    switch (role) {
      case "desk":
        return (ctx.format && roles.desk.by_format?.[ctx.format]) || roles.desk.default;
      case "fact-checker": {
        if (!ctx.writerModel) throw new Error("fact-checker needs the writer's model");
        const choice = roles["fact-checker"].candidates.find((c) => c.model !== ctx.writerModel);
        if (!choice) throw new Error(`no fact-checker model differs from ${ctx.writerModel}`);
        return choice;
      }
      default:
        return roles[role];
    }
  }

  tts(): ModelChoice {
    return this.config.tts;
  }
}
