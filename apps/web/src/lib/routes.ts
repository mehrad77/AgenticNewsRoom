// The pages of a newsroom site, by path inside one language (the language prefix already removed).

export type Route =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "ai-policy" }
  | { kind: "corrections" }
  /** A reader's own challenge, opened with the token in its link (D114). */
  | { kind: "challenge"; id: string }
  | { kind: "publication"; path: string }
  /**
   * The Reference (D162): its home, a kind's or a list's index at `/reference/<path>`, and an
   * entry's page at `/reference/<path>/<slug>`. Which paths exist is the newsroom's config (D170).
   */
  | { kind: "reference" }
  | { kind: "reference-index"; path: string }
  | { kind: "reference-entry"; path: string; slug: string }
  /** A series' timeline at the path its config gives (D173); unknown paths are not found. */
  | { kind: "timeline"; path: string }
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
  if (p === "/reference") return { kind: "reference" };
  const ref = /^\/reference\/([a-z][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?$/.exec(p);
  if (ref?.[1] && ref[2]) return { kind: "reference-entry", path: ref[1], slug: ref[2] };
  if (ref?.[1]) return { kind: "reference-index", path: ref[1] };
  const challenge = /^\/challenge\/([0-9a-f-]{36})$/.exec(p);
  if (challenge?.[1]) return { kind: "challenge", id: challenge[1] };
  if (p.endsWith(".json") && PUBLICATION.test(p.slice(0, -5)))
    return { kind: "ninjs", path: p.slice(0, -5) };
  if (PUBLICATION.test(p)) return { kind: "publication", path: p };
  const timeline = /^\/([a-z][a-z0-9-]*)$/.exec(p);
  if (timeline?.[1]) return { kind: "timeline", path: timeline[1] };
  return { kind: "not-found" };
}
