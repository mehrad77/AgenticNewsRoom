import type { z } from "zod";
import {
  ArtistStoryDraftSchema,
  ClassicArticleDraftSchema,
  NewsletterIssueDraftSchema,
  PodcastEpisodeDraftSchema,
} from "./generated/index.ts";

/** A format's draft schema, by format slug (config/formats/<slug>/schema.json). */
export const DRAFT_SCHEMAS: Record<string, z.ZodType> = {
  "artist-story": ArtistStoryDraftSchema,
  "classic-article": ClassicArticleDraftSchema,
  "newsletter-issue": NewsletterIssueDraftSchema,
  "podcast-episode": PodcastEpisodeDraftSchema,
};
