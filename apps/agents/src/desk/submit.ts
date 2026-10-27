// The desk's and the renderer's submit (D77): the only write an agent run makes. One transaction
// closes the run, stores what it wrote, moves its publication to drafted and queues what comes
// next, so a retried job never submits twice.
import { type GateJob, QUEUES } from "@anr/core";
import { auditedUpdate, type Client } from "@anr/db";
import type { PgBoss } from "pg-boss";
import type { Meter } from "../model.ts";
import type { ModelRouter } from "../router.ts";
import { createRun, finishRun, onClient } from "../runs.ts";
import type { Draft } from "./validate.ts";

interface Submitted {
  runId: string;
  meter: Meter;
  promptVersion: string;
}

/** Stores a rendition, links it to its language's publication and marks that publication drafted. */
async function storeRendition(
  client: Client,
  storyId: string,
  assignmentId: string,
  format: string,
  rendition: Draft["rendition"],
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into renditions (newsroom_id, story_id, format_id, language, body)
     select anr.current_newsroom_id(), $1, f.id, $3, $4 from formats f where f.slug = $2
     returning id`,
    [storyId, format, rendition.language, JSON.stringify(rendition)],
  );
  const renditionId = rows[0]?.id;
  if (!renditionId) throw new Error(`unknown format ${format}`);
  const { rows: pubs } = await client.query<{ id: string; status: string }>(
    "select id, status from publications where assignment_id = $1 and language = $2",
    [assignmentId, rendition.language],
  );
  const publication = pubs[0];
  if (!publication) throw new Error(`no ${rendition.language} publication for the assignment`);
  await client.query(
    `insert into publication_renditions (newsroom_id, publication_id, position, rendition_id)
     values (anr.current_newsroom_id(), $1, 1, $2)`,
    [publication.id, renditionId],
  );
  if (publication.status === "assigned") {
    await auditedUpdate(
      client,
      { kind: "agent", role: "desk" },
      "draft",
      "publications",
      publication.id,
      {
        status: "drafted",
        updated_at: new Date(),
      },
    );
  }
  return renditionId;
}

/** Queues the gate once no renderer run of the story is still open (D80). */
export async function gateWhenRendered(
  client: Client,
  boss: Pick<PgBoss, "send">,
  storyId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ open: number; newsroom_id: string }>(
    `select count(*) filter (where r.outcome is null)::int as open, s.newsroom_id
     from stories s left join agent_runs r on r.story_id = s.id and r.role = 'renderer'
     where s.id = $1 group by s.newsroom_id`,
    [storyId],
  );
  const row = rows[0];
  if (!row || row.open > 0) return false;
  const job: GateJob = { newsroomId: row.newsroom_id, storyId };
  // One gate per story, however many renderers finish at once.
  await boss.send(QUEUES.gate, job, { db: onClient(client), singletonKey: storyId });
  return true;
}

export interface DeskSubmit extends Submitted {
  assignmentId: string;
  format: string;
  /** The series' languages; the first rendition's is written, the rest go to renderers. */
  languages: readonly string[];
  draft: Draft;
}

export async function submitStory(
  client: Client,
  boss: Pick<PgBoss, "send">,
  router: ModelRouter,
  s: DeskSubmit,
): Promise<string | null> {
  const story = s.draft.story;
  if (!story) throw new Error("a desk submit carries a story");
  if (
    !(await finishRun(client, s.runId, "submitted", s.meter, { promptVersion: s.promptVersion }))
  ) {
    return null;
  }
  const { rows } = await client.query<{ id: string }>(
    `insert into stories (newsroom_id, assignment_id, summary, beat_id)
     select anr.current_newsroom_id(), $1, $2,
            (select id from beats where slug = $3 and removed_at is null)
     returning id`,
    [s.assignmentId, story.summary, story.beat],
  );
  const storyId = rows[0]?.id ?? "";
  await client.query("update agent_runs set story_id = $2 where id = $1", [s.runId, storyId]);
  for (const c of story.claims) {
    const { rows: claim } = await client.query<{ id: string }>(
      `insert into claims (newsroom_id, story_id, ref, kind, text, lead_id, quoted_passage)
       values (anr.current_newsroom_id(), $1, $2, $3, $4, $5, $6) returning id`,
      [storyId, c.id, c.kind, c.text, c.lead_id, c.quoted_passage],
    );
    for (const [i, also] of (c.also ?? []).entries()) {
      await client.query(
        `insert into claim_sources (newsroom_id, claim_id, position, lead_id, quoted_passage)
         values (anr.current_newsroom_id(), $1, $2, $3, $4)`,
        [claim[0]?.id, i + 1, also.lead_id, also.quoted_passage],
      );
    }
  }
  await storeRendition(client, storyId, s.assignmentId, s.format, s.draft.rendition);

  const others = s.languages.filter((l) => l !== s.draft.rendition.language);
  const [first] = router.resolve("renderer");
  if (!first) throw new Error("the renderer chain is empty");
  for (const language of others) {
    await createRun(client, boss, {
      role: "renderer",
      ...router.describe(first),
      promptVersion: "renderer",
      input: `${storyId}:${language}`,
      assignmentId: s.assignmentId,
      storyId,
      language,
    });
  }
  if (others.length === 0) await gateWhenRendered(client, boss, storyId);
  return storyId;
}

export interface RenditionSubmit extends Submitted {
  assignmentId: string;
  storyId: string;
  format: string;
  rendition: Draft["rendition"];
}

export async function submitRendition(
  client: Client,
  boss: Pick<PgBoss, "send">,
  s: RenditionSubmit,
): Promise<string | null> {
  if (
    !(await finishRun(client, s.runId, "submitted", s.meter, { promptVersion: s.promptVersion }))
  ) {
    return null;
  }
  const id = await storeRendition(client, s.storyId, s.assignmentId, s.format, s.rendition);
  await gateWhenRendered(client, boss, s.storyId);
  return id;
}
