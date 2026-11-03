// Checks of reference.yaml beyond its JSON Schema (D170): what names what, and that every name
// covers each of the newsroom's languages, so the Reference is never half in one language.
import type { ReferenceSchema } from "@anr/schemas";

type Names = Record<string, string>;

export function referenceProblems(
  ref: ReferenceSchema,
  languages: readonly string[],
  where: string,
): string[] {
  const out: string[] = [];
  const names = (n: Names | undefined, at: string) => {
    if (!n) return;
    const missing = languages.filter((l) => !n[l]);
    if (missing.length > 0) out.push(`${where} ${at} has no ${missing.join(", ")}`);
  };
  names(ref.intro as Names | undefined, "intro");

  const paths = new Map<string, string>();
  const usePath = (path: string, owner: string) => {
    const other = paths.get(path);
    if (other) out.push(`${where} ${owner} reuses the path ${path} of ${other}`);
    paths.set(path, owner);
  };
  for (const [kind, k] of Object.entries(ref.kinds)) {
    const at = `kind ${kind}`;
    usePath(k.path, at);
    names(k.name as Names, `${at} name`);
    names(k.one as Names, `${at} one`);
    names(k.intro as Names | undefined, `${at} intro`);
    if (k.sections && k.layout !== "document")
      out.push(`${where} ${at} has sections but is not a document`);
    if (k.filters && k.layout !== "timeline")
      out.push(`${where} ${at} has filters but is not a timeline`);
    for (const s of k.sections ?? []) names(s.name as Names, `${at} section ${s.key}`);
    for (const f of k.filters ?? []) {
      names(f.name as Names, `${at} filter ${f.fact}`);
      for (const [value, n] of Object.entries(f.values ?? {}))
        names(n as Names, `${at} filter ${f.fact} value ${value}`);
    }
  }
  for (const [list, l] of Object.entries(ref.lists ?? {})) {
    const at = `list ${list}`;
    usePath(l.path, at);
    if (!ref.kinds[l.kind]) out.push(`${where} ${at} names unknown kind ${l.kind}`);
    if (ref.kinds[list]) out.push(`${where} ${at} has the name of a kind`);
    names(l.name as Names, `${at} name`);
    names(l.one as Names, `${at} one`);
    names(l.intro as Names | undefined, `${at} intro`);
  }
  for (const key of ref.nav ?? [])
    if (!ref.kinds[key] && !ref.lists?.[key])
      out.push(`${where} nav names ${key}, which is neither a kind nor a list`);
  return out;
}
