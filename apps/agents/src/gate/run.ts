// The verifier gate for one story (D80): code checks (verifier service), disclosure, fact-checker,
// item matcher, then policy per publication. Every result is a Check; each stage skips what an
// earlier attempt stored, so a retried job resumes. Anything that cannot run is stored as an error
// and holds (invariant 5); the gate never waits for a person.
import type { AgentRole, CheckResult, GateJob, Language } from "@anr/core";
import { auditedUpdate, type Client, type Pool, withNewsroom } from "@anr/db";
import { AllModelsExhausted, ModelCallFailed } from "@anr/models";
import type { createRenderer } from "@anr/render";
import { budgetState, mayStart, noticeBudget } from "../budget.ts";
import { formatMeta } from "../context.ts";
import { newMeter, type RunModel, TokenCapReached } from "../model.ts";
import { assemblePrompt } from "../prompts/assemble.ts";
import type { ModelRouter } from "../router.ts";
import { finishRun, holdPublications, insertRun } from "../runs.ts";
import { decide, type StoredCheck } from "./policy.ts";
import {
  askVerdict,
  FACT_CHECKER_ROLE,
  factQuestion,
  ITEM_MATCHER_ROLE,
  itemQuestion,
  parseFact,
  parseItem,
} from "./verdict.ts";

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; result: "error" | "timed-out"; detail: string };

export interface VerifierClient {
  verify(newsroomId: string, storyId: string): Promise<VerifyOutcome>;
}

/** The code checks can take a while on a long story; past this the gate holds with timed-out. */
const VERIFY_TIMEOUT_MS = 120_000;

/** The verifier service's POST /verify (services/verifier, D79). Never throws. */
export function verifierClient(baseUrl: string, fetchImpl: typeof fetch = fetch): VerifierClient {
  return {
    async verify(newsroomId, storyId) {
      try {
        const response = await fetchImpl(new URL("/verify", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newsroom_id: newsroomId, story_id: storyId }),
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true };
        return {
          ok: false,
          result: "error",
          detail: `verifier answered ${response.status}: ${await response.text()}`,
        };
      } catch (error) {
        const timedOut = (error as Error).name === "TimeoutError";
        return {
          ok: false,
          result: timedOut ? "timed-out" : "error",
          detail: (error as Error).message,
        };
      }
    },
  };
}

export interface GateDeps {
  pool: Pool;
  router: ModelRouter;
  configDir: string;
  verifier: VerifierClient;
  renderer: ReturnType<typeof createRenderer>;
  makeModel: (chain: readonly string[], tokenCap: number) => RunModel;
  log?: (line: string) => void;
}

interface Source {
  lead_id: string;
  quoted_passage: string;
}
interface GateClaim {
  id: string;
  ref: string;
  kind: string;
  text: string;
  sources: Source[];
}
interface GateRendition {
  id: string;
  language: Language;
  body: Record<string, unknown>;
}
interface GatePublication {
  id: string;
  language: string;
  status: string;
  rendition_id: string | null;
}
interface GateStory {
  newsroomSlug: string;
  format: string;
  themed: boolean;
  channels: Record<string, string[]>;
  autoPublish: string[];
  claims: GateClaim[];
  renditions: GateRendition[];
  publications: GatePublication[];
}

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

const ITEM_SKIP = new Set(["kind", "claim_ids", "lead_id", "segment", "beat", "cue", "direction"]);
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

