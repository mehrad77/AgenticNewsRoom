// How far the recheck of imported news has got (D184), for the editor's desk: each imported day's
// items, whether each language's text is checked, and the first thing that stopped it. Read-only;
// "checked" is exactly what the reader site counts: a checked_items row whose hash matches the text.
import { IMPORTED_RENDITION_CHECKS, itemHash } from "@anr/core";
import type { Client } from "@anr/db";

export type RecheckStatus = "checked" | "waiting" | "running" | "source" | "claims" | "checks";

export interface RecheckReason {
  language: string | null;
  check: string;
  result: string;
  /** The claim's text, when the check was about one. */
  claim: string | null;
  reason: string | null;
}

export interface RecheckItem {
  index: number;
  headline: string | null;
  url: string | null;
  status: RecheckStatus;
  languages: { language: string; checked: boolean }[];
  /** Why it is not checked, the first in order of what stopped it; empty when checked or waiting. */
  reasons: RecheckReason[];
}

export interface RecheckDay {
  story_id: string;
  slot: string;
  publication_id: string | null;
  title: string | null;
  items: RecheckItem[];
}

export interface Recheck {
  counts: Record<RecheckStatus, number>;
  /** What stopped the items that are not checked, most common first. */
  causes: { cause: string; items: number }[];
  days: RecheckDay[];
}

export interface RecheckRows {
  renditions: {
    id: string;
    story_id: string;
    slot: Date;
    language: string;
    items: Record<string, unknown>[] | null;
  }[];
  publications: { id: string; language: string; title: string | null; rendition_id: string }[];
  checked: { rendition_id: string; item: string; text_hash: string }[];
  /** The recheck's desk runs, oldest first. */
  runs: { story_id: string; item: number; outcome: string | null; detail: unknown }[];
  claims: { id: string; story_id: string; ref: string; text: string }[];
  /** Oldest first: a later row for the same check replaces an earlier one. */
  checks: {
    claim_id: string | null;
    rendition_id: string | null;
    item: string | null;
    kind: string;
    name: string;
    result: string;
    detail: unknown;
  }[];
}

const STATUSES: RecheckStatus[] = ["checked", "waiting", "running", "source", "claims", "checks"];

