// A weekly episode's assignment (D107). At the series' `assignment_at`, code finds what each
// segment retells, published in the week before the slot: every story of a news-recap's source
// series, the latest story of a story segment's. The episode gets its own story whose claims are
// copies of those stories' claims (same lead and passage, `copied_from` the original), so the gate
// checks the episode like any story, and one renderer run per language writes the script. No
// model is asked anything here, and nothing is researched again.
import { type AssignJob, localDay, nextWeekly } from "@anr/core";
import { type Client, type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { AssignOutcome } from "../assign.ts";
import type { ModelRouter } from "../router.ts";
import { createRun } from "../runs.ts";
import type { SegmentPlan } from "./script.ts";

export const EPISODE_WINDOW_DAYS = 7;

export interface EpisodeSegment extends SegmentPlan {
  /** The source series' stories this segment retells, oldest first. */
  stories: string[];
}

/** A renderer run that writes one language of an episode script. */
export interface EpisodeTask {
  key: string;
  kind: "episode";
  segments: EpisodeSegment[];
}

interface SeriesRow {
  slug: string;
  languages: string[];
  segments: { kind: "news-recap" | "story"; minutes: number; from: string }[] | null;
  weekly: string | null;
  timezone: string;
}

/** Stories of `series` with a publication published in (from, to], each once, oldest first. */
async function publishedStories(
  client: Client,
  series: string,
  from: Date,
  to: Date,
): Promise<string[]> {
  const { rows } = await client.query<{ story_id: string }>(
    `select r.story_id from publications p
     join series s on s.id = p.series_id
     join publication_renditions pr on pr.publication_id = p.id
     join renditions r on r.id = pr.rendition_id
     where s.slug = $1 and p.status in ('published', 'corrected')
       and p.slot > $2 and p.slot <= $3
     group by r.story_id order by min(p.slot)`,
    [series, from, to],
  );
  return rows.map((r) => r.story_id);
}

/** Copies the stories' claims into the episode's story as c1, c2…, with their further sources. */
async function copyClaims(client: Client, storyId: string, sources: string[]): Promise<string[]> {
  const { rows } = await client.query<{ lead_id: string | null }>(
    `with original as (
       select c.*, row_number() over (order by array_position($2::uuid[], c.story_id), c.created_at, c.ref) as n
       from claims c where c.story_id = any($2::uuid[])
     ), copied as (
       insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage, copied_from)
       select anr.current_newsroom_id(), $1, 'c' || n, kind, text, lead_id, quoted_passage, id
       from original order by n
       returning id, copied_from, lead_id
     ), also as (
       insert into claim_sources (newsroom_id, claim_id, position, lead_id, quoted_passage)
       select anr.current_newsroom_id(), copied.id, cs.position, cs.lead_id, cs.quoted_passage
       from copied join claim_sources cs on cs.claim_id = copied.copied_from
       returning lead_id
     )
     select lead_id from copied union select lead_id from also`,
    [storyId, sources],
  );
  return [...new Set(rows.map((r) => r.lead_id).filter((id): id is string => id !== null))];
}

export async function assignEpisode(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  job: AssignJob,
  now: Date = new Date(),
): Promise<AssignOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<SeriesRow>(
      `select s.slug, s.languages, s.config->'segments' as segments,
              s.config->'cadence'->>'weekly' as weekly, n.timezone
       from series s join newsrooms n on n.id = s.newsroom_id
       where s.id = $1 and s.removed_at is null`,
      [job.seriesId],
    );
    const series = rows[0];
    if (!series?.segments || !series.weekly) return { kind: "not-daily" };
    const slot = nextWeekly(series.weekly, now, series.timezone);
    const at = slot.toISOString();
    const { rowCount: exists } = await client.query(
      "select from assignments where series_id = $1 and slot = $2",
      [job.seriesId, at],
    );
    if (exists) return { kind: "exists", slot: at };

    const from = new Date(slot.getTime() - EPISODE_WINDOW_DAYS * 86_400_000);
    const segments: EpisodeSegment[] = [];
    for (const s of series.segments) {
      const stories = await publishedStories(client, s.from.replace(/^week\./, ""), from, slot);
      segments.push({
        kind: s.kind,
        minutes: s.minutes,
        stories: s.kind === "story" ? stories.slice(-1) : stories,
      });
    }
    // A segment with nothing to retell is left out; the verifier holds an episode whose segments
    // are not the series' own, so a person decides whether it goes out.
    const told = segments.filter((s) => s.stories.length > 0);
    if (told.length === 0) {
      await client.query(
        `insert into notices (newsroom_id, kind, key, detail)
         values (anr.current_newsroom_id(), 'no-leads', $1, $2)
         on conflict (newsroom_id, kind, key) do nothing`,
        [`${series.slug}:${at}`, JSON.stringify({ series: series.slug, slot: at })],
      );
      return { kind: "no-leads", slot: at };
    }

    const { rows: cycle } = await client.query<{ id: string }>(
      `select id from editorial_cycles
       where status = 'approved' and starts <= $1::date and ends > $1::date`,
      [localDay(slot, series.timezone)],
    );
    const { rows: made } = await client.query<{ id: string }>(
      `insert into assignments (newsroom_id, series_id, slot, cycle_id)
       values (anr.current_newsroom_id(), $1, $2, $3)
       on conflict (newsroom_id, series_id, slot) do nothing returning id`,
      [job.seriesId, at, cycle[0]?.id ?? null],
    );
    const assignmentId = made[0]?.id;
    if (!assignmentId) return { kind: "exists", slot: at };
    await client.query(
      `insert into publications (newsroom_id, series_id, assignment_id, slot, language)
       select anr.current_newsroom_id(), $1, $2, $3, unnest($4::text[])`,
      [job.seriesId, assignmentId, at, series.languages],
    );
    const { rows: story } = await client.query<{ id: string }>(
      `insert into stories (newsroom_id, assignment_id, summary)
       values (anr.current_newsroom_id(), $1, $2) returning id`,
      [assignmentId, `The ${series.slug} episode of ${localDay(slot, series.timezone)}.`],
    );
    const storyId = story[0]?.id ?? "";
    const leads = await copyClaims(
      client,
      storyId,
      told.flatMap((s) => s.stories),
    );
    await client.query(
      `insert into assignment_leads (newsroom_id, assignment_id, lead_id)
       select anr.current_newsroom_id(), $1, unnest($2::uuid[])`,
      [assignmentId, leads],
    );

    const [first] = router.resolve("renderer");
    if (!first) throw new Error("the renderer chain is empty");
    let runId = "";
    for (const language of series.languages) {
      const task: EpisodeTask = {
        key: `episode:${assignmentId}:${language}`,
        kind: "episode",
        segments: told,
      };
      runId = await createRun(client, boss, {
        role: "renderer",
        ...router.describe(first),
        promptVersion: "renderer",
        input: `${storyId}:${language}`,
        assignmentId,
        storyId,
        language,
        task,
      });
    }
    return { kind: "assigned", assignmentId, leads: leads.length, runId };
  });
}