async function loadStory(client: Client, storyId: string): Promise<GateStory | null> {
  const { rows } = await client.query<
    Omit<GateStory, "claims" | "renditions" | "publications"> & { assignment_id: string }
  >(
    `select n.slug as "newsroomSlug", f.slug as format, (a.cycle_id is not null or a.pick_id is not null) as themed,
            coalesce(se.config->'channels', '{}') as channels,
            coalesce(n.policy->'auto_publish', '[]') as "autoPublish", s.assignment_id
     from stories s join assignments a on a.id = s.assignment_id
     join series se on se.id = a.series_id join formats f on f.id = se.format_id
     join newsrooms n on n.id = s.newsroom_id
     where s.id = $1`,
    [storyId],
  );
  const story = rows[0];
  if (!story) return null;
  const claims = await client.query<GateClaim>(
    `select c.id, c.ref, c.kind, c.text,
            (case when c.lead_id is null then '[]'::jsonb
                  else jsonb_build_array(jsonb_build_object('lead_id', c.lead_id, 'quoted_passage', c.quoted_passage)) end)
            || coalesce((select jsonb_agg(jsonb_build_object('lead_id', cs.lead_id, 'quoted_passage', cs.quoted_passage)
                                          order by cs.position)
                         from claim_sources cs where cs.claim_id = c.id), '[]'::jsonb) as sources
     from claims c where c.story_id = $1 order by c.created_at, c.ref`,
    [storyId],
  );
  const renditions = await client.query<GateRendition>(
    "select id, language, body from renditions where story_id = $1 order by created_at",
    [storyId],
  );
  const publications = await client.query<GatePublication>(
    `select p.id, p.language, p.status,
            (select pr.rendition_id from publication_renditions pr where pr.publication_id = p.id
             order by pr.position limit 1) as rendition_id
     from publications p where p.assignment_id = $1 order by p.language`,
    [story.assignment_id],
  );
  return {
    ...story,
    claims: claims.rows,
    renditions: renditions.rows,
    publications: publications.rows,
  };
}

async function storyChecks(
  client: Client,
  storyId: string,
): Promise<(StoredCheck & { detail: unknown })[]> {
  const { rows } = await client.query<StoredCheck & { detail: unknown }>(
    `select c.kind, c.name, c.result, c.claim_id as "claimId", c.rendition_id as "renditionId", c.item, c.detail,
            (c.detail->>'position')::int as position
     from checks c
     where c.claim_id in (select id from claims where story_id = $1)
        or c.rendition_id in (select id from renditions where story_id = $1)`,
    [storyId],
  );
  return rows;
}

interface NewCheck {
  kind: "code" | "fact-check" | "item-match";
  name: string;
  result: CheckResult;
  claimId?: string;
  renditionId?: string;
  item?: string;
  detail?: unknown;
}

