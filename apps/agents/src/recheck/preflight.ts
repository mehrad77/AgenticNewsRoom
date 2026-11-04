// Before a long recheck: every model of the chains it uses that a local server serves (LM Studio
// on the laptop) must be loaded there, or the job would fall through to paid models or fail on
// every call. A person can change the chains or unload models at the desk (D186), so this is asked each time.
import type { CatalogEntry } from "@anr/models";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "[::1]"]);

/** The chain's models served from this machine. */
export function localModels(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.filter((e) => {
    if (!e.baseUrl) return false;
    try {
      return LOCAL_HOSTS.has(new URL(e.baseUrl).hostname);
    } catch {
      return false;
    }
  });
}

/** The local models not loaded where they are served; an unreachable server lists all of its. */
export async function notLoaded(
  entries: readonly CatalogEntry[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const missing: string[] = [];
  const byServer = new Map<string, CatalogEntry[]>();
  for (const e of localModels(entries)) {
    const url = (e.baseUrl ?? "").replace(/\/$/, "");
    byServer.set(url, [...(byServer.get(url) ?? []), e]);
  }
  for (const [url, served] of byServer) {
    let loaded = new Set<string>();
    try {
      const response = await fetchImpl(`${url}/models`, { signal: AbortSignal.timeout(5_000) });
      const body = (await response.json()) as { data?: { id: string }[] };
      loaded = new Set((body.data ?? []).map((m) => m.id));
    } catch {
      // Unreachable: none of its models is loaded.
    }
    for (const e of served)
      if (!loaded.has(e.model)) missing.push(`${e.id} (${e.model} at ${url})`);
  }
  return missing;
}
