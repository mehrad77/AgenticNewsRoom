// The editor's desk pages: a thin client of the API's desk routes. The API verifies the Cloudflare
// Access JWT and the membership on every call; this module only forwards it (D95).
import type { components } from "@anr/api/types";
import { type TextField, textFields } from "@anr/core";

type S = components["schemas"];
export type DeskMe = S["DeskMe"];
export type QueueItem = S["QueueItem"];
export type DeskPublication = S["DeskPublication"];
export type Channel = S["Channel"];
export type Sample = S["Sample"];
export type Notice = S["Notice"];
export type Preview = S["Preview"];
export type ScheduleItem = S["ScheduleItem"];
export type Budget = S["Budget"];
export type SourceHealth = S["SourceHealth"];
export type Measures = S["Measures"];

/** Pages that list or show one newsroom's things, under `/<newsroom>/<page>`. */
const PAGES = [
  "channels",
  "samples",
  "notices",
  "schedule",
  "budget",
  "sources",
  "measures",
] as const;
type Page = (typeof PAGES)[number];

export type DeskRoute =
  | { kind: "home" }
  | { kind: "queue"; newsroom: string }
  | { kind: "publication"; newsroom: string; id: string }
  | { kind: Page; newsroom: string }
  | { kind: "not-found" };

const SLUG = "[a-z][a-z0-9-]*";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function deskRoute(path: string): DeskRoute {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "") return { kind: "home" };
  let m = new RegExp(`^/(${SLUG})$`).exec(p);
  if (m?.[1]) return { kind: "queue", newsroom: m[1] };
  m = new RegExp(`^/(${SLUG})/p/(${UUID})$`).exec(p);
  if (m?.[1] && m[2]) return { kind: "publication", newsroom: m[1], id: m[2] };
  m = new RegExp(`^/(${SLUG})/(${PAGES.join("|")})$`).exec(p);
  if (m?.[1] && m[2]) return { kind: m[2] as Page, newsroom: m[1] };
  return { kind: "not-found" };
}

export class DeskApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function deskApi(base: string, token: string | null, fetchFn: typeof fetch = fetch) {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "cf-access-jwt-assertion": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
      throw new DeskApiError(503, "The desk's API is not reachable.");
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new DeskApiError(res.status, json.error ?? `HTTP ${res.status}`);
    return json as T;
  };
  const n = (newsroom: string) => `/desk/newsrooms/${encodeURIComponent(newsroom)}`;
  return {
    me: () => call<DeskMe>("/desk/me"),
    queue: (newsroom: string) => call<QueueItem[]>(`${n(newsroom)}/queue`),
    publication: (newsroom: string, id: string) =>
      call<DeskPublication>(`${n(newsroom)}/publications/${id}`),
    channels: (newsroom: string) => call<Channel[]>(`${n(newsroom)}/channels`),
    samples: (newsroom: string) => call<Sample[]>(`${n(newsroom)}/samples`),
    notices: (newsroom: string) => call<Notice[]>(`${n(newsroom)}/notices`),
    preview: (newsroom: string, id: string) =>
      call<Preview>(`${n(newsroom)}/publications/${id}/preview`),
    schedule: (newsroom: string) => call<ScheduleItem[]>(`${n(newsroom)}/schedule`),
    budget: (newsroom: string) => call<Budget>(`${n(newsroom)}/budget`),
    sources: (newsroom: string) => call<SourceHealth[]>(`${n(newsroom)}/sources`),
    measures: (newsroom: string) => call<Measures>(`${n(newsroom)}/measures`),
    /** Runs the action a desk form posted; returns where to go next. */
    async act(route: DeskRoute, form: FormData): Promise<string> {
      if (route.kind === "home" || route.kind === "not-found")
        throw new DeskApiError(404, "nothing to do here");
      const action = String(form.get("action") ?? "");
      const id = String(form.get("id") ?? "");
      const base = n(route.newsroom);
      const field = (name: string) => {
        const v = form.get(name);
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      };
      const here =
        route.kind === "publication" ? `/${route.newsroom}/p/${route.id}` : `/${route.newsroom}`;
      switch (action) {
        case "approve":
          await call(`${base}/publications/${id}/approve`, { version: field("version") ?? "" });
          return `/${route.newsroom}`;
        case "return":
          await call(`${base}/publications/${id}/return`, { note: field("note") ?? "" });
          return `/${route.newsroom}`;
        case "resolve-post":
          await call(`${base}/posts/${id}/resolve`, {
            went_out: form.get("went_out") === "yes",
            ...(field("external_id") && { external_id: field("external_id") }),
          });
          return here;
        case "edit": {
          // The form posts every field; only changed ones are sent, so a long script stays
          // within the API's limit on changes.
          const current = await call<DeskPublication>(`${base}/publications/${id}`);
          const changes = changedFields(current.rendition, editedFields(form));
          if (changes.length > 0)
            await call(`${base}/publications/${id}/edit`, {
              version: field("version") ?? "",
              changes,
            });
          return here;
        }
        case "pull-back":
          await call(`${base}/publications/${id}/pull-back`, { note: field("note") ?? "" });
          return `/${route.newsroom}/schedule`;
        case "add-channel":
          await call(`${base}/channels`, {
            kind: field("kind"),
            language: field("language"),
            ...(field("external_id") && { external_id: field("external_id") }),
            ...(field("bot_token") && { credentials: { bot_token: field("bot_token") } }),
          });
          return `/${route.newsroom}/channels`;
        case "replace-token":
          await call(`${base}/channels/${id}/credentials`, {
            credentials: { bot_token: field("bot_token") ?? "" },
          });
          return `/${route.newsroom}/channels`;
        case "check-channel":
          await call(`${base}/channels/${id}/check`, {});
          return `/${route.newsroom}/channels`;
        case "channel-status":
          await call(`${base}/channels/${id}/status`, { status: field("status") });
          return `/${route.newsroom}/channels`;
        case "review-sample":
          await call(`${base}/samples/${id}/review`, {
            outcome: field("outcome"),
            note: field("note"),
          });
          return `/${route.newsroom}/samples`;
        case "file-issue":
          await call(`${base}/samples/${id}/issue`, { url: field("url") ?? "" });
          return `/${route.newsroom}/samples`;
        case "read-notice":
          await call(`${base}/notices/${id}/read`, {});
          return `/${route.newsroom}/notices`;
        default:
          throw new DeskApiError(400, "unknown action");
      }
    },
  };
}

