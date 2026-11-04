// pnpm --filter @anr/agents recheck --newsroom <slug> [--pass source|check|both] [--limit N]
//   [--summarise]: summarise new sources here, where no agents worker runs
// Development only: the passes of the check of imported news (D184) at once, without a run. The
// newsroom starts and stops it at the desk, and the agents worker runs it (recheck/round.ts).

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBoss, createPool } from "@anr/db";
import { buildCatalog, loadModelsConfig, ModelGateway, modelsFile } from "@anr/models";
import { ModelRouter } from "../router.ts";
import { gatewayModel } from "../summariser/model.ts";
import { runSummariser } from "../summariser/run.ts";
import { recheckDeps } from "./deps.ts";
import { checkPass, sourcePass } from "./run.ts";

const { values } = parseArgs({
  options: {
    newsroom: { type: "string" },
    pass: { type: "string", default: "both" },
    limit: { type: "string", default: "20" },
    summarise: { type: "boolean", default: false },
  },
});
const connectionString = process.env.DATABASE_URL;
if (!connectionString || !values.newsroom) {
  console.error("recheck: needs DATABASE_URL and --newsroom <slug>");
  process.exit(1);
}
const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../../config", import.meta.url));
const models = loadModelsConfig(modelsFile(configDir));
const router = new ModelRouter(models);
const catalog = buildCatalog(models);
const gateway = new ModelGateway(catalog);
const pool = createPool(connectionString);
const boss = createBoss(connectionString, "agents");
await boss.start();
try {
  const { rows } = await pool.query<{ id: string }>("select id from newsrooms where slug = $1", [
    values.newsroom,
  ]);
  const newsroomId = rows[0]?.id;
  if (!newsroomId) throw new Error(`no newsroom ${values.newsroom}`);
  const deps = recheckDeps({
    pool,
    boss,
    router,
    models,
    catalog,
    gateway,
    configDir,
    ingestionUrl: process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101",
    verifierUrl: process.env.ANR_VERIFIER_URL ?? "http://127.0.0.1:8102",
    summarise: values.summarise
      ? async (id: string, runIds: string[]) => {
          // A summary that fails leaves its story waiting for the next pass, not the job stopped.
          for (const agentRunId of runIds)
            await runSummariser(pool, router, (chain) => gatewayModel(gateway, chain), {
              newsroomId: id,
              agentRunId,
            }).catch((error: Error) =>
              console.error(`[recheck] summary ${agentRunId}: ${error.message}`),
            );
        }
      : undefined,
  });
  const missing = await deps.notLoaded();
  if (missing.length > 0) throw new Error(`load these models first: ${missing.join(", ")}`);
  const options = { newsroomId, limit: Number(values.limit) };
  if (values.pass !== "check")
    console.log(`[recheck] sourced ${await sourcePass(deps, options)} stories`);
  if (values.pass !== "source")
    console.log(`[recheck] checked ${await checkPass(deps, options)} stories`);
} finally {
  await boss.stop();
  await pool.end();
}
