import type { AgentRole } from "@anr/core";
import { loadModelsConfig, type ModelsConfig } from "@anr/models";

export interface RouteContext {
  /** The format being written; the desk may use a cheaper chain for some formats. */
  format?: string;
  /**
   * Every model family that wrote the story, from its desk Agent runs (a run may have fallen
   * back mid-way). Required for the fact-checker.
   */
  writerFamilies?: readonly string[];
}

/**
 * Maps a role to an ordered chain of catalog models; @anr/models calls the chain and falls
 * through it. Agents name a role, never a model. Changing a model or vendor is a change to
 * config/models*.yaml, not to code.
 */
export class ModelRouter {
  private readonly config: ModelsConfig;

  constructor(config: ModelsConfig) {
    this.config = config;
  }

  static fromFile(path: string): ModelRouter {
    return new ModelRouter(loadModelsConfig(path));
  }

  resolve(role: AgentRole, ctx: RouteContext = {}): string[] {
    const roles = this.config.roles;
    switch (role) {
      case "desk":
        return (ctx.format && roles.desk.by_format?.[ctx.format]) || roles.desk.default;
      case "fact-checker": {
        // Invariant 4: the writer never checks its own facts, whichever provider served it.
        if (!ctx.writerFamilies?.length)
          throw new Error("fact-checker needs the writer's families");
        const chain = roles["fact-checker"].filter(
          (id) => !ctx.writerFamilies?.includes(this.family(id)),
        );
        if (chain.length === 0) {
          throw new Error(`no fact-checker model outside ${ctx.writerFamilies.join(", ")}`);
        }
        return chain;
      }
      default:
        return roles[role];
    }
  }

  /** The family of a catalog model: what the Agent run's model is compared by. */
  family(id: string): string {
    const model = this.config.models[id];
    if (!model) throw new Error(`unknown model ${id}`);
    return model.family;
  }

  tts(): string {
    return this.config.tts;
  }
}
