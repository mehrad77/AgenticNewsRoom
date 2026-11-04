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

type Roles = ModelsConfig["roles"];

/**
 * Maps a role to an ordered chain of catalog models; @anr/models calls the chain and falls
 * through it. Agents name a role, never a model. The models file (config/models*.yaml) is the
 * catalog and the default chains; the platform admin may set other chains at the desk, which the
 * worker swaps in with setRoles() before each job.
 */
export class ModelRouter {
  private readonly config: ModelsConfig;
  private current: Roles;

  constructor(config: ModelsConfig) {
    this.config = config;
    this.current = config.roles;
  }

  /**
   * Puts chains in force, or with null the models file's again. The caller validates them against
   * this catalog first (@anr/config effectiveRoles). One assignment, so a run that already resolved
   * its chain keeps it, and the next resolve() sees the new one.
   */
  setRoles(roles: Roles | null): void {
    this.current = roles ?? this.config.roles;
  }

  /** The chains in force. */
  roles(): Roles {
    return this.current;
  }

  static fromFile(path: string): ModelRouter {
    return new ModelRouter(loadModelsConfig(path));
  }

  resolve(role: AgentRole, ctx: RouteContext = {}): string[] {
    const roles = this.current;
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

  /** Provider and model name of a catalog model, for the Agent run row. */
  describe(id: string): { provider: string; model: string } {
    const model = this.config.models[id];
    if (!model) throw new Error(`unknown model ${id}`);
    return { provider: model.provider, model: model.model };
  }

  tts(): string {
    return this.config.tts;
  }
}
