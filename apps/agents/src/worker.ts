// Agents worker: each agent run is one pg-boss job that runs one LangGraph.js graph and ends with
// one submit. The daily assignment and the verifier gate run here too.
import { fileURLToPath } from "node:url";
import type { AgentRole } from "@anr/core";
import { createBoss, createPool, drainControl, startHeartbeat, withNewsroom } from "@anr/db";
import { buildCatalog, loadModelsConfig, ModelGateway, missingKeys, modelsFile } from "@anr/models";
import { createRenderer } from "@anr/render";
import { assignDaily, assignPick } from "./assign.ts";
import { challengeDeadline } from "./challenges/deadline.ts";
import type { RoleDeps } from "./desk/run.ts";
import { runDesk } from "./desk/run.ts";
import { dispatchAgentRun } from "./dispatch.ts";
import { runGate, verifierClient } from "./gate/run.ts";
import { sweepStuck } from "./gate/sweep.ts";
import { handleIngestSource, ingestionClient } from "./ingest.ts";
import { registerJobs } from "./jobs.ts";
import { ingestMedia } from "./media/ingest.ts";
import { meteredModel } from "./model.ts";
import { pickDeadline } from "./planner/deadline.ts";
import { runPlanner } from "./planner/run.ts";
import { planTick } from "./planner/tick.ts";
import { assignEpisode } from "./podcast/episode.ts";
import { isEpisodeRun, runEpisode } from "./podcast/run.ts";
import { redraft } from "./redraft.ts";
import { runRenderer } from "./renderer/run.ts";
import { ModelRouter } from "./router.ts";
import { gatewayModel } from "./summariser/model.ts";
import { enqueueSummaries, resumeSummaries, summariserHandler } from "./summariser/run.ts";
import { Throttle } from "./throttle.ts";

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const models = loadModelsConfig(modelsFile(configDir));
const router = new ModelRouter(models);
const catalog = buildCatalog(models);
const gateway = new ModelGateway(catalog);
const missing = missingKeys(catalog);
if (missing.length > 0)
  console.warn(`[agents] models without keys are skipped: ${missing.join(", ")}`);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = createPool(connectionString);
const stopHeartbeat = startHeartbeat(pool, "agents");
const boss = createBoss(connectionString, "agents");
await boss.start();
const ingestion = ingestionClient(process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101");

/** Whether any model a role may use has a key; a role without one waits in the queue. */
const hasKey = (chain: readonly string[]) => chain.some((id) => catalog.entries.get(id)?.apiKey);
const chains = (role: AgentRole): string[] =>
  role === "desk"
    ? [...models.roles.desk.default, ...Object.values(models.roles.desk.by_format ?? {}).flat()]
    : role === "fact-checker"
      ? [...models.roles["fact-checker"]]
      : router.resolve(role);
const canRun = (role: AgentRole) => hasKey(chains(role));

const roleDeps: RoleDeps = {
  pool,
  boss,
  router,
  configDir,
  makeModel: (chain, tokenCap) => meteredModel(gateway, chain, { tokenCap }),
  ingestion,
};
const run =
  (fn: (deps: RoleDeps, job: Parameters<typeof runDesk>[1]) => Promise<string | null>) =>
  async (job: Parameters<typeof runDesk>[1]) => {
    const outcome = await fn(roleDeps, job);
    if (outcome) console.log(`[agents] run ${job.agentRunId}: ${outcome}`);
  };

// Handlers are registered through the drain control, which works only undrained queues (D144).
const drains = drainControl(pool, boss);
await registerJobs(drains.boss, {
  "ingest-source": async (job) => {
    await handleIngestSource(job, {
      ingestion,
      onNewLeads: async (newsroomId, ids) => {
        await enqueueSummaries(pool, boss, router, newsroomId, ids);
      },
    });
    if (canRun("summariser")) await resumeSummaries(pool, boss, router);
  },
  assign: async (job) => {
    const { pickId } = job;
    let outcome = pickId
      ? await assignPick(pool, boss, router, { ...job, pickId })
      : await assignDaily(pool, boss, router, job);
    // A weekly series built from segments: the episode (D107).
    if (outcome.kind === "not-daily") outcome = await assignEpisode(pool, boss, router, job);
    console.log(`[agents] assign ${job.seriesId}: ${JSON.stringify(outcome)}`);
  },
  plan: async (job) => {
    const outcomes = await planTick(pool, boss, router, job);
    if (outcomes.length > 0)
      console.log(`[agents] plan ${job.newsroomId}: ${JSON.stringify(outcomes)}`);
  },
  "pick-deadline": async (job) => {
    const outcome = await pickDeadline(pool, boss, job);
    console.log(`[agents] pick ${job.pickId} deadline: ${outcome}`);
  },
  "challenge-deadline": async (job) => {
    const outcome = await challengeDeadline(pool, boss, job);
    console.log(`[agents] challenge ${job.challengeId} ${job.step} ${job.at}: ${outcome}`);
  },
  "ingest-media": async (job) => {
    const outcome = await ingestMedia(pool, ingestion, job);
    console.log(`[agents] media ${job.url}: ${JSON.stringify(outcome)}`);
  },
  "agent-run": dispatchAgentRun({
    pool,
    boss,
    canRun,
    handlers: {
      summariser: summariserHandler({
        pool,
        boss,
        router,
        makeModel: (chain) => gatewayModel(gateway, chain),
        throttle: Throttle.perMinute(Number(process.env.ANR_SUMMARISER_RPM ?? 10)),
      }),
      planner: run((deps, job) => runPlanner(deps, job)),
      desk: run(runDesk),
      renderer: run(async (deps, job) =>
        (await withNewsroom(pool, job.newsroomId, (c) => isEpisodeRun(c, job.agentRunId)))
          ? runEpisode(deps, job)
          : runRenderer(deps, job),
      ),
    },
  }),
  redraft: async (job) => {
    const outcome = await redraft(pool, boss, router, job);
    console.log(`[agents] redraft ${job.assignmentId}: ${JSON.stringify(outcome)}`);
  },
  gate: async (job) => {
    await runGate(
      {
        pool,
        router,
        configDir,
        verifier: verifierClient(process.env.ANR_VERIFIER_URL ?? "http://127.0.0.1:8102"),
        renderer: createRenderer(),
        makeModel: (chain, tokenCap) => meteredModel(gateway, chain, { tokenCap }),
      },
      job,
    );
  },
});

await drains.start();

/** Holds whatever is still being written or checked shortly before its slot (D80). */
const SWEEP_EVERY_MS = 5 * 60_000;
const sweep = async () => {
  const held = await sweepStuck(pool).catch((error: Error) => {
    console.error(`[gate] sweep failed: ${error.message}`);
    return 0;
  });
  if (held > 0) console.log(`[gate] held ${held} publications past their deadline`);
};
await sweep();
const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
if (canRun("summariser")) {
  const resumed = await resumeSummaries(pool, boss, router);
  if (resumed > 0) console.log(`[agents] resumed ${resumed} unfinished summaries`);
}
for (const role of [
  "summariser",
  "planner",
  "desk",
  "renderer",
  "fact-checker",
  "item-matcher",
] as const) {
  if (!canRun(role)) console.warn(`[agents] no key for any ${role} model: its runs wait`);
}
console.log(`agents worker started (${modelsFile(configDir)})`);

const stop = async () => {
  stopHeartbeat();
  drains.stop();
  clearInterval(sweeper);
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
