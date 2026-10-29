// A reader challenge's reminders and deadlines (D114): four jobs queued with the challenge. Each
// finds the challenge's step done, or leaves the owner a notice in the desk: `challenge-due` a few
// hours before the deadline, `challenge-overdue` once it passed. A graph never waits for a person;
// these are rows and jobs.
import { type ChallengeDeadlineJob, QUEUES, REMINDER_HOURS } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import type { PgBoss } from "pg-boss";
import { onClient } from "../runs.ts";

export type ChallengeDeadlineOutcome = "noticed" | "done" | "early" | "gone";

export async function challengeDeadline(
  pool: Pool,
  boss: Pick<PgBoss, "send">,
  job: ChallengeDeadlineJob,
  now: Date = new Date(),
): Promise<ChallengeDeadlineOutcome> {
  return withNewsroom(pool, job.newsroomId, async (client) => {
    const { rows } = await client.query<{
      deadline: Date;
      done: boolean;
      publication: string;
      title: string | null;
    }>(
      `select case when $2 = 'acknowledge' then k.acknowledge_by else k.answer_by end as deadline,
              (case when $2 = 'acknowledge' then k.acknowledged_at else k.answered_at end) is not null
                as done,
              k.publication_id as publication, p.title
       from challenges k join publications p on p.id = k.publication_id where k.id = $1`,
      [job.challengeId, job.step],
    );
    const c = rows[0];
    if (!c) return "gone";
    if (c.done) return "done";
    const when =
      job.at === "due" ? new Date(c.deadline.getTime() - REMINDER_HOURS * 3_600_000) : c.deadline;
    if (now < when) {
      // Run early (a clock moved): come back on time.
      await boss.send(QUEUES.challengeDeadline, job, {
        db: onClient(client),
        startAfter: when,
        singletonKey: `${job.challengeId}:${job.step}:${job.at}:${when.toISOString()}`,
      });
      return "early";
    }
    await client.query(
      `insert into notices (newsroom_id, kind, key, detail)
       values (anr.current_newsroom_id(), $1, $2, $3)
       on conflict (newsroom_id, kind, key) do nothing`,
      [
        job.at === "due" ? "challenge-due" : "challenge-overdue",
        `${job.challengeId}:${job.step}`,
        JSON.stringify({
          challenge: job.challengeId,
          step: job.step,
          deadline: c.deadline.toISOString(),
          publication: c.publication,
          title: c.title,
        }),
      ],
    );
    return "noticed";
  });
}
