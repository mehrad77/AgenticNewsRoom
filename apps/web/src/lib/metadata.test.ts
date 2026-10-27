import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { jsonLd, ninjs, scriptJson } from "./metadata.ts";
import type { ReaderNewsroom, ReaderPublication } from "./reader.ts";

const schemaFile = fileURLToPath(
  new URL("../../../../packages/schemas/iptc/ninjs-schema_3.2.json", import.meta.url),
);
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
// ninjs refers to GeoJSON for place geometry, fetched from the web; ANR never emits geometry, so a
// permissive stand-in keeps the test offline without loosening anything ANR writes.
ajv.addSchema({ $id: "https://geojson.org/schema/GeoJSON.json" });
const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, "utf8")));

const site = { subdomain: "ai", rootDomain: "example.org", languages: ["fa", "en"] as const };
const newsroom: ReaderNewsroom = {
  id: "n1",
  slug: "ai",
  subdomain: "ai",
  name: { fa: "اتاق خبر هوش مصنوعی", en: "AI Newsroom" },
  languages: ["fa", "en"],
  timezone: "Europe/Istanbul",
  editorInChief: "Mehrad Rousta",
  correctionsOwner: "Mehrad Rousta",
};
const publication: ReaderPublication = {
  id: "p1",
  title: "Today in AI",
  path: "/daily-newsletter/2026-10-27",
  publishedAt: new Date("2026-10-27T18:00:00Z"),
  language: "en",
  status: "published",
  edited: false,
  series: "daily-newsletter",
  seriesName: { en: "Daily Newsletter" },
  format: "newsletter-issue",
  genres: ["genre:Summary"],
  ninjsType: "text",
  mediaTopics: ["medtop:20000763"],
  rendition: { title: "Today in AI", items: [] },
  leads: {},
  corrections: [],
};
const described = {
  site: { ...site, languages: [...site.languages] },
  newsroom,
  publication,
  bodyHtml: "<article>AI-made</article>",
};

describe("ninjs twin", () => {
  it("is valid ninjs 3.2 with IPTC subjects, genre, source type and trust indicators", () => {
    const doc = ninjs(described);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc).toMatchObject({
      uri: "https://ai.example.org/en/daily-newsletter/2026-10-27",
      type: "text",
      pubStatus: "usable",
      version: "1",
      language: "en",
      subjects: [{ uri: "http://cv.iptc.org/newscodes/mediatopic/20000763" }],
      genres: [{ uri: "http://cv.iptc.org/newscodes/genre/Summary" }],
      digitalSourceType: {
        uri: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      },
    });
    const roles = (doc.trustIndicators as { role: string }[]).map((t) => t.role.split("/").at(-1));
    expect(roles).toEqual(["editorialPolicy", "correctionsPolicy", "factCheckingPolicy"]);
  });

  it("is checked by a validator that refuses bad ninjs", () => {
    const doc = ninjs(described);
    expect(validate({ ...doc, pubStatus: "live" })).toBe(false);
    expect(validate({ ...doc, subjects: [{ uri: "not a uri" }] })).toBe(false);
    expect(validate({ ...doc, bogus: 1 })).toBe(false);
  });

  it("publishes a new version per correction and links each one", () => {
    const corrected = {
      ...described,
      publication: {
        ...publication,
        status: "corrected" as const,
        edited: true,
        corrections: [
          { id: "k1", notice: "Fixed a date.", publishedAt: new Date("2026-10-28T09:00:00Z") },
        ],
      },
    };
    const doc = ninjs(corrected);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc).toMatchObject({
      version: "2",
      versionCreated: "2026-10-28T09:00:00.000Z",
      digitalSourceType: {
        uri: "http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic",
      },
    });
    expect(doc.trustIndicators).toContainEqual(
      expect.objectContaining({
        role: "http://cv.iptc.org/newscodes/trustindicator/correctedByResource",
        href: "https://ai.example.org/en/corrections#k1",
      }),
    );
  });
});

describe("JSON-LD", () => {
  it("describes a NewsArticle with IPTC topics, genre and source type", () => {
    const ld = jsonLd(described);
    expect(ld).toMatchObject({
      "@type": "NewsArticle",
      inLanguage: "en",
      about: [{ "@id": "http://cv.iptc.org/newscodes/mediatopic/20000763" }],
      genre: ["http://cv.iptc.org/newscodes/genre/Summary"],
      digitalSourceType: "https://schema.org/TrainedAlgorithmicMediaDigitalSource",
      editor: { "@type": "Person", name: "Mehrad Rousta" },
      publisher: {
        "@type": "NewsMediaOrganization",
        name: "AI Newsroom",
        publishingPrinciples: "https://ai.example.org/en/ai-policy",
        correctionsPolicy: "https://ai.example.org/en/corrections",
        verificationFactCheckingPolicy: "https://ai.example.org/en/ai-policy#fact-checking",
      },
    });
    expect(ld).not.toHaveProperty("correction");
  });

  it("marks an edited piece composite and lists its corrections", () => {
    const ld = jsonLd({
      ...described,
      publication: {
        ...publication,
        edited: true,
        corrections: [
          { id: "k1", notice: "Fixed.", publishedAt: new Date("2026-10-28T09:00:00Z") },
        ],
      },
    });
    expect(ld.digitalSourceType).toBe("https://schema.org/CompositeSyntheticDigitalSource");
    expect(ld.correction).toEqual([
      expect.objectContaining({ "@type": "CorrectionComment", text: "Fixed." }),
    ]);
  });
});

describe("scriptJson", () => {
  it("cannot end the script element it sits in", () => {
    const out = scriptJson({ headline: "</script><script>alert(1)</script> & \u2028" });
    expect(out).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(out)).toEqual({ headline: "</script><script>alert(1)</script> & \u2028" });
  });
});
