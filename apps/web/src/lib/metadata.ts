// Machine-readable descriptions of a publication (docs/technical-design.md#iptc-standards): the
// schema.org JSON-LD in its page and its ninjs 3.2 twin at the page URL plus `.json`. Both take the
// digital source type from the one stored `edited` flag, as the visible label does.
import { digitalSourceType, pageUrl, qcodeToUri, type SiteAddress, siteOrigin } from "@anr/core";
import { FACT_CHECKING_ANCHOR } from "./i18n.ts";
import type { ReaderNewsroom, ReaderPublication } from "./reader.ts";

const TRUST = "http://cv.iptc.org/newscodes/trustindicator/";
const NINJS_SCHEMA = "http://www.iptc.org/std/ninjs/ninjs-schema_3.2.json#";

export interface Described {
  site: SiteAddress;
  newsroom: ReaderNewsroom;
  publication: ReaderPublication;
  /** The site template's output: the piece as HTML, disclosure label included. */
  bodyHtml: string;
}

/** The policy pages every description links to, in the publication's language. */
export function policyUrls(site: SiteAddress, language: ReaderPublication["language"]) {
  const aiPolicy = pageUrl(site, language, "/ai-policy");
  return {
    aiPolicy,
    corrections: pageUrl(site, language, "/corrections"),
    factChecking: `${aiPolicy}#${FACT_CHECKING_ANCHOR}`,
    home: pageUrl(site, language, "/"),
  };
}

const newsroomName = (d: Described) =>
  d.newsroom.name[d.publication.language] ??
  d.newsroom.name[d.newsroom.languages[0] ?? "en"] ??
  d.newsroom.slug;

/** ninjs `version`: 1, plus one per published correction. */
const version = (p: ReaderPublication) => String(1 + p.corrections.length);

const lastChange = (p: ReaderPublication) => p.corrections.at(-1)?.publishedAt ?? p.publishedAt;

export function jsonLd(d: Described): Record<string, unknown> {
  const p = d.publication;
  const url = pageUrl(d.site, p.language, p.path);
  const links = policyUrls(d.site, p.language);
  const publisher = {
    "@type": "NewsMediaOrganization",
    "@id": `${links.home}#publisher`,
    name: newsroomName(d),
    url: links.home,
    publishingPrinciples: links.aiPolicy,
    correctionsPolicy: links.corrections,
    verificationFactCheckingPolicy: links.factChecking,
  };
  return {
    "@context": "https://schema.org",
    "@type": p.ninjsType === "audio" ? "PodcastEpisode" : "NewsArticle",
    "@id": url,
    url,
    mainEntityOfPage: url,
    headline: p.title ?? undefined,
    inLanguage: p.language,
    datePublished: p.publishedAt.toISOString(),
    dateModified: lastChange(p).toISOString(),
    about: p.mediaTopics.map((q) => ({ "@id": qcodeToUri(q) })),
    genre: p.genres.map(qcodeToUri),
    digitalSourceType: digitalSourceType(p.edited).schemaOrg,
    author: { "@id": publisher["@id"] },
    publisher,
    editor: { "@type": "Person", name: d.newsroom.editorInChief },
    ...(p.corrections.length > 0 && {
      correction: p.corrections.map((c) => ({
        "@type": "CorrectionComment",
        text: c.notice,
        datePublished: c.publishedAt.toISOString(),
        url: `${links.corrections}#${c.id}`,
      })),
    }),
  };
}

export function ninjs(d: Described): Record<string, unknown> {
  const p = d.publication;
  const links = policyUrls(d.site, p.language);
  const trust = (code: string, href: string, title: string) => ({
    role: TRUST + code,
    href,
    title,
  });
  return {
    uri: pageUrl(d.site, p.language, p.path),
    standard: { name: "ninjs", version: "3.2", schema: NINJS_SCHEMA },
    type: p.ninjsType,
    representationType: "full",
    version: version(p),
    firstCreated: p.publishedAt.toISOString(),
    versionCreated: lastChange(p).toISOString(),
    pubStatus: "usable",
    language: p.language,
    by: newsroomName(d),
    ...(p.title && { headlines: [{ role: "main", value: p.title }] }),
    bodies: [{ role: "main", contentType: "text/html", value: d.bodyHtml }],
    subjects: p.mediaTopics.map((q) => ({ uri: qcodeToUri(q), rel: "about" })),
    genres: p.genres.map((q) => ({ uri: qcodeToUri(q) })),
    digitalSourceType: { uri: digitalSourceType(p.edited).uri },
    // Each image keeps its own recorded source type, never the publication's (D45).
    ...(Object.keys(p.media).length > 0 && {
      associations: Object.entries(p.media).map(([id, m]) => ({
        name: id,
        rel: "image",
        uri: `${siteOrigin(d.site)}${m.url}`,
        type: "picture",
        ...(m.alt && { descriptions: [{ role: "alt", value: m.alt }] }),
        ...(m.digital_source_type && { digitalSourceType: { uri: m.digital_source_type } }),
        copyrightNotice: m.credit,
        usageTerms: `${m.licence} (${m.licence_url})`,
      })),
    }),
    trustIndicators: [
      trust("editorialPolicy", links.aiPolicy, "AI policy"),
      trust("correctionsPolicy", links.corrections, "Corrections"),
      trust("factCheckingPolicy", links.factChecking, "How claims are checked"),
      ...p.corrections.map((c) =>
        trust("correctedByResource", `${links.corrections}#${c.id}`, "Correction"),
      ),
    ],
  };
}

/**
 * JSON for an inline <script type="application/ld+json">: `<`, `>`, `&` and the line separators
 * escaped, so text such as "</script>" in a title cannot end the element.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
