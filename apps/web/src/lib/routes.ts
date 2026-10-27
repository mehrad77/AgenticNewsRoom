// The pages of a newsroom site, by path inside one language (the language prefix already removed).

export type Route =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "ai-policy" }
  | { kind: "corrections" }
  | { kind: "publication"; path: string }
  /** The publication's ninjs 3.2 twin: its page URL plus `.json`. */
  | { kind: "ninjs"; path: string }
  | { kind: "not-found" };

/** A publication path as the publisher writes it: `/<series>/<yyyy-mm-dd>`, maybe a suffix (D92). */
const PUBLICATION = /^\/[a-z0-9][a-z0-9-]*\/\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/;

export function route(path: string): Route {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "") return { kind: "home" };
  if (p === "/search") return { kind: "search" };
  if (p === "/ai-policy") return { kind: "ai-policy" };
  if (p === "/corrections") return { kind: "corrections" };
  if (p.endsWith(".json") && PUBLICATION.test(p.slice(0, -5)))
    return { kind: "ninjs", path: p.slice(0, -5) };
  if (PUBLICATION.test(p)) return { kind: "publication", path: p };
  return { kind: "not-found" };
}
