// The gate's verdict on an imported story's items (D184). Nothing here changes a publication: an
// item counts as checked only when every check about it passed, and the reader site then shows it
// with the AI label only. Anything missing, failed, partial, errored or timed out leaves it
// labelled as imported (invariant 5: the gate can hold, never approve on less).
import { IMPORTED_RENDITION_CHECKS, itemHash, itemPaths } from "@anr/core";
import type { StoredCheck } from "./policy.ts";

interface Claim {
  id: string;
  ref: string;
  kind: string;
  sources: unknown[];
}

type Checked = StoredCheck & { detail?: unknown };

export interface CheckedItem {
  publicationId: string;
  renditionId: string;
  item: string;
  textHash: string;
}

/** Each check's latest result: a rechecked story keeps its earlier rows, and the newer one counts. */
export function latestChecks<T extends StoredCheck>(checks: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const c of checks)
    latest.set([c.claimId, c.renditionId, c.item, c.kind, c.name, c.position].join("|"), c);
  return [...latest.values()];
}

/** Whether every check about a claim passed, a fact-check for each of its sources included. */
export function claimPassed(claim: Claim, checks: readonly StoredCheck[]): boolean {
  if (claim.kind !== "fact") return false;
  const own = checks.filter((c) => c.claimId === claim.id);
  if (own.length === 0 || own.some((c) => c.result !== "pass")) return false;
  const positions = new Set(own.filter((c) => c.kind === "fact-check").map((c) => c.position));
  return claim.sources.every((_, i) => positions.has(i));
}

/** Whether an item passed: claims listed, each passed, and every check on the item and on its
 *  rendition as a whole passed, the item matcher's included. */
export function itemPassed(
  renditionId: string,
  path: string,
  item: Record<string, unknown>,
  claims: readonly Claim[],
  checks: readonly Checked[],
): boolean {
  const refs = (item.claim_ids as string[] | undefined) ?? [];
  if (refs.length === 0) return false;
  const byRef = new Map(claims.map((c) => [c.ref, c]));
  if (!refs.every((ref) => byRef.has(ref) && claimPassed(byRef.get(ref) as Claim, checks)))
    return false;
  const rendition = checks.filter(
    (c) => c.renditionId === renditionId && c.item === null && c.claimId === null,
  );
  // A restricted beat goes to a person in the pipeline; here it simply stays labelled.
  const restricted = rendition.some(
    (c) =>
      c.name === "beats" && ((c.detail as { restricted?: string[] })?.restricted ?? []).length > 0,
  );
  if (
    restricted ||
    !IMPORTED_RENDITION_CHECKS.every(
      (name) =>
        !rendition.some((c) => c.name === name && c.result !== "pass") &&
        (name !== "schema" || rendition.some((c) => c.name === "schema" && c.result === "pass")),
    )
  )
    return false;
  const own = checks.filter((c) => c.renditionId === renditionId && c.item === path);
  return (
    own.some((c) => c.kind === "item-match" && c.result === "pass") &&
    own.every((c) => c.result === "pass")
  );
}

/** Every item of the story's imported publications that passed, with its text's hash. */
export function checkedItems(
  publications: readonly { id: string; rendition_id: string | null }[],
  renditions: readonly { id: string; body: Record<string, unknown> }[],
  claims: readonly Claim[],
  checks: readonly Checked[],
): CheckedItem[] {
  return publications.flatMap((p) => {
    const r = renditions.find((x) => x.id === p.rendition_id);
    if (!r) return [];
    return itemPaths(r.body)
      .filter(([path, item]) => itemPassed(r.id, path, item, claims, checks))
      .map(([path, item]) => ({
        publicationId: p.id,
        renditionId: r.id,
        item: path,
        textHash: itemHash(item),
      }));
  });
}
