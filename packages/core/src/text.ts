// The text of a rendition body a person may change: every string leaf except the structure that
// ties it to claims and leads. The desk's edit form and the API's edit check read this one list.

/** Keys whose values are structure, never reader-facing text. */
const STRUCTURE = new Set(["kind", "claim_ids", "lead_id", "id", "language"]);

export interface TextField {
  /** A JSON pointer (RFC 6901) into the body, such as `/items/0/body`. */
  pointer: string;
  text: string;
}

const escapeKey = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

export function textFields(body: unknown): TextField[] {
  const out: TextField[] = [];
  const walk = (value: unknown, pointer: string) => {
    if (typeof value === "string") out.push({ pointer, text: value });
    else if (Array.isArray(value)) for (const [i, v] of value.entries()) walk(v, `${pointer}/${i}`);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value))
        if (!STRUCTURE.has(k)) walk(v, `${pointer}/${escapeKey(k)}`);
  };
  walk(body, "");
  return out;
}

/** A copy of `body` with the string at each pointer replaced; every pointer must be a text field. */
export function withText(body: unknown, changes: readonly TextField[]): unknown {
  const allowed = new Set(textFields(body).map((f) => f.pointer));
  const copy = structuredClone(body);
  for (const { pointer, text } of changes) {
    if (!allowed.has(pointer)) throw new Error(`${pointer} is not a text field`);
    const keys = pointer
      .slice(1)
      .split("/")
      .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = keys.pop() as string;
    let node = copy as Record<string, unknown>;
    for (const k of keys) node = node[k] as Record<string, unknown>;
    node[last] = text;
  }
  return copy;
}
