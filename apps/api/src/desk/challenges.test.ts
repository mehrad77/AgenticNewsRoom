import { describe, expect, it } from "vitest";
import { readerAddress, readerNetwork } from "./challenges.ts";

describe("a reader's network (D114)", () => {
  it("keeps an IPv4 address, also when a dual-stack socket maps it into IPv6", () => {
    expect(readerNetwork("203.0.113.5")).toBe("203.0.113.5");
    expect(readerNetwork("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(readerNetwork("::FFFF:198.51.100.7")).toBe("198.51.100.7");
    expect(readerNetwork("0:0:0:0:0:ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(readerNetwork("::ffff:203.0.113.5")).not.toBe(readerNetwork("::ffff:203.0.113.6"));
  });

  it("is the /64 of an IPv6 address, however it is written", () => {
    expect(readerNetwork("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(readerNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(readerNetwork("2001:0DB8:0001:0002::9")).toBe("2001:db8:1:2::/64");
    expect(readerNetwork("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("falls back to the connection's address, and only then to one shared key", () => {
    expect(readerAddress("10.0.0.1, 203.0.113.5", "10.0.0.2")).toBe("203.0.113.5");
    expect(readerAddress(undefined, "::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
    expect(readerAddress(undefined)).toBe("unknown");
  });
});
