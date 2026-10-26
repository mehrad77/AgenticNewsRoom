/**
 * The charter's vocabulary (docs/charter.md#vocabulary). Each word means one thing,
 * in code, in the data model and in conversation.
 */

export const AGENT_ROLES = [
  "planner",
  "desk",
  "renderer",
  "fact-checker",
  "item-matcher",
  "summariser",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const BEAT_STATUSES = ["open", "restricted", "banned"] as const;
export type BeatStatus = (typeof BEAT_STATUSES)[number];

export const CLAIM_KINDS = ["fact", "quote", "opinion"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CHANNEL_KINDS = ["site", "telegram", "podcast-rss"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const SOURCE_TIERS = [1, 2, 3] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/** Publication lifecycle (docs/technical-design.md#publication-lifecycle). */
export const PUBLICATION_STATUSES = [
  "assigned",
  "drafted",
  "with-editor",
  "scheduled",
  "published",
  "corrected",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