/** The edit form's field for a text field of the rendition: `text:<JSON pointer>`. */
export const EDIT_PREFIX = "text:";

/** The rendition's text fields as the edit form shows them, labelled by where they are. */
export function editForm(rendition: unknown) {
  return textFields(rendition).map((f) => ({
    ...f,
    name: `${EDIT_PREFIX}${f.pointer}`,
    label: f.pointer.slice(1).replaceAll("/", " › "),
    long: f.text.length > 80 || f.text.includes("\n"),
  }));
}

/** Every text field the edit form posted; browsers send textarea line breaks as CRLF. */
export function editedFields(form: FormData) {
  const out: TextField[] = [];
  form.forEach((value, name) => {
    if (name.startsWith(EDIT_PREFIX) && typeof value === "string")
      out.push({ pointer: name.slice(EDIT_PREFIX.length), text: value.replace(/\r\n/g, "\n") });
  });
  return out;
}

/** The posted fields whose text differs from the rendition's. */
export function changedFields(rendition: unknown, posted: TextField[]): TextField[] {
  const before = new Map(textFields(rendition).map((f) => [f.pointer, f.text]));
  return posted.filter((f) => before.get(f.pointer) !== f.text);
}

/**
 * A new-issue link for a sample miss in the platform's tracker (D102). The repository is public,
 * so the issue carries only the editor's note and where the publication is.
 */
export function issueLink(base: string, newsroom: string, sample: Sample): string {
  const title = `Sample miss (${newsroom}): ${sample.title ?? sample.publication}`;
  const body = [
    `A publication the gate let through was a miss in the review sample.`,
    "",
    `- Newsroom: \`${newsroom}\``,
    `- Publication: \`${sample.publication}\` (${sample.language})`,
    "",
    "What the gate should have caught:",
    "",
    `> ${(sample.note ?? "").replace(/\n/g, "\n> ")}`,
    "",
    "Make it a check (code) or a policy rule (config), and link the change here.",
  ].join("\n");
  const url = new URL(base);
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}

/** A link only for http(s) addresses: stored URLs come from feeds and editors (no `javascript:`). */
export const safeHref = (url: string | null | undefined) =>
  url && /^https?:\/\//i.test(url) ? url : undefined;

/** A timestamp as the desk shows it, always in UTC. */
export const when = (iso: string | null | undefined) =>
  iso ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC` : "";

/** A check's or post's detail, compact. */
export const detail = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v));

export const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : Math.abs(n) >= 0.1 || n === 0
      ? `$${n.toFixed(2)}`
      : `$${Number(n.toPrecision(2))}`;

export const percent = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${Math.round(n * 100)}%`;
