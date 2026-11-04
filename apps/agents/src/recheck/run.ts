// The one-off check of imported news (D184). Two passes, each resumable and safe to run again:
// `source` requests each imported news item's source through ingestion and has the desk's chain
// write the item's claims against it; `check` runs the gate on each story whose claims are written
// and whose sources the summariser has placed in beats. The gate records what passed; nothing here
// changes a publication's status.
import type { Language } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { ModelsConfig } from "@anr/models";
import type { PgBoss } from "pg-boss";
import { type GateDeps, runGate } from "../gate/run.ts";
import type { IngestionClient } from "../ingest.ts";
import { newMeter, type RunModel } from "../model.ts";
import type { ModelRouter } from "../router.ts";
import { finishRun, insertRun } from "../runs.ts";
import { enqueueSummaries } from "../summariser/run.ts";
import { CLAIMS_PROMPT_VERSION, writeClaims } from "./claims.ts";

export interface RecheckDeps {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  router: ModelRouter;
  models: ModelsConfig;
  ingestion: Pick<IngestionClient, "requestSource">;
  makeModel: (chain: readonly string[]) => RunModel;
  gate: GateDeps;
  /** Summarises new sources here, for where no agents worker runs (dev); else the worker does. */
  summarise?: (newsroomId: string, runIds: string[]) => Promise<void>;
  /** Asked between items: true ends the pass there, the item in hand finished. */
  shouldStop?: () => Promise<boolean>;
  log?: (line: string) => void;
}

export interface RecheckOptions {
  newsroomId: string;
  /** At most this many stories per pass. */
  limit: number;
}

/** An item whose source or claims failed is tried again on later passes, this many times in all. */
export const ITEM_TRIES = 3;

/** The recheck's desk runs on a story's items. */
const RECHECK_RUN = `x.story_id = st.id and x.role = 'desk' and x.task->>'key' = 'recheck'`;

interface NewsItem {
  kind?: string;
  headline?: string;
  body?: string;
  url?: string;
  org?: string;
  related?: string[];
  claim_ids?: string[];
}

interface Story {
  storyId: string;
  format: string;
  renditions: { id: string; language: Language; items: NewsItem[] }[];
}

/**
 * The families that may have written imported text, so none of them checks it (invariant 4): the
 * old system wrote the Persian with Claude, and the import translated it with Claude or on the
 * renderer's chain (D169). Every Claude model in the catalog, whoever serves it, and every model
 * of the renderer's chain; never empty, so a missing family fails closed.
 */
export function importFamilies(
  models: ModelsConfig,
  router: Pick<ModelRouter, "resolve" | "family">,
): string[] {
  const claude = Object.entries(models.models)
    .filter(
      ([id, m]) =>
        m.provider === "anthropic" || [id, m.model, m.family].some((x) => /claude/i.test(x ?? "")),
    )
    .map(([, m]) => m.family);
  const renderer = router.resolve("renderer").map((id) => router.family(id));
  if (renderer.length === 0) throw new Error("the renderer chain is empty");
  return [...new Set([...claude, ...renderer])];
}

/** Imported stories with news items, newest first (what readers see most), that this pass has not yet taken. */
async function stories(pool: Pool, o: RecheckOptions, pass: "source" | "check"): Promise<Story[]> {
  return withNewsroom(pool, o.newsroomId, async (c) => {
    const { rows } = await c.query<{
      story_id: string;
      format: string;
      renditions: { id: string; language: Language; items: NewsItem[] }[];
    }>(
      `select st.id as story_id, min(f.slug) as format,
              jsonb_agg(jsonb_build_object('id', r.id, 'language', r.language,
                                           'items', r.body->'items') order by r.language) as renditions
       from stories st
       join assignments a on a.id = st.assignment_id
       join renditions r on r.story_id = st.id
       join formats f on f.id = r.format_id
       where exists (select from publications p where p.assignment_id = a.id and p.origin = 'imported')
         and not exists (select from publications p where p.assignment_id = a.id and p.origin <> 'imported')
         and exists (select from jsonb_array_elements(r.body->'items') i
                     where i->>'kind' = 'news' and i ? 'url')
         and ${
           pass === "source"
             ? // An item with a source not yet tried, or tried fewer than ITEM_TRIES times and failed.
               `exists (select from jsonb_array_elements(r.body->'items') with ordinality i(v, n)
                        where i.v->>'kind' = 'news' and i.v ? 'url'
                          and not exists (select from agent_runs x where ${RECHECK_RUN}
                                          and (x.task->>'item')::int = i.n - 1
                                          and (x.outcome is null or x.outcome = 'submitted'))
                          and (select count(*) from agent_runs x where ${RECHECK_RUN}
                               and (x.task->>'item')::int = i.n - 1) < ${ITEM_TRIES})`
             : // Claims written since the story was last checked, none still being written.
               `not exists (select from agent_runs x where ${RECHECK_RUN} and x.outcome is null)
                and coalesce((select max(k.at) from checks k where k.rendition_id = r.id), '-infinity')
                    < (select max(x.finished_at) from agent_runs x
                       where ${RECHECK_RUN} and x.outcome = 'submitted')
                and not exists (select from claims cl join leads l on l.id = cl.lead_id
                                where cl.story_id = st.id and l.summary is null)`
         }
       group by st.id, a.slot
       order by a.slot desc
       limit $1`,
      [o.limit],
    );
    return rows.map((r) => ({ storyId: r.story_id, format: r.format, renditions: r.renditions }));
  });
}

