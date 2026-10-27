// Layer 4 of the gate (D80): code decides each publication from its stored Checks. It can hold,
// never approve on its own: a publication goes on only when every check it needs exists and
// passed, it is daily news in an auto-published format, and no beat or theme needs an editor.
import type { CheckResult } from "@anr/core";

export interface StoredCheck {
  kind: string;
  name: string;
  result: CheckResult;
  claimId: string | null;
  renditionId: string | null;
  item: string | null;
  /** For a fact-check: which of the claim's sources (0 is its lead, then `also`). */
  position?: number | null;
}

export interface PublicationFacts {
  /** The publication's rendition; null when it has none (its renderer failed). */
  renditionId: string | null;
  /** Item paths of the rendition, each of which needs an item check and an item-match check. */
  items: readonly string[];
  /** The story's claims: which need a quote check, which a fact-check, and how many sources. */
  claims: readonly { id: string; kind: string; sources: number }[];
  /** Every check about the story's claims, this rendition and this publication. */
  checks: readonly StoredCheck[];
  themed: boolean;
  format: string;
  autoPublish: readonly string[];
  /** Restricted beats of the story or of its cited leads. */
  restricted: readonly string[];
}

export interface Hold {
  name: string;
  result: Exclude<CheckResult, "pass">;
  detail: Record<string, unknown>;
}

export type Decision = { status: "scheduled" } | { status: "with-editor"; holds: Hold[] };

/** Code checks every rendition needs, whatever its format. */
export const RENDITION_CHECKS = ["schema", "beats", "style-lint", "disclosure"] as const;

/** What the publication still lacks: each check that should exist and does not. */
export function missingChecks(f: PublicationFacts): string[] {
  const has = (p: (c: StoredCheck) => boolean) => f.checks.some(p);
  const count = (p: (c: StoredCheck) => boolean) => f.checks.filter(p).length;
  if (!f.renditionId) return ["rendition"];
  const missing: string[] = [];
  for (const name of RENDITION_CHECKS) {
    if (!has((c) => c.name === name && c.renditionId === f.renditionId)) missing.push(name);
  }
  for (const claim of f.claims) {
    if (
      claim.kind !== "opinion" &&
      !has((c) => c.name === "quote-match" && c.claimId === claim.id)
    ) {
      missing.push(`quote-match ${claim.id}`);
    }
    if (claim.kind !== "fact") continue;
    if (!has((c) => c.name === "source-independence" && c.claimId === claim.id)) {
      missing.push(`source-independence ${claim.id}`);
    }
    for (let position = 0; position < claim.sources; position++) {
      const checked = has(
        (c) => c.kind === "fact-check" && c.claimId === claim.id && c.position === position,
      );
      if (!checked) missing.push(`fact-check ${claim.id}#${position}`);
    }
  }
  for (const item of f.items) {
    const of = (kind: string) => (c: StoredCheck) =>
      c.kind === kind && c.renditionId === f.renditionId && c.item === item;
    if (!has(of("code"))) missing.push(`item-claims ${item}`);
    if (!has(of("item-match"))) missing.push(`item-match ${item}`);
  }
  return missing;
}

export function decide(f: PublicationFacts): Decision {
  const holds: Hold[] = [];
  const failed = f.checks.filter((c) => c.result !== "pass");
  if (failed.length > 0) {
    // The worst result names the hold: an error or timeout is not the draft's fault.
    const worst = (["error", "timed-out", "fail", "partial"] as const).find((r) =>
      failed.some((c) => c.result === r),
    );
    holds.push({
      name: "checks",
      result: worst ?? "fail",
      detail: {
        failed: failed.map((c) => ({
          kind: c.kind,
          name: c.name,
          result: c.result,
          claim: c.claimId,
          item: c.item,
        })),
      },
    });
  }
  const missing = missingChecks(f);
  if (missing.length > 0)
    holds.push({ name: "checks-missing", result: "error", detail: { missing } });
  if (f.themed) {
    holds.push({
      name: "themed",
      result: "fail",
      detail: { reason: "themed work goes to an editor" },
    });
  }
  if (f.restricted.length > 0) {
    holds.push({ name: "restricted-beat", result: "fail", detail: { beats: f.restricted } });
  }
  if (!f.autoPublish.includes(f.format)) {
    holds.push({ name: "not-auto-published", result: "fail", detail: { format: f.format } });
  }
  return holds.length === 0 ? { status: "scheduled" } : { status: "with-editor", holds };
}