/** A check's detail in a line: the checker's reason, or its fields. */
export function reasonOf(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object") return String(detail);
  const d = detail as Record<string, unknown>;
  for (const key of ["reason", "error"]) if (typeof d[key] === "string") return d[key] as string;
  const parts = Object.entries(d)
    .filter(([k, v]) => !["by", "lead_id", "position"].includes(k) && v !== null && v !== false)
    .filter(([, v]) => !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k.replaceAll("_", " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** A short name for what stopped an item, so the desk can count alike failures together. */
export function causeOf(r: RecheckReason): string {
  if (r.check === "source" || r.check === "claims") {
    const text = r.reason ?? "";
    if (/no source named/.test(text)) return "no source link";
    if (/terms/i.test(text)) return "source's terms not checked";
    if (/answered 5\d\d|timed out|unreachable/i.test(text)) return "source page did not load";
    if (/in no claim's text/.test(text)) return "names or numbers left out of claims";
    if (/not in the source text/.test(text)) return "quote not in the source";
    if (/too short/.test(text)) return "quote too short";
    return `${r.check}: ${text.replace(/^source: /, "").slice(0, 60)}`;
  }
  return `${r.check} ${r.result}`;
}

/** Each imported day's items and why each is not yet checked, from the rows `recheck` reads. */
export function recheckReport(rows: RecheckRows): Recheck {
  const latest = new Map<string, RecheckRows["checks"][number]>();
  for (const k of rows.checks) {
    const position = (k.detail as { position?: number } | null)?.position ?? "";
    latest.set([k.claim_id, k.rendition_id, k.item, k.kind, k.name, position].join("|"), k);
  }
  const checks = [...latest.values()];
  const runs = new Map(rows.runs.map((r) => [`${r.story_id}:${r.item}`, r]));
  const checked = new Set(rows.checked.map((c) => `${c.rendition_id}|${c.item}|${c.text_hash}`));
  const stories = new Map<string, RecheckRows["renditions"]>();
  for (const r of rows.renditions) stories.set(r.story_id, [...(stories.get(r.story_id) ?? []), r]);

  const days: RecheckDay[] = [...stories.entries()].map(([storyId, renditions]) => {
    const [base] = renditions;
    const pubs = rows.publications.filter((p) => renditions.some((r) => r.id === p.rendition_id));
    const english = pubs.find((p) => p.language === "en") ?? pubs[0];
    const claims = new Map(
      rows.claims.filter((c) => c.story_id === storyId).map((c) => [c.ref, c]),
    );
    const items = (base?.items ?? []).map((first, index): RecheckItem => {
      const path = `items.${index}`;
      const languages = renditions.map((r) => {
        const item = r.items?.[index];
        return {
          language: r.language,
          checked: !!item && checked.has(`${r.id}|${path}|${itemHash(item)}`),
        };
      });
      const item = {
        index,
        headline: typeof first.headline === "string" ? first.headline : null,
        url: typeof first.url === "string" ? first.url : null,
        languages,
      };
      if (languages.every((l) => l.checked)) return { ...item, status: "checked", reasons: [] };
      const run = runs.get(`${storyId}:${index}`);
      if (!run) return { ...item, status: "waiting", reasons: [] };
      if (run.outcome === null) return { ...item, status: "running", reasons: [] };
      if (run.outcome !== "submitted") {
        const text = reasonOf(run.detail) ?? run.outcome;
        const lang = /^([a-z]{2,3}): /.exec(text);
        const source = /^source|no source|source not stored/.test(text);
        return {
          ...item,
          status: source ? "source" : "claims",
          reasons: [
            {
              language: lang?.[1] ?? null,
              check: source ? "source" : "claims",
              result: "error",
              claim: null,
              reason: lang ? text.slice(lang[0].length) : text,
            },
          ],
        };
      }
      const reasons = renditions.flatMap((r) => {
        if (languages.find((l) => l.language === r.language)?.checked) return [];
        const own = checks.filter((k) => k.rendition_id === r.id);
        if (own.length === 0) return [];
        const reason = (k: (typeof checks)[number], claim: string | null = null) => ({
          language: r.language,
          check: k.name,
          result: k.result,
          claim,
          reason: reasonOf(k.detail),
        });
        // In the order the verdict needs them: the rendition, then the item's claims, then the item.
        const whole = own.filter(
          (k) =>
            k.item === null &&
            k.claim_id === null &&
            IMPORTED_RENDITION_CHECKS.includes(k.name) &&
            (k.result !== "pass" ||
              (k.name === "beats" &&
                ((k.detail as { restricted?: string[] } | null)?.restricted ?? []).length > 0)),
        );
        const refs = (r.items?.[index]?.claim_ids as string[] | undefined) ?? [];
        const missing = (check: string, claim: string | null = null) => ({
          language: r.language,
          check,
          result: "missing",
          claim,
          reason: null,
        });
        const ofClaims = refs.flatMap((ref) => {
          const claim = claims.get(ref);
          if (!claim) return [missing("claim", ref)];
          const failed = checks.filter((k) => k.claim_id === claim.id && k.result !== "pass");
          if (failed.length > 0) return failed.map((k) => reason(k, claim.text));
          // A fact-check runs only once a claim's code checks pass.
          return checks.some((k) => k.claim_id === claim.id && k.kind === "fact-check")
            ? []
            : [missing("fact-check", claim.text)];
        });
        const ofItem = own.filter((k) => k.item === path && k.result !== "pass");
        // A restricted beat passes the check but goes to a person, so the item stays labelled.
        const ofWhole = whole.map((k) =>
          k.result === "pass" ? { ...reason(k), result: "restricted" } : reason(k),
        );
        const found = [...ofWhole, ...ofClaims, ...ofItem.map((k) => reason(k))];
        if (found.length > 0) return found;
        if (!own.some((k) => k.item === path && k.kind === "item-match"))
          return [missing("item-match")];
        return rows.checked.some((c) => c.rendition_id === r.id && c.item === path)
          ? [
              {
                ...missing("checked"),
                result: "stale",
                reason: "the text changed after it was checked",
              },
            ]
          : [];
      });
      // Claims written but not checked yet: the check pass has not reached this day.
      if (reasons.length === 0)
        return {
          ...item,
          status: renditions.some((r) => checks.some((k) => k.rendition_id === r.id))
            ? "checks"
            : "waiting",
          reasons: [],
        };
      return { ...item, status: "checks", reasons };
    });
    return {
      story_id: storyId,
      slot: (base?.slot ?? new Date(0)).toISOString(),
      publication_id: english?.id ?? null,
      title: english?.title ?? null,
      items,
    };
  });

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RecheckStatus, number>;
  const causes = new Map<string, number>();
  for (const item of days.flatMap((d) => d.items)) {
    counts[item.status]++;
    const [first] = item.reasons;
    if (first) causes.set(causeOf(first), (causes.get(causeOf(first)) ?? 0) + 1);
  }
  return {
    counts,
    causes: [...causes.entries()]
      .map(([cause, items]) => ({ cause, items }))
      .sort((a, b) => b.items - a.items || a.cause.localeCompare(b.cause)),
    days,
  };
}

/** The recheck's state for the newsroom the client is scoped to. */
export async function recheck(client: Client): Promise<Recheck> {
  const { rows: renditions } = await client.query<RecheckRows["renditions"][number]>(
    `select r.id, st.id as story_id, a.slot, r.language, r.body->'items' as items
     from stories st
     join assignments a on a.id = st.assignment_id
     join renditions r on r.story_id = st.id
     where exists (select from publications p where p.assignment_id = a.id and p.origin = 'imported')
       and not exists (select from publications p where p.assignment_id = a.id and p.origin <> 'imported')
       and exists (select from jsonb_array_elements(r.body->'items') i
                   where i->>'kind' = 'news' and i ? 'url')
     order by a.slot desc, st.id, r.language`,
  );
  const ids = renditions.map((r) => r.id);
  const storyIds = [...new Set(renditions.map((r) => r.story_id))];
  const rowsOf = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;
  const publications = await rowsOf(
    `select p.id, p.language, p.title, pr.rendition_id from publications p
     join publication_renditions pr on pr.publication_id = p.id where pr.rendition_id = any($1)`,
    [ids],
  );
  const checked = await rowsOf(
    "select rendition_id, item, text_hash from checked_items where rendition_id = any($1)",
    [ids],
  );
  const runs = await rowsOf(
    `select story_id, (task->>'item')::int as item, outcome, detail from agent_runs
     where role = 'desk' and task->>'key' = 'recheck' and story_id = any($1)
     order by started_at`,
    [storyIds],
  );
  const claims = await rowsOf(
    "select id, story_id, ref, text from claims where story_id = any($1)",
    [storyIds],
  );
  const checks = await rowsOf(
    `select claim_id, rendition_id, item, kind, name, result, detail from checks
     where rendition_id = any($1) or claim_id in (select id from claims where story_id = any($2))
     order by at`,
    [ids, storyIds],
  );
  return recheckReport({
    renditions,
    publications,
    checked,
    runs,
    claims,
    checks,
  });
}
