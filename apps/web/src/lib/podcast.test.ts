import { describe, expect, it } from "vitest";
import { byteRange, readerAddress } from "./podcast.ts";

describe("readerAddress", () => {
  it("takes Cloudflare's CF-Connecting-IP, else the connection's address", () => {
    expect(readerAddress("203.0.113.7", "172.18.0.2")).toBe("203.0.113.7");
    expect(readerAddress(null, "203.0.113.7")).toBe("203.0.113.7");
    expect(readerAddress("", "203.0.113.7")).toBe("203.0.113.7");
  });

  it("never reads X-Forwarded-For, which a reader can forge", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.66",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(readerAddress(headers.get("cf-connecting-ip"), "172.18.0.2")).toBe("203.0.113.7");
    const forgedOnly = new Headers({ "x-forwarded-for": "198.51.100.66" });
    expect(readerAddress(forgedOnly.get("cf-connecting-ip"), "172.18.0.2")).toBe("172.18.0.2");
  });
});

describe("byteRange", () => {
  it("reads one range, open or suffix, within the file", () => {
    expect(byteRange("bytes=0-1", 100)).toEqual([0, 1]);
    expect(byteRange("bytes=90-", 100)).toEqual([90, 99]);
    expect(byteRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(byteRange("bytes=50-500", 100)).toEqual([50, 99]);
  });

  it("refuses what it cannot serve", () => {
    expect(byteRange("bytes=100-", 100)).toBeNull();
    expect(byteRange("bytes=5-1", 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(byteRange("bytes=-", 100)).toBeNull();
  });
});
