// A rendition's items: the objects in its body that list claim_ids, each named by its path
// (`items.3`). The gate checks them, and an imported item that passed is recorded by the hash of
// its text (D184), so the reader site can tell whether it still reads as it did when checked.
/** Checks about a whole rendition that an imported item needs (D184); length and style rules are
 *  about new writing, not the archive's, and are left to the pipeline's own pieces. */
export const IMPORTED_RENDITION_CHECKS: readonly string[] = [
  "schema",
  "verifier",
  "claims",
  "beats",
];

/** Every object in a rendition body that lists claim_ids, with its path (`items.3`). */
export function itemPaths(value: unknown, path = ""): [string, Record<string, unknown>][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => itemPaths(v, `${path}.${i}`));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const own: [string, Record<string, unknown>][] = "claim_ids" in record ? [[path, record]] : [];
    return [
      ...own,
      ...Object.entries(record)
        .filter(([k]) => k !== "claim_ids")
        .flatMap(([k, v]) => itemPaths(v, path ? `${path}.${k}` : k)),
    ];
  }
  return [];
}

/** Labels and delivery hints, not reader-facing text; the verifier's SKIP_KEYS. */
const ITEM_SKIP = new Set([
  "kind",
  "claim_ids",
  "lead_id",
  "media_id",
  "segment",
  "beat",
  "cue",
  "direction",
  "speaker",
  "host",
  "news_kind",
  "url_type",
  "anchor",
  "approximate",
  "url",
  "links",
]);
/** An item's own text, nested lists included; a nested object with its own claim_ids is its own item. */
export function itemText(item: Record<string, unknown>): string {
  const texts = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(texts);
    if (value && typeof value === "object" && !("claim_ids" in value)) {
      return Object.entries(value)
        .filter(([k]) => !ITEM_SKIP.has(k))
        .flatMap(([, v]) => texts(v));
    }
    return [];
  };
  return Object.entries(item)
    .filter(([k]) => !ITEM_SKIP.has(k))
    .flatMap(([, v]) => texts(v))
    .join("\n");
}

/**
 * A short, stable hash of an item's text (cyrb53): enough to notice that the text changed, not a
 * cryptographic digest. Pure, so the reader site and the gate compute the same value.
 */
export function itemHash(item: Record<string, unknown>): string {
  const text = itemText(item);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
