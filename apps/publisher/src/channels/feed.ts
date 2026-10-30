// The podcast RSS channel (D110): the feed is the newsroom's own, served by the site from the Post
// rows of this channel, so sending an episode is storing its rendered <item>. Nothing leaves the
// platform, so a send never fails and a check always can answer.
import type { ChannelAdapter } from "./types.ts";

export const feedPath = (seriesSlug: string) => `/podcast/${seriesSlug}.xml`;

export function podcastFeed(): ChannelAdapter {
  return {
    internal: true,
    async send(_target, text) {
      // The item's guid identifies it in the feed; the Post row keeps the text.
      return /<guid[^>]*>([^<]+)<\/guid>/.exec(text)?.[1] ?? "item";
    },
    async check() {
      return { ok: true, detail: { served_by: "the newsroom's site" } };
    },
  };
}