async function storeCheck(client: Client, c: NewCheck): Promise<void> {
  await client.query(
    `insert into checks (newsroom_id, claim_id, rendition_id, item, kind, name, result, detail)
     values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      c.claimId ?? null,
      c.renditionId ?? null,
      c.item ?? null,
      c.kind,
      c.name,
      c.result,
      JSON.stringify(c.detail ?? null),
    ],
  );
}

/** A model failure as a check result: an outage that ran out of time is timed-out. */
function failureResult(error: unknown): { result: "error" | "timed-out"; detail: string } | null {
  if (error instanceof AllModelsExhausted) {
    const timedOut =
      error.attempts.length > 0 &&
      error.attempts.every((a) => /no answer after|timeout/i.test(a.detail ?? ""));
    return { result: timedOut ? "timed-out" : "error", detail: error.message };
  }
  if (error instanceof ModelCallFailed || error instanceof TokenCapReached) {
    return { result: "error", detail: error.message };
  }
  return null;
}

export async function runGate(deps: GateDeps, job: GateJob): Promise<string> {
  const log = deps.log ?? console.log;
  const inStory = <T>(fn: (client: Client) => Promise<T>) =>
    withNewsroom(deps.pool, job.newsroomId, fn);
  const story = await inStory((c) => loadStory(c, job.storyId));
  if (!story) return "no story";
  if (!story.publications.some((p) => p.status === "drafted")) return "nothing to gate";

  // 1. Code checks: the verifier stores them all in one transaction, or none. A stored verifier
  // error already holds, so a retried job does not ask again.
  let checks = await inStory((c) => storyChecks(c, job.storyId));
  if (!checks.some((c) => c.kind === "code" && ["schema", "verifier"].includes(c.name))) {
    const outcome = await deps.verifier.verify(job.newsroomId, job.storyId);
    if (!outcome.ok) {
      await inStory(async (c) => {
        for (const r of story.renditions) {
          await storeCheck(c, {
            kind: "code",
            name: "verifier",
            result: outcome.result,
            renditionId: r.id,
            detail: { error: outcome.detail },
          });
        }
      });
    }
  }

  // 2. Disclosure: every message of every channel the series uses for the language shows the
  // label, split exactly as the publisher sends it (D79, D88). A post that cannot split errors.
  if (!checks.some((c) => c.name === "disclosure")) {
    await inStory(async (c) => {
      for (const r of story.renditions) {
        const kinds = Object.entries(story.channels)
          .filter(([, languages]) => languages.includes(r.language))
          .map(([kind]) => kind);
        try {
          const label = await deps.renderer.disclosureLabel(r.language);
          const missing: string[] = [];
          for (const kind of kinds) {
            const parts = await deps.renderer.renderParts(story.format, kind, r.language, {
              rendition: r.body,
              edited: false,
              site_url: "https://example.invalid/",
              ai_policy_url: "/ai-policy",
              leads: {},
            });
            if (!parts.every((p) => p.includes(label))) missing.push(kind);
          }
          const result = kinds.length > 0 && missing.length === 0 ? "pass" : "fail";
          await storeCheck(c, {
            kind: "code",
            name: "disclosure",
            result,
            renditionId: r.id,
            detail: { channels: kinds, missing_label: missing },
          });
        } catch (error) {
          await storeCheck(c, {
            kind: "code",
            name: "disclosure",
            result: "error",
            renditionId: r.id,
            detail: { error: (error as Error).message },
          });
        }
      }
    });
  }

  // 3. Model checks, only on what passed its code checks: a held draft needs no model's time.
  // Claims are shared by every language, so a claim's failure (or the verifier's) stops all of
  // them; a rendition's own failure stops only that rendition's item matching.
  checks = await inStory((c) => storyChecks(c, job.storyId));
  const failed = checks.filter((c) => c.kind === "code" && c.result !== "pass");
  const storyFailed = failed.some(
    (c) => c.claimId !== null || ["verifier", "beats", "claims"].includes(c.name),
  );
  if (!storyFailed) {
    await factCheck(deps, job, story, checks);
    const clean = new Set(
      story.renditions.filter((r) => !failed.some((c) => c.renditionId === r.id)).map((r) => r.id),
    );
    await itemMatch(
      deps,
      job,
      { ...story, renditions: story.renditions.filter((r) => clean.has(r.id)) },
      checks,
    );
  }

  // 4. Policy per publication still drafted.
  checks = await inStory((c) => storyChecks(c, job.storyId));
  const restricted = [
    ...new Set(
      checks
        .filter((c) => c.name === "beats")
        .flatMap((c) => (c.detail as { restricted?: string[] } | null)?.restricted ?? []),
    ),
  ];
  const outcomes: string[] = [];
  await inStory(async (client) => {
    for (const p of story.publications) {
      // Read under a lock now: the deadline sweep or an editor may have acted while checks ran.
      const { rows: now } = await client.query<{ status: string }>(
        "select status from publications where id = $1 for update",
        [p.id],
      );
      if (now[0]?.status !== "drafted") continue;
      const rendition = story.renditions.find((r) => r.id === p.rendition_id);
      // Re-drafted from a later story (D87): that story's gate decides it.
      if (p.rendition_id && !rendition) continue;
      const decision = decide({
        renditionId: rendition?.id ?? null,
        items: rendition ? itemPaths(rendition.body).map(([path]) => path) : [],
        claims: story.claims.map((c) => ({ id: c.id, kind: c.kind, sources: c.sources.length })),
        checks: checks.filter((c) => c.claimId || c.renditionId === rendition?.id),
        themed: story.themed,
        format: story.format,
        autoPublish: story.autoPublish,
        restricted,
      });
      if (decision.status === "scheduled") {
        await client.query(
          `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
           values (anr.current_newsroom_id(), $1, 'policy', 'auto-publish', 'pass', '{}')`,
          [p.id],
        );
        await auditedUpdate(
          client,
          { kind: "code", name: "gate" },
          "schedule",
          "publications",
          p.id,
          {
            status: "scheduled",
            updated_at: new Date(),
          },
        );
      } else {
        for (const hold of decision.holds) await holdPublications(client, [p.id], hold);
      }
      outcomes.push(`${p.language} ${decision.status}`);
    }
  });
  log(`[gate] story ${job.storyId}: ${outcomes.join(", ") || "no drafted publication"}`);
  return outcomes.join(", ");
}

/** The story's writers, from its desk and renderer runs: every family that answered (D71). */
async function writerFamilies(client: Client, storyId: string): Promise<string[]> {
  const { rows } = await client.query<{ family: string }>(
    `select distinct unnest(families) as family from agent_runs
     where story_id = $1 and role in ('desk', 'renderer')`,
    [storyId],
  );
  return rows.map((r) => r.family);
}

async function startChecker(
  deps: GateDeps,
  job: GateJob,
  role: AgentRole,
  chainFor: (client: Client) => Promise<string[]>,
  format: string,
): Promise<{ runId: string; model: RunModel } | { error: string }> {
  return withNewsroom(deps.pool, job.newsroomId, async (client) => {
    const budget = await budgetState(client);
    const verdict = mayStart(role, budget);
    if (!verdict.ok) {
      await noticeBudget(client, budget);
      return { error: verdict.reason };
    }
    let chain: string[];
    try {
      chain = await chainFor(client);
    } catch (error) {
      return { error: (error as Error).message };
    }
    const [first] = chain;
    if (!first) return { error: `the ${role} chain is empty` };
    const { id } = await insertRun(client, {
      role,
      ...deps.router.describe(first),
      promptVersion: assemblePrompt(role, {
        role: role === "fact-checker" ? FACT_CHECKER_ROLE : ITEM_MATCHER_ROLE,
      }).version,
      input: `${job.storyId}:${role}`,
      storyId: job.storyId,
    });
    return {
      runId: id,
      model: deps.makeModel(chain, formatMeta(deps.configDir, format).run_tokens),
    };
  });
}

async function factCheck(deps: GateDeps, job: GateJob, story: GateStory, checks: StoredCheck[]) {
  const pending = story.claims
    .filter((c) => c.kind === "fact")
    .flatMap((c) => c.sources.map((s, i) => ({ claim: c, source: s, index: i })))
    .filter(
      ({ claim, index }) =>
        !checks.some(
          (x) => x.kind === "fact-check" && x.claimId === claim.id && x.position === index,
        ),
    );
  if (pending.length === 0) return;
  const started = await startChecker(
    deps,
    job,
    "fact-checker",
    async (client) =>
      deps.router.resolve("fact-checker", {
        writerFamilies: await writerFamilies(client, job.storyId),
      }),
    story.format,
  );
  await runChecker(
    deps,
    job,
    started,
    pending,
    async ({ claim, source, index }, model) => {
      const verdict = await askVerdict(
        model,
        FACT_CHECKER_ROLE,
        factQuestion(claim.text, source.quoted_passage),
        parseFact,
      );
      return {
        kind: "fact-check",
        name: "fact-check",
        claimId: claim.id,
        verdict,
        detail: { lead_id: source.lead_id, position: index },
      };
    },
    ({ claim, source, index }) => ({
      kind: "fact-check",
      name: "fact-check",
      claimId: claim.id,
      detail: { lead_id: source.lead_id, position: index },
    }),
  );
}

async function itemMatch(deps: GateDeps, job: GateJob, story: GateStory, checks: StoredCheck[]) {
  const byRef = new Map(story.claims.map((c) => [c.ref, c]));
  const pending = story.renditions.flatMap((r) =>
    itemPaths(r.body)
      .filter(
        ([path]) =>
          !checks.some((x) => x.kind === "item-match" && x.renditionId === r.id && x.item === path),
      )
      .map(([path, item]) => ({ rendition: r, path, item })),
  );
  if (pending.length === 0) return;
  const started = await startChecker(
    deps,
    job,
    "item-matcher",
    async () => deps.router.resolve("item-matcher"),
    story.format,
  );
  await runChecker(
    deps,
    job,
    started,
    pending,
    async ({ rendition, path, item }, model) => {
      const listed = ((item.claim_ids as string[] | undefined) ?? []).map(
        (ref) => byRef.get(ref)?.text ?? `(unknown claim ${ref})`,
      );
      const verdict = await askVerdict(
        model,
        ITEM_MATCHER_ROLE,
        itemQuestion(itemText(item), listed),
        parseItem,
      );
      return {
        kind: "item-match",
        name: "item-match",
        renditionId: rendition.id,
        item: path,
        verdict,
      };
    },
    ({ rendition, path }) => ({
      kind: "item-match",
      name: "item-match",
      renditionId: rendition.id,
      item: path,
    }),
  );
}

type Asked = Omit<NewCheck, "result"> & { verdict: Awaited<ReturnType<typeof askVerdict>> };

/**
 * Runs one checker over its pending questions, storing each answer as it comes, so a crash keeps
 * what was checked. A question the models cannot answer is stored as an error or timeout.
 */
async function runChecker<T>(
  deps: GateDeps,
  job: GateJob,
  started: { runId: string; model: RunModel } | { error: string },
  pending: T[],
  ask: (p: T, model: RunModel) => Promise<Asked>,
  target: (p: T) => Omit<NewCheck, "result">,
) {
  const store = (c: NewCheck) =>
    withNewsroom(deps.pool, job.newsroomId, (client) => storeCheck(client, c));
  if ("error" in started) {
    for (const p of pending)
      await store({
        ...target(p),
        result: "error",
        detail: { ...(target(p).detail as object), error: started.error },
      });
    return;
  }
  let failure: { result: "error" | "timed-out"; detail: string } | null = null;
  for (const p of pending) {
    if (failure) {
      await store({
        ...target(p),
        result: failure.result,
        detail: { ...(target(p).detail as object), error: failure.detail },
      });
      continue;
    }
    try {
      const { verdict, ...rest } = await ask(p, started.model);
      await store(
        "error" in verdict
          ? {
              ...rest,
              result: "error",
              detail: { ...(rest.detail as object), error: verdict.error },
            }
          : {
              ...rest,
              result: verdict.result,
              detail: {
                ...(rest.detail as object),
                reason: verdict.reason,
                by: started.model.meter.answered,
              },
            },
      );
    } catch (error) {
      failure = failureResult(error);
      if (!failure) {
        // The gate job is retried with a new checker run; this one closes with what it spent.
        await withNewsroom(deps.pool, job.newsroomId, (client) =>
          finishRun(client, started.runId, "error", started.model.meter, {
            detail: { error: (error as Error).message },
          }),
        );
        throw error;
      }
      await store({
        ...target(p),
        result: failure.result,
        detail: { ...(target(p).detail as object), error: failure.detail },
      });
    }
  }
  await withNewsroom(deps.pool, job.newsroomId, async (client) => {
    await finishRun(
      client,
      started.runId,
      failure ? "error" : "submitted",
      started.model.meter ?? newMeter(),
      failure ? { detail: failure } : {},
    );
    await noticeBudget(client, await budgetState(client));
  });
}
