// What the publisher needs from a channel: send one message, and say for sure whether it went out.

/**
 * Why a send did not succeed, by what it says about delivery (D89):
 * - `retry`: refused before sending (rate limit, unreachable); try again later.
 * - `rejected`: refused for good until a person fixes something (bad chat, bad credentials).
 * - `unknown`: the request may have reached the channel; never re-sent, held for a person.
 */
export type SendFailure = "retry" | "rejected" | "unknown";

export class SendError extends Error {
  readonly failure: SendFailure;
  /** Seconds the channel asked us to wait, for `retry`. */
  readonly retryAfter: number | undefined;
  constructor(failure: SendFailure, message: string, retryAfter?: number) {
    super(message);
    this.name = "SendError";
    this.failure = failure;
    this.retryAfter = retryAfter;
  }
}

/** One channel row, its credentials opened. */
export interface ChannelTarget {
  id: string;
  kind: string;
  externalId: string | null;
  credentials: Record<string, string>;
}

/** What a channel said when asked whether it can be posted to; nothing is sent (D101). */
export interface ChannelCheck {
  ok: boolean;
  /** Why it cannot be posted to, for the editor. */
  problem?: string;
  /** What the channel reported, such as the chat's title and the bot's role in it. */
  detail?: Record<string, string | boolean | null>;
}

export interface ChannelAdapter {
  /**
   * The platform's own channel (the podcast feed): a send never leaves ANR. Any other adapter
   * reaches the outside world, and sends only where ANR_PUBLISH is `live` (D126).
   */
  internal?: boolean;
  /** Sends one message; returns the channel's id for it. Throws SendError, nothing else. */
  send(target: ChannelTarget, text: string): Promise<string>;
  /** Current subscriber count, for the daily audience snapshot. */
  subscribers?(target: ChannelTarget): Promise<number>;
  /** Whether the channel can be posted to now. Throws SendError when it cannot be asked. */
  check?(target: ChannelTarget): Promise<ChannelCheck>;
}
