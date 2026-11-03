// A newsroom's Reference config (reference.yaml, D170) as the site reads it: which kind or list a
// path names, where an entry lives, and the names to show. Plain functions over the config; no
// newsroom or kind is named in code.
import type { Language } from "@anr/core";
import type { ReferenceSchema } from "@anr/schemas";

export type ReferenceConfig = ReferenceSchema;
export type KindConfig = ReferenceSchema["kinds"][string];
export type ListConfig = NonNullable<ReferenceSchema["lists"]>[string];
export type Names = Partial<Record<Language, string>>;

/** What `/reference/<path>` shows: one kind's entries, or a list of one kind's entries. */
export type Target =
  | { type: "kind"; key: string; kind: KindConfig; kindKey: string }
  | { type: "list"; key: string; list: ListConfig; kind: KindConfig; kindKey: string }
  /** A series' timeline (D173), drawn as a timeline kind at `/<path>`. */
  | { type: "timeline"; key: string; kind: KindConfig; kindKey: string };

export function hasReference(ref: ReferenceConfig): boolean {
  return Object.keys(ref.kinds).length > 0;
}

export function targetOf(ref: ReferenceConfig, path: string): Target | null {
  for (const [key, kind] of Object.entries(ref.kinds))
    if (kind.path === path) return { type: "kind", key, kind, kindKey: key };
  for (const [key, list] of Object.entries(ref.lists ?? {})) {
    const kind = ref.kinds[list.kind];
    if (list.path === path && kind) return { type: "list", key, list, kind, kindKey: list.kind };
  }
  return null;
}

/** The kind or list a key names (as `nav` does). */
export function targetByKey(ref: ReferenceConfig, key: string): Target | null {
  const kind = ref.kinds[key];
  if (kind) return { type: "kind", key, kind, kindKey: key };
  const list = ref.lists?.[key];
  const listKind = list && ref.kinds[list.kind];
  return list && listKind ? { type: "list", key, list, kind: listKind, kindKey: list.kind } : null;
}

export const targetPath = (t: Target) =>
  t.type === "timeline"
    ? `/${t.kind.path}`
    : `/reference/${t.type === "kind" ? t.kind.path : t.list.path}`;
export const targetNames = (t: Target) => (t.type === "list" ? t.list : t.kind);

/**
 * Where an entry lives: its page, or an anchor on its kind's index for a timeline kind. Null when
 * the newsroom has no such kind.
 */
export function entryPath(ref: ReferenceConfig, kind: string, slug: string): string | null {
  const k = ref.kinds[kind];
  if (!k) return null;
  return k.layout === "timeline" ? `/reference/${k.path}#${slug}` : `/reference/${k.path}/${slug}`;
}

/** A name in the page's language, else in the first language that has one. */
export function nameOf(names: Names | undefined, language: Language): string {
  if (!names) return "";
  return names[language] ?? names.fa ?? names.en ?? names.tr ?? "";
}
