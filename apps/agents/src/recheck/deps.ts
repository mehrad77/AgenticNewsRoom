// What a recheck round needs, built the same way for the agents worker and the dev command.
import { QUEUES } from "@anr/core";
import type { Pool } from "@anr/db";
import type { buildCatalog, ModelGateway, ModelsConfig } from "@anr/models";
import { createRenderer } from "@anr/render";
import type { PgBoss } from "pg-boss";
import { verifierClient } from "../gate/run.ts";
import { ingestionClient } from "../ingest.ts";
import { meteredModel } from "../model.ts";
import type { ModelRouter } from "../router.ts";
import { notLoaded } from "./preflight.ts";
import type { RoundDeps } from "./round.ts";
import type { RecheckDeps } from "./run.ts";

export interface RecheckSetup {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  router: ModelRouter;
  models: ModelsConfig;
  catalog: ReturnType<typeof buildCatalog>;
  gateway: ModelGateway;
  configDir: string;
  ingestionUrl: string;
  verifierUrl: string;
  summarise?: RecheckDeps["summarise"];
}

/** The chains the recheck uses, as set at the desk or in the models file (D186): the desk's
 *  (claims), the fact-checker's and the item matcher's. */
export function recheckChains(s: Pick<RecheckSetup, "router">): string[] {
  const roles = s.router.roles();
  return [
    ...new Set([
      ...roles.desk.default,
      ...Object.values(roles.desk.by_format ?? {}).flat(),
      ...roles["fact-checker"],
      ...s.router.resolve("item-matcher"),
    ]),
  ];
}

export function recheckDeps(s: RecheckSetup): RoundDeps {
  const makeModel = (chain: readonly string[], tokenCap?: number) =>
    meteredModel(s.gateway, chain, { tokenCap });
  return {
    pool: s.pool,
    boss: s.boss,
    router: s.router,
    models: s.models,
    ingestion: ingestionClient(s.ingestionUrl),
    makeModel,
    summarise: s.summarise,
    gate: {
      pool: s.pool,
      router: s.router,
      configDir: s.configDir,
      verifier: verifierClient(s.verifierUrl),
      renderer: createRenderer(),
      makeModel,
    },
    notLoaded: () => notLoaded(recheckChains(s).flatMap((id) => s.catalog.entries.get(id) ?? [])),
    ingestionUp: async () => {
      try {
        return (
          await fetch(new URL("/healthz", s.ingestionUrl), { signal: AbortSignal.timeout(5_000) })
        ).ok;
      } catch {
        return false;
      }
    },
    next: async (job, startAfter) => {
      await s.boss.send(QUEUES.recheck, job, { singletonKey: job.newsroomId, startAfter });
    },
  };
}
