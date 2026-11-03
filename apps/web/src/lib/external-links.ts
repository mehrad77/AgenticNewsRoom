// Links out of the site in HTML the site did not build itself (a piece's body from its Liquid
// template): marked like ShabUI's ExternalLink, opening in a new tab with the external icon and a
// spoken note, so every link that leaves the newsroom looks and behaves the same.
import { PATHS } from "@shabboo/kit/icons";

const ICON = `<svg class="icon external-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${PATHS.external}"/></svg>`;

const LINK = /<a\b([^>]*?)\bhref="(https?:\/\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/g;

/** Whether a URL leaves the newsroom's own site. */
export function isExternal(href: string, ownHost: string): boolean {
  try {
    return new URL(href).hostname !== ownHost;
  } catch {
    return false;
  }
}

export function markExternalLinks(html: string, ownHost: string, newTabLabel: string): string {
  return html.replace(LINK, (whole, before: string, href: string, after: string, text: string) => {
    if (!isExternal(href.replace(/&amp;/g, "&"), ownHost) || /external-link/.test(before + after))
      return whole;
    const kept = ` ${before} ${after}`
      .replace(/\s(target|rel)="[^"]*"/g, "")
      .replace(/\sclass="([^"]*)"/, ' class="$1 external-link"')
      .replace(/\s+/g, " ")
      .trim();
    const attrs = /(^|\s)class="/.test(kept) ? kept : `class="external-link" ${kept}`.trim();
    return `<a ${attrs} href="${href}" target="_blank" rel="noopener noreferrer"><bdi>${text}</bdi>${ICON}<span class="visually-hidden"> ${newTabLabel}</span></a>`;
  });
}
