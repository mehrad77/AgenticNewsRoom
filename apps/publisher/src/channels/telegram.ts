// Telegram through the Bot API (https://core.telegram.org/bots/api). The bot token is a secret and
// part of every URL, so no URL, request or response object ever reaches an error or a log.
import { type ChannelAdapter, type ChannelCheck, type ChannelTarget, SendError } from "./types.ts";

const API = "https://api.telegram.org";
/** A send that takes longer may still land: its result is unknown. */
const TIMEOUT_MS = 30_000;
/** Errors raised before any byte reached Telegram: the message cannot have gone out. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

interface Reply {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

type Fetch = typeof fetch;

function botToken(target: ChannelTarget): string {
  const token = target.credentials.bot_token;
  if (!token) throw new SendError("rejected", "the channel has no bot_token");
  return token;
}

function chatId(target: ChannelTarget): string {
  if (!target.externalId) throw new SendError("rejected", "the channel has no chat id");
  return target.externalId;
}

const causeCode = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
};

async function call(fetchFn: Fetch, target: ChannelTarget, method: string, body: object) {
  let response: Response;
  try {
    response = await fetchFn(`${API}/bot${botToken(target)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SendError) throw error;
    const code = causeCode(error);
    if (code && NOT_SENT.has(code)) throw new SendError("retry", `Telegram unreachable (${code})`);
    // A timeout or a reset after the request left: it may have been delivered.
    const name = (error as Error).name;
    throw new SendError("unknown", `Telegram ${method}: no answer (${code ?? name})`);
  }
  if (response.status >= 500)
    throw new SendError("unknown", `Telegram ${method}: HTTP ${response.status}`);
  const reply = (await response.json().catch(() => null)) as Reply | null;
  if (!reply) throw new SendError("unknown", `Telegram ${method}: unreadable answer`);
  if (reply.ok) return reply.result;
  const what = `Telegram ${method}: ${reply.error_code ?? response.status} ${reply.description ?? ""}`;
  if (reply.error_code === 429)
    throw new SendError("retry", what.trim(), reply.parameters?.retry_after);
  throw new SendError("rejected", what.trim());
}

export function telegramChannel(fetchFn: Fetch = fetch): ChannelAdapter {
  return {
    async send(target, text) {
      const result = (await call(fetchFn, target, "sendMessage", {
        chat_id: chatId(target),
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })) as { message_id?: unknown };
      // Sent, but without an id we cannot prove it later: still a success, recorded as such.
      return String(result?.message_id ?? "");
    },
    async subscribers(target) {
      const count = await call(fetchFn, target, "getChatMemberCount", { chat_id: chatId(target) });
      if (typeof count !== "number") throw new SendError("unknown", "unexpected member count");
      return count;
    },
    async check(target) {
      const me = (await call(fetchFn, target, "getMe", {})) as { id?: number; username?: string };
      const chat = (await call(fetchFn, target, "getChat", { chat_id: chatId(target) })) as {
        type?: string;
        title?: string;
        username?: string;
      };
      const member = (await call(fetchFn, target, "getChatMember", {
        chat_id: chatId(target),
        user_id: me.id,
      })) as { status?: string; can_post_messages?: boolean };
      return verdict(me, chat, member);
    },
  };
}

/** Whether the bot may post in the chat: in a channel only as an admin with the right to post. */
function verdict(
  me: { username?: string },
  chat: { type?: string; title?: string; username?: string },
  member: { status?: string; can_post_messages?: boolean },
): ChannelCheck {
  const detail = {
    bot: me.username ?? null,
    chat_title: chat.title ?? chat.username ?? null,
    chat_type: chat.type ?? null,
    bot_status: member.status ?? null,
  };
  const status = member.status ?? "";
  const ok =
    chat.type === "channel"
      ? status === "creator" || (status === "administrator" && member.can_post_messages === true)
      : ["creator", "administrator", "member"].includes(status);
  if (ok) return { ok, detail };
  const problem =
    chat.type === "channel" && status === "administrator"
      ? "the bot is an admin of the channel but may not post messages"
      : chat.type === "channel"
        ? "the bot is not an admin of the channel"
        : "the bot is not a member of the chat";
  return { ok, problem, detail };
}
