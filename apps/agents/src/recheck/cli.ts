// pnpm --filter @anr/agents recheck --newsroom <slug> [--pass source|check|both] [--limit N]
//   [--summarise]: summarise new sources here, where no agents worker runs (dev)
// The one-off check of a newsroom's imported news (D184), run where the agents worker runs (it
// needs ingestion and the verifier). Each pass takes up where the last stopped.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBoss, createPool } from "@anr/db";
import { buildCatalog, loadModelsConfig, ModelGateway, modelsFile } from "@anr/models";
import { createRenderer } from "@anr/render";
import { verifierClient } from "../gate/run.ts";
import { ingestionClient } from "../ingest.ts";
import { meteredModel } from "../model.ts";
import { ModelRouter } from "../router.ts";
import { gatewayModel } from "../summariser/model.ts";
import { runSummariser } from "../summariser/run.ts";
import { notLoaded } from "./preflight.ts";
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
// The chains the recheck uses: the desk's (claims), the fact-checker's and the item matcher's.
const used = [
  ...models.roles.desk.default,
  ...Object.values(models.roles.desk.by_format ?? {}).flat(),
  ...models.roles["fact-checker"],
  ...router.resolve("item-matcher"),
].flatMap((id) => catalog.entries.get(id) ?? []);
const missing = await notLoaded([...new Set(used)]);
if (missing.length > 0) {
  console.error(`recheck: load these models first: ${missing.join(", ")}`);
  process.exit(1);
}
const pool = createPool(connectionString);
const boss = createBoss(connectionString, "agents");
await boss.start();
try {
  const { rows } = await pool.query<{ id: string }>("select id from newsrooms where slug = $1", [
    values.newsroom,
  ]);
  const newsroomId = rows[0]?.id;
  if (!newsroomId) throw new Error(`no newsroom ${values.newsroom}`);
  const makeModel = (chain: readonly string[], tokenCap?: number) =>
    meteredModel(gateway, chain, { tokenCap });
  const deps = {
    pool,
    boss,
    router,
    models,
    ingestion: ingestionClient(process.env.ANR_INGESTION_URL ?? "http://127.0.0.1:8101"),
    makeModel,
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
    gate: {
      pool,
      router,
      configDir,
      verifier: verifierClient(process.env.ANR_VERIFIER_URL ?? "http://127.0.0.1:8102"),
      renderer: createRenderer(),
      makeModel,
    },
  };
  const options = { newsroomId, limit: Number(values.limit) };
  if (values.pass !== "check")
    console.log(`[recheck] sourced ${await sourcePass(deps, options)} stories`);
  if (values.pass !== "source")
    console.log(`[recheck] checked ${await checkPass(deps, options)} stories`);
} finally {
  await boss.stop();
  await pool.end();
}