/** One story's sources and claims: one desk run per item (ingestion allows five requests a run). */
async function sourceStory(deps: RecheckDeps, o: RecheckOptions, story: Story): Promise<string> {
  const log = deps.log ?? console.log;
  const inNewsroom = <T>(fn: Parameters<typeof withNewsroom<T>>[2]) =>
    withNewsroom(deps.pool, o.newsroomId, fn);
  const chain = deps.router.resolve("desk", { format: story.format });
  const [first] = chain;
  if (!first) throw new Error("the desk chain is empty");
  // The import's writers, recorded once on the story (invariant 4).
  const families = importFamilies(deps.models, deps.router);
  const [translator] = deps.router.resolve("renderer");
  const tried = await inNewsroom(async (c) => {
    const { rows } = await c.query<{ item: number; outcome: string | null; key: string }>(
      `select (task->>'item')::int as item, outcome, task->>'key' as key from agent_runs
       where story_id = $1 and task->>'key' in ('recheck', 'recheck-import')`,
      [story.storyId],
    );
    return rows;
  });
  if (translator && !tried.some((t) => t.key === "recheck-import"))
    await inNewsroom(async (c) => {
      const { id } = await insertRun(c, {
        role: "renderer",
        ...deps.router.describe(translator),
        promptVersion: "legacy-import",
        input: `recheck-import:${story.storyId}`,
        storyId: story.storyId,
        task: { key: "recheck-import" },
      });
      await finishRun(c, id, "submitted", { ...newMeter(), families: new Set(families) });
    });

  const [base] = story.renditions;
  const count = base?.items.length ?? 0;
  // New claims are numbered after the story's earlier ones.
  let ref = await inNewsroom(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `select coalesce(max(substring(ref from 2)::int), 0)::int as n from claims
       where story_id = $1 and ref ~ '^c[0-9]+$'`,
      [story.storyId],
    );
    return rows[0]?.n ?? 0;
  });
  let written = 0;
  const newLeads: string[] = [];
  for (let index = 0; index < count; index++) {
    const url = base?.items[index]?.url;
    const runs = tried.filter((t) => t.key === "recheck" && t.item === index);
    const done = runs.some((t) => t.outcome === null || t.outcome === "submitted");
    // Written, being written, out of tries, or (an item naming no source) already told so.
    if (done || runs.length >= ITEM_TRIES || (runs.length > 0 && !url)) continue;
    if (await deps.shouldStop?.()) break;
    const { id: runId } = await inNewsroom((c) =>
      insertRun(c, {
        role: "desk",
        ...deps.router.describe(first),
        promptVersion: CLAIMS_PROMPT_VERSION,
        input: `recheck:${story.storyId}:${index}`,
        storyId: story.storyId,
        task: { key: "recheck", item: index } as { key: string },
      }),
    );
    const model = deps.makeModel(chain);
    const fail = (detail: string) =>
      inNewsroom((c) => finishRun(c, runId, "error", model.meter, { detail: { error: detail } }));
    if (base?.items[index]?.kind !== "news" || !url) {
      await fail("no source named");
      continue;
    }
    const got = await deps.ingestion.requestSource(o.newsroomId, runId, url);
    if (got.kind !== "lead") {
      await fail(`source: ${got.detail}`);
      continue;
    }
    const leadId = got.result.lead_id;
    if (got.result.created) newLeads.push(leadId);
    const lead = await inNewsroom(async (c) => {
      const { rows } = await c.query<{ body: string; language: string }>(
        "select body, language from leads where id = $1",
        [leadId],
      );
      return rows[0];
    });
    if (!lead) {
      await fail("source not stored");
      continue;
    }
    // Each language's text of the item gets its own claims, in that language.
    const refsByRendition = new Map<string, string[]>();
    let error = "";
    for (const r of story.renditions) {
      const item = r.items[index];
      if (!item?.headline) continue;
      const out = await writeClaims(
        model,
        {
          language: r.language,
          headline: item.headline,
          body: item.body ?? "",
          names: [...(item.org ? [item.org] : []), ...(item.related ?? [])],
        },
        { text: lead.body, language: lead.language },
      );
      if ("error" in out) {
        error = `${r.language}: ${out.error}`;
        break;
      }
      const refs = out.claims.map(() => `c${++ref}`);
      await inNewsroom(async (c) => {
        for (const [i, claim] of out.claims.entries())
          await c.query(
            `insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage)
             values (anr.current_newsroom_id(), $1, $2, 'fact', $3, $4, $5)`,
            [story.storyId, refs[i], claim.text, leadId, claim.passage],
          );
      });
      refsByRendition.set(r.id, refs);
    }
    if (error) {
      await fail(error);
      continue;
    }
    await inNewsroom(async (c) => {
      for (const [renditionId, refs] of refsByRendition)
        await c.query(
          `update renditions set body = jsonb_set(body, array['items', $2::text, 'claim_ids'], $3::jsonb)
           where id = $1`,
          [renditionId, String(index), JSON.stringify(refs)],
        );
      await finishRun(c, runId, "submitted", model.meter);
    });
    written++;
  }
  if (newLeads.length > 0) {
    const runs = await enqueueSummaries(deps.pool, deps.boss, deps.router, o.newsroomId, newLeads);
    await deps.summarise?.(o.newsroomId, runs);
  }
  const line = `story ${story.storyId}: claims for ${written} of ${count} items`;
  log(`[recheck] ${line}`);
  return line;
}

