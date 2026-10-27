import type { ModelsSchema } from "./generated/index.ts";

/** Every role chain of a models file, named (desk formats as desk.by_format.<format>). */
export function roleChains(config: ModelsSchema): [string, string[]][] {
  const r = config.roles;
  return [
    ["planner", r.planner],
    ["desk", r.desk.default],
    ...Object.entries(r.desk.by_format ?? {}).map(([f, c]): [string, string[]] => [
      `desk.by_format.${f}`,
      c,
    ]),
    ["renderer", r.renderer],
    ["fact-checker", r["fact-checker"]],
    ["item-matcher", r["item-matcher"]],
    ["summariser", r.summariser],
  ];
}
