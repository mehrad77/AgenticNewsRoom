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

export const SOURCE_KINDS = ["rss", "api", "site"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const MEMBERSHIP_ROLES = ["editor-in-chief", "editor"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Who acted, in the audit log: a person at the desk, an agent role, or code. */
export const ACTOR_KINDS = ["person", "agent", "code"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const CHANNEL_STATUSES = ["active", "disabled"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const EDITORIAL_CYCLE_STATUSES = ["proposed", "approved", "declined"] as const;
export type EditorialCycleStatus = (typeof EDITORIAL_CYCLE_STATUSES)[number];

/** The four layers of the verifier gate (docs/technical-design.md#verifier-gate). */
export const CHECK_KINDS = ["code", "fact-check", "item-match", "policy"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** Anything but `pass` holds the publication for an editor. */
export const CHECK_RESULTS = ["pass", "fail", "partial", "error", "timed-out"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

/**
 * A post row is written before the send; `unknown` results are held, never resent. `failed`: the
 * channel refused it, so nothing went out (D89).
 */
export const POST_STATUSES = ["pending", "sent", "unknown", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const CHALLENGE_OUTCOMES = ["upheld", "rejected"] as const;
export type ChallengeOutcome = (typeof CHALLENGE_OUTCOMES)[number];

/** `paused`: a writing run that did not start because the newsroom's budget is spent (D76). */
export const AGENT_RUN_OUTCOMES = ["submitted", "invalid", "error", "timed-out", "paused"] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

/** Messages from code to a newsroom's Editor-in-Chief, shown in the editor's desk. */
export const NOTICE_KINDS = ["budget-warning", "budget-cap", "no-leads", "no-channel"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** An editor's verdict on a sampled auto-published publication (D94). */
export const SAMPLE_OUTCOMES = ["ok", "miss"] as const;
export type SampleOutcome = (typeof SAMPLE_OUTCOMES)[number];
