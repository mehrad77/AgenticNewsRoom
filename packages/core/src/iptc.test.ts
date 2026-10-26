import { describe, expect, it } from "vitest";
import { digitalSourceType, qcodeToUri } from "./iptc.ts";

describe("IPTC terms", () => {
  it("uses the exact digital source type URIs", () => {
    expect(digitalSourceType(false).uri).toBe(
      "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    );
    expect(digitalSourceType(true).uri).toBe(
      "http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic",
    );
  });

  it("expands qcodes", () => {
    expect(qcodeToUri("medtop:20001298")).toBe("http://cv.iptc.org/newscodes/mediatopic/20001298");
    expect(qcodeToUri("genre:Opinion")).toBe("http://cv.iptc.org/newscodes/genre/Opinion");
    expect(() => qcodeToUri("nope:1")).toThrow();
  });
});
