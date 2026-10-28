import { describe, expect, it } from "vitest";
import { byteRange, listenerAddress } from "./podcast.ts";

describe("listenerAddress", () => {
  it("takes the address the proxy wrote last, else the connection's", () => {
    expect(listenerAddress("198.51.100.1, 203.0.113.7", "172.18.0.2")).toBe("203.0.113.7");
    expect(listenerAddress(null, "203.0.113.7")).toBe("203.0.113.7");
    expect(listenerAddress("", "203.0.113.7")).toBe("203.0.113.7");
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
