import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openCredentials, platformKey, rewrapCredentials, sealCredentials } from "./credentials.ts";

const key = () => platformKey(randomBytes(32).toString("base64"));
const owner = { newsroomId: "n1", channelId: "c1" };
const token = { bot_token: "123456:secret" };

describe("channel credentials", () => {
  it("round-trips and never stores the plaintext", () => {
    const k = key();
    const sealed = sealCredentials(token, owner, k);
    expect(sealed.includes(Buffer.from("secret"))).toBe(false);
    expect(openCredentials(sealed, owner, k)).toEqual(token);
  });

  it("uses a fresh nonce and data key every time", () => {
    const k = key();
    expect(sealCredentials(token, owner, k).equals(sealCredentials(token, owner, k))).toBe(false);
  });

  it("refuses a credential moved to another channel or newsroom", () => {
    const k = key();
    const sealed = sealCredentials(token, owner, k);
    expect(() => openCredentials(sealed, { ...owner, channelId: "c2" }, k)).toThrow();
    expect(() => openCredentials(sealed, { ...owner, newsroomId: "n2" }, k)).toThrow();
  });

  it("refuses a tampered credential", () => {
    const k = key();
    const sealed = sealCredentials(token, owner, k);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 1;
    expect(() => openCredentials(sealed, owner, k)).toThrow();
  });

  it("names the wrong platform key instead of failing obscurely", () => {
    const sealed = sealCredentials(token, owner, key());
    expect(() => openCredentials(sealed, owner, key())).toThrow("another platform key");
  });

  it("rotates the platform key by re-wrapping the data key only", () => {
    const [oldKey, newKey] = [key(), key()];
    const sealed = sealCredentials(token, owner, oldKey);
    const rotated = rewrapCredentials(sealed, owner, oldKey, newKey);
    expect(openCredentials(rotated, owner, newKey)).toEqual(token);
    // The encrypted credential itself is byte-for-byte unchanged.
    expect(rotated.subarray(65).equals(sealed.subarray(65))).toBe(true);
  });

  it("rejects a platform key of the wrong size", () => {
    expect(() => platformKey(randomBytes(16).toString("base64"))).toThrow("32 bytes");
    expect(() => platformKey("")).toThrow("not set");
  });
});
