// Audience per language on Telegram (docs/technical-design.md#measures): each active channel's
// subscriber count, one row per channel and day in its newsroom's timezone. A later run the same
// day replaces the count.
import { openCredentials, type PlatformKey, type Pool, withNewsroom } from "@anr/db";
import type { ChannelAdapter } from "./channels/types.ts";

export async function snapshotSubscribers(deps: {
  pool: Pool;
  adapters: Partial<Record<string, ChannelAdapter>>;
  platform: PlatformKey;
}): Promise<{ recorded: number; failed: number }> {
  const { rows: newsrooms } = await deps.pool.query<{ id: string; timezone: string }>(
    "select id, timezone from newsrooms where removed_at is null",
  );
  let recorded = 0;
  let failed = 0;
  for (const n of newsrooms) {
    const channels = await withNewsroom(deps.pool, n.id, async (c) => {
      const { rows } = await c.query<{
        id: string;
        kind: string;
        external_id: string | null;
        credentials: Buffer | null;
      }>(
        "select id, kind, external_id, credentials from channels where status = 'active' and kind = 'telegram'",
      );
      return rows;
    });
    for (const ch of channels) {
      const adapter = deps.adapters[ch.kind];
      if (!adapter?.subscribers) continue;
      try {
        const credentials = ch.credentials
          ? openCredentials(ch.credentials, { newsroomId: n.id, channelId: ch.id }, deps.platform)
          : {};
        const count = await adapter.subscribers({
          id: ch.id,
          kind: ch.kind,
          externalId: ch.external_id,
          credentials,
        });
        await withNewsroom(deps.pool, n.id, (c) =>
          c.query(
            `insert into channel_stats (newsroom_id, channel_id, day, subscribers)
             values (anr.current_newsroom_id(), $1, (now() at time zone $2)::date, $3)
             on conflict (channel_id, day) do update set subscribers = excluded.subscribers`,
            [ch.id, n.timezone, count],
          ),
        );
        recorded += 1;
      } catch (error) {
        // One channel's failure (a revoked bot, an outage) never stops the others' counts.
        console.error(`[publisher] subscribers of channel ${ch.id}: ${(error as Error).message}`);
        failed += 1;
      }
    }
  }
  return { recorded, failed };
}
