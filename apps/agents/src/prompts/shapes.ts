// The item shapes a desk writes, read from the format's JSON Schema, so a new format needs no
// prompt code (invariant 9).

interface Property {
  const?: unknown;
  enum?: unknown[];
  type?: string;
  description?: string;
  items?: { type?: string };
}
interface ItemSchema {
  properties?: Record<string, Property>;
}

export interface ItemShape {
  /**
   * Each kind of item as a JSON example, without claim_ids (the claims step adds them) or the
   * fields code sets.
   */
  variants: string[];
  /** The `kind` values items choose between, if the format has several kinds. */
  kinds: string[];
  /** Whether items can be marked opinion (D117). */
  opinion: boolean;
  /** Whether items can show a licensed image (D119). */
  media: boolean;
}

function placeholder(name: string, p: Property): string {
  if (p.const !== undefined) return JSON.stringify(p.const);
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (p.type === "boolean") return "true | false";
  if (p.type === "array" && p.items?.type === "string") return '["...", ...]';
  if (p.type === "string") return p.description ? JSON.stringify(`<${p.description}>`) : '"..."';
  return `<${name}>`;
}

const CODE_SET = "Set by code";

/**
 * The fields of a format's rendition and its items that code fills in (their schema description
 * starts "Set by code"): never the desk's or the renderer's to write (D173).
 */
export function codeSetFields(schema: unknown): string[] {
  const s = schema as {
    properties?: {
      rendition?: {
        properties?: Record<string, Property> & {
          items?: { items?: ItemSchema & { oneOf?: ItemSchema[] } };
        };
      };
    };
  };
  const rendition = s.properties?.rendition?.properties ?? {};
  const items = rendition.items?.items ?? {};
  const props = [
    ...Object.entries(rendition),
    ...(items.oneOf ?? [items]).flatMap((v) => Object.entries(v.properties ?? {})),
  ];
  return [
    ...new Set(
      props.filter(([, p]) => (p as Property).description?.startsWith(CODE_SET)).map(([n]) => n),
    ),
  ];
}

/** A format's rendition items, from its draft schema (`config/formats/<format>/schema.json`). */
export function itemShape(schema: unknown): ItemShape {
  const s = schema as {
    properties?: {
      rendition?: {
        properties?: { items?: { items?: ItemSchema & { oneOf?: ItemSchema[] } } };
      };
    };
  };
  const items = s.properties?.rendition?.properties?.items?.items ?? {};
  const variants = items.oneOf ?? [items];
  const shapes = variants.map((v) => {
    const fields = Object.entries(v.properties ?? {})
      // Fields code fills in (their schema says "Set by code") are not the desk's to write.
      .filter(([name, p]) => name !== "claim_ids" && !p.description?.startsWith(CODE_SET))
      .map(([name, p]) => `"${name}": ${placeholder(name, p)}`);
    return `{${fields.join(", ")}}`;
  });
  const kinds = variants
    .map((v) => v.properties?.kind?.const)
    .filter((k): k is string => typeof k === "string");
  return {
    variants: shapes,
    kinds,
    opinion: variants.some((v) => v.properties?.opinion !== undefined),
    media: variants.some((v) => v.properties?.media_id !== undefined),
  };
}
