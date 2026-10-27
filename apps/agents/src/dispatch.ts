// The agent-run queue serves every role: a job names a run, the run's row names its role. A role
// whose chain has no model with a key waits, re-queued, rather than failing its run.
import { type AgentRole, type AgentRunJob, QUEUES } from "@anr/core";
import { type Pool, withNewsroom } from "@anr/db";
import { AllModelsExhausted } from "@anr/models";
import type { PgBoss } from "pg-boss";
import { rateLimitDelayMs } from "./throttle.ts";

export type RoleHandler = (job: AgentRunJob) => Promise<void>;

/** A chain that is cooling down, or has no key yet, is tried again after this long. */
export const RETRY_LATER_MS = 60_000;
export const NO_KEY_DELAY_MS = 15 * 60_000;

export interface DispatchDeps {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  handlers: Partial<Record<AgentRole, RoleHandler>>;
  /** Whether any model of the role's chain has a key. */
  canRun: (role: AgentRole) => boolean;
  log?: (line: string) => void;
}

export function dispatchAgentRun(deps: DispatchDeps): (job: AgentRunJob) => Promise<void> {
  const log = deps.log ?? console.log;
  const later = (job: AgentRunJob, ms: number) =>
    deps.boss.send(QUEUES.agentRun, job, { startAfter: Math.ceil(ms / 1000) });
  return async (job) => {
    const role = await withNewsroom(deps.pool, job.newsroomId, async (client) => {
      const { rows } = await client.query<{ role: AgentRole; outcome: string | null }>(
        "select role, outcome from agent_runs where id = $1",
        [job.agentRunId],
      );
      return rows[0]?.outcome === null ? rows[0].role : null;
    });
    if (!role) return;
    const handler = deps.handlers[role];
    if (!handler) {
      log(`[agents] no handler for ${role} runs; run ${job.agentRunId} waits`);
      await later(job, NO_KEY_DELAY_MS);
      return;
    }
    if (!deps.canRun(role)) {
      await later(job, NO_KEY_DELAY_MS);
      return;
    }
    try {
      await handler(job);
    } catch (error) {
      // The whole chain rate-limited or down: try later, without using up a pg-boss retry.
      const delay =
        error instanceof AllModelsExhausted
          ? error.transient
            ? RETRY_LATER_MS
            : null
          : rateLimitDelayMs(error);
      if (delay === null) throw error;
      await later(job, delay);
      log(
        `[agents] ${role} run ${job.agentRunId}: models busy, waits ${Math.ceil(delay / 1000)} s`,
      );
    }
  };
}