/** Summariser runs still waiting on the sources the recheck cited (a run that stopped midway). */
export async function waitingSummaries(pool: Pool, newsroomId: string): Promise<string[]> {
  return withNewsroom(pool, newsroomId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select r.id from agent_runs r join leads l on l.id = r.lead_id
       where r.role = 'summariser' and r.outcome is null and l.summary is null
         and exists (select from claims cl join agent_runs d on d.story_id = cl.story_id
                     where cl.lead_id = l.id and d.role = 'desk' and d.task->>'key' = 'recheck')`,
    );
    return rows.map((r) => r.id);
  });
}

/** The `source` pass: sources and claims for stories not yet taken. */
export async function sourcePass(deps: RecheckDeps, o: RecheckOptions): Promise<number> {
  if (deps.summarise)
    await deps.summarise(o.newsroomId, await waitingSummaries(deps.pool, o.newsroomId));
  const todo = await stories(deps.pool, o, "source");
  let done = 0;
  for (const s of todo) {
    if (await deps.shouldStop?.()) break;
    await sourceStory(deps, o, s);
    done++;
  }
  return done;
}

/** The `check` pass: the gate on each story whose claims are written and sources placed. */
export async function checkPass(deps: RecheckDeps, o: RecheckOptions): Promise<number> {
  const todo = await stories(deps.pool, o, "check");
  let done = 0;
  for (const s of todo) {
    if (await deps.shouldStop?.()) break;
    // An imported story has no beat; it takes the one its sources are placed in most, as the desk
    // would have chosen, so the verifier can clear it (D184).
    await withNewsroom(deps.pool, o.newsroomId, (c) =>
      c.query(
        `update stories st set beat_id = (
           select lb.beat_id from claims cl join lead_beats lb on lb.lead_id = cl.lead_id
           where cl.story_id = st.id group by lb.beat_id order by count(*) desc, lb.beat_id limit 1)
         where st.id = $1 and st.beat_id is null`,
        [s.storyId],
      ),
    );
    await runGate(deps.gate, { newsroomId: o.newsroomId, storyId: s.storyId });
    done++;
  }
  return done;
}
