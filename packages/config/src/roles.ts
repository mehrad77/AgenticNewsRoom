// Role chains: which catalog models each agent role tries, in order (D23, D72). The models file
// holds the catalog and a default set of chains; the platform admin may replace the chains at the
// desk (`platform_settings` key `models.roles`). One rule decides which chains are in force, used
// by the agents worker and shown by the desk, so the desk shows what the agents run.
import { ModelsSchema, roleChains } from "@anr/schemas";

export type Roles = ModelsSchema["roles"];

/**
 * Problems with a set of role chains against a catalog, without a file name; empty means valid.
 * Every agent ends with the submit tool, so each model needs tool calling; budgets count spend
 * from prices, so each needs one (D82); the fact-checker drops every family that wrote the story,
 * so its chain needs two families for one always to remain (invariant 4).
 */
export function roleProblems(catalog: ModelsSchema, roles: Roles, formats: readonly string[]) {
  const problems: string[] = [];
  for (const format of Object.keys(roles.desk.by_format ?? {})) {
    if (!formats.includes(format)) problems.push(`desk.by_format: unknown format ${format}`);
  }
  for (const [role, chain] of roleChains({ ...catalog, roles })) {
    for (const id of chain) {
      const model = catalog.models[id];
      if (!model) problems.push(`${role}: unknown model ${id}`);
      else if (!model.tools) problems.push(`${role}: ${id} has no tool calling`);
      else if (!model.price) problems.push(`${role}: ${id} has no price`);
    }
  }
  const families = new Set(roles["fact-checker"].flatMap((id) => catalog.models[id]?.family ?? []));
  if (families.size < 2) problems.push("fact-checker needs models from at least two families");
  return problems;
}

/** The shape check of stored chains (jsonb may hold anything), as readable problems. */
export function parseRoles(value: unknown): { roles: Roles } | { problems: string[] } {
  const parsed = ModelsSchema.shape.roles.safeParse(value);
  if (parsed.success) return { roles: parsed.data };
  return {
    problems: parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
    ),
  };
}

export interface EffectiveRoles {
  roles: Roles;
  /** `desk` when the admin's stored chains are in force, else `file`. */
  source: "file" | "desk";
  /** Why stored chains were set aside; empty when they are used or there are none. */
  problems: string[];
}

/**
 * The chains in force: the stored ones when they are valid against the current catalog, else the
 * models file's. No setting, or JSON null, means the file's. A stored setting a deploy has made
 * invalid (say, a model removed) never stops the newsroom: the file's chains run instead.
 */
export function effectiveRoles(
  catalog: ModelsSchema,
  stored: unknown,
  formats: readonly string[],
): EffectiveRoles {
  const file = { roles: catalog.roles, source: "file" as const };
  if (stored === undefined || stored === null) return { ...file, problems: [] };
  const parsed = parseRoles(stored);
  if ("problems" in parsed) return { ...file, problems: parsed.problems };
  const problems = roleProblems(catalog, parsed.roles, formats);
  if (problems.length > 0) return { ...file, problems };
  return { roles: parsed.roles, source: "desk", problems: [] };
}
