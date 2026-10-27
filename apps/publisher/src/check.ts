// Asks one channel whether it can be posted to, when the Editor-in-Chief tests it or replaces its
// token in the desk (D101). Nothing is sent; the answer is stored on the channel row for the desk.
import type { ChannelCheckJob } from "@anr/core";
import { openCredentials, type PlatformKey, type Pool, withNewsroom } from "@anr/db";
import type { ChannelAdapter, ChannelCheck } from "./channels/types.ts";

export async function checkChannel(
  deps: { pool: Pool; adapters: Partial<Record<string, ChannelAdapter>>; platform: PlatformKey },
  job: ChannelCheckJob,
): Promise<ChannelCheck | null> {
  const channel = await withNewsroom(deps.pool, job.newsroomId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      kind: string;
      external_id: string | null;
      credentials: Buffer | null;
    }>("select id, kind, external_id, credentials from channels where id = $1", [job.channelId]);
    return rows[0];
  });
  if (!channel) return null;
  let result: ChannelCheck;
  const adapter = deps.adapters[channel.kind];
  if (!adapter?.check) result = { ok: true, detail: { note: "nothing to check for this kind" } };
  else {
    try {
      const credentials = channel.credentials
        ? openCredentials(
            channel.credentials,
            { newsroomId: job.newsroomId, channelId: channel.id },
            deps.platform,
          )
        : {};
      result = await adapter.check({
        id: channel.id,
        kind: channel.kind,
        externalId: channel.external_id,
        credentials,
      });
    } catch (error) {
      // Adapter errors never carry a credential (the Telegram adapter keeps its token out).
      result = { ok: false, problem: (error as Error).message };
    }
  }
  await withNewsroom(deps.pool, job.newsroomId, (c) =>
    c.query("update channels set checked_at = now(), check_result = $2 where id = $1", [
      channel.id,
      JSON.stringify(result),
    ]),
  );
  return result;
}
