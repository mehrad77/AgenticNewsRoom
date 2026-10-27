import { describe, expect, it } from "vitest";
import { telegramChannel } from "./telegram.ts";
import type { SendError } from "./types.ts";

const target = {
  id: "ch1",
  kind: "telegram",
  externalId: "@anr_test",
  credentials: { bot_token: "123:SECRET" },
};

const answer = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

const failure = async (fetchFn: typeof fetch) => {
  try {
    await telegramChannel(fetchFn).send(target, "hi");
  } catch (error) {
    return error as SendError;
  }
  throw new Error("expected a SendError");
};

describe("Telegram channel", () => {
  it("sends HTML without link previews and returns the message id", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    }) as unknown as typeof fetch;
    expect(await telegramChannel(fetchFn).send(target, "<b>x</b>")).toBe("42");
    expect(seen?.url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(seen?.body).toMatchObject({
      chat_id: "@anr_test",
      parse_mode: "HTML",
      text: "<b>x</b>",
    });
  });

  it("retries a rate limit with Telegram's wait", async () => {
    const e = await failure(
      answer(429, {
        ok: false,
        error_code: 429,
        description: "Too Many",
        parameters: { retry_after: 7 },
      }),
    );
    expect(e).toMatchObject({ failure: "retry", retryAfter: 7 });
  });

  it("rejects what Telegram refuses for good", async () => {
    const e = await failure(
      answer(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    );
    expect(e.failure).toBe("rejected");
  });

  it("calls a 5xx, a timeout or a reset unknown: it may have been delivered", async () => {
    expect((await failure(answer(502, {}))).failure).toBe("unknown");
    const timeout = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    expect((await failure(timeout)).failure).toBe("unknown");
    const reset = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    expect((await failure(reset)).failure).toBe("unknown");
  });

  it("retries when the request never left", async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as typeof fetch;
    expect((await failure(refused)).failure).toBe("retry");
  });

  it("never puts the bot token in an error", async () => {
    for (const f of [
      answer(400, { ok: false, error_code: 400, description: "x" }),
      answer(502, {}),
      (async () => {
        throw new TypeError("fetch failed for https://api.telegram.org/bot123:SECRET/sendMessage");
      }) as typeof fetch,
    ]) {
      const e = await failure(f);
      expect(`${e.message} ${e.stack}`).not.toContain("SECRET");
    }
  });

  it("reads the subscriber count", async () => {
    expect(
      await telegramChannel(answer(200, { ok: true, result: 1234 })).subscribers?.(target),
    ).toBe(1234);
  });
});
