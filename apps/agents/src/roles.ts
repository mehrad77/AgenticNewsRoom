// The role chains in force for each run: the models file's, or the ones the platform admin set at
// the desk (`platform_settings` key `models.roles`). The worker reads the setting before every job,
// so a change applies from the next run without a restart.
import { effectiveRoles } from "@anr/config";
import { MODEL_ROLES_KEY } from "@anr/core";
import type { Pool } from "@anr/db";
import type { ModelsConfig } from "@anr/models";
import type { ModelRouter } from "./router.ts";

/** The stored chains, or undefined without a row. */
export async function readStoredRoles(pool: Pick<Pool, "query">): Promise<unknown> {
  const { rows } = await pool.query<{ value: unknown }>(
    "select value from platform_settings where key = $1",
    [MODEL_ROLES_KEY],
  );
  return rows[0]?.value;
}

export interface RolesRefresh {
  router: ModelRouter;
  /** The models file: the catalog stored chains are checked against, and the default chains. */
  catalog: ModelsConfig;
  formats: readonly string[];
  read: () => Promise<unknown>;
  warn?: (message: string) => void;
}

/**
 * Returns a refresh to call before each job. It is one primary-key select, next to runs that take
 * seconds to minutes of model calls, so reading before every job costs nothing and means no run
 * starts on chains older than its job; a refresh interval would only add a window of staleness.
 * Concurrent calls share one read. Stored chains that are invalid against the current catalog (a
 * deploy removed a model, say) are set aside for the file's with one warning per distinct value; a
 * failed read keeps the chains in force. Neither ever stops a job.
 */
export function rolesRefresher({
  router,
  catalog,
  formats,
  read,
  warn = console.warn,
}: RolesRefresh) {
  let inFlight: Promise<void> | undefined;
  let warned: string | undefined;
  const refresh = async () => {
    let stored: unknown;
    try {
      stored = await read();
    } catch (error) {
      warn(
        `[agents] could not read ${MODEL_ROLES_KEY}, keeping the chains in force: ${(error as Error).message}`,
      );
      return;
    }
    const effective = effectiveRoles(catalog, stored, formats);
    if (effective.problems.length > 0) {
      const key = JSON.stringify(stored);
      if (warned !== key) {
        warned = key;
        warn(
          `[agents] the desk's model chains are not valid against the models file, so its chains run: ${effective.problems.join("; ")}`,
        );
      }
    } else warned = undefined;
    router.setRoles(effective.source === "desk" ? effective.roles : null);
  };
  return (): Promise<void> => {
    inFlight ??= refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
