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
export type Plan = S["Plan"];
export type AdminTts = S["AdminTts"];
export type OpsState = S["OpsState"];
export type NewsroomTts = S["NewsroomTts"];
export type Challenge = S["Challenge"];
export type ChallengeDetail = S["ChallengeDetail"];
export type MediaItem = S["MediaItem"];

/** Pages that list or show one newsroom's things, under `/<newsroom>/<page>`. */
const PAGES = [
  "plan",
  "challenges",
  "media",
  "voices",
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
  /** The platform admin's page, above every newsroom. */
  | { kind: "admin" }
  /** The platform admin's operations controls (D144). */
  | { kind: "ops" }
  | { kind: "queue"; newsroom: string }
  | { kind: "publication"; newsroom: string; id: string }
  | { kind: "challenge"; newsroom: string; id: string }
  | { kind: Page; newsroom: string }
  | { kind: "not-found" };

const SLUG = "[a-z][a-z0-9-]*";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function deskRoute(path: string): DeskRoute {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "") return { kind: "home" };
  if (p === "/admin") return { kind: "admin" };
  if (p === "/ops") return { kind: "ops" };
  let m = new RegExp(`^/(${SLUG})$`).exec(p);
  if (m?.[1]) return { kind: "queue", newsroom: m[1] };
  m = new RegExp(`^/(${SLUG})/p/(${UUID})$`).exec(p);
  if (m?.[1] && m[2]) return { kind: "publication", newsroom: m[1], id: m[2] };
  m = new RegExp(`^/(${SLUG})/c/(${UUID})$`).exec(p);
  if (m?.[1] && m[2]) return { kind: "challenge", newsroom: m[1], id: m[2] };
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
    plan: (newsroom: string) => call<Plan>(`${n(newsroom)}/plan`),
    challenges: (newsroom: string) => call<Challenge[]>(`${n(newsroom)}/challenges`),
    challenge: (newsroom: string, id: string) =>
      call<ChallengeDetail>(`${n(newsroom)}/challenges/${id}`),
    media: (newsroom: string) => call<MediaItem[]>(`${n(newsroom)}/media`),
    adminTts: () => call<AdminTts>("/desk/admin/tts"),
    ops: () => call<OpsState>("/desk/admin/ops"),
    newsroomTts: (newsroom: string) => call<NewsroomTts>(`${n(newsroom)}/tts`),
    /** Runs the action a desk form posted; returns where to go next. */
    async act(route: DeskRoute, form: FormData): Promise<string> {
      if (route.kind === "admin") {
        // Every checked engine; an unchecked box sends nothing.
        const engines = form.getAll("engine").filter((v): v is string => typeof v === "string");
        await call("/desk/admin/tts", { engines });
        return "/admin";
      }
      if (route.kind === "ops") {
        const value = (name: string) => {
          const v = form.get(name);
          return typeof v === "string" && v ? v : undefined;
        };
        // No newsroom means every newsroom.
        const scope = { newsroom: value("newsroom") };
        const job = { queue: value("queue"), id: value("id") };
        const paths: Record<string, [string, unknown]> = {
          pause: ["/desk/admin/ops/pause", scope],
          resume: ["/desk/admin/ops/resume", scope],
          drain: ["/desk/admin/ops/drain", { queue: value("queue"), drained: true }],
          undrain: ["/desk/admin/ops/drain", { queue: value("queue"), drained: false }],
          retry: ["/desk/admin/ops/jobs/retry", job],
          cancel: ["/desk/admin/ops/jobs/cancel", job],
          "backup-check": ["/desk/admin/ops/backup-check", {}],
        };
        const target = paths[String(form.get("action") ?? "")];
        if (!target) throw new DeskApiError(400, "unknown action");
        await call(...target);
        return "/ops";
      }
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
        route.kind === "publication"
          ? `/${route.newsroom}/p/${route.id}`
          : route.kind === "challenge"
            ? `/${route.newsroom}/c/${route.id}`
            : `/${route.newsroom}`;
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
        case "approve-theme":
          await call(`${base}/cycles/${id}/approve`, {
            theme: field("theme") ?? "",
            angle: field("angle") ?? "",
            calendar: calendarFields(form),
          });
          return `/${route.newsroom}/plan`;
        case "choose-pick":
          await call(`${base}/picks/${id}/choose`, { candidate: Number(field("candidate")) });
          return `/${route.newsroom}/plan`;
        case "newsroom-tts":
          await call(`${base}/tts`, {
            language: field("language") ?? "",
            engine: field("engine") ?? null,
          });
          return `/${route.newsroom}/voices`;
        case "acknowledge-challenge":
          await call(`${base}/challenges/${id}/acknowledge`, { note: field("note") });
          return here;
        case "reject-challenge":
          await call(`${base}/challenges/${id}/reject`, { answer: field("answer") ?? "" });
          return here;
        case "uphold-challenge":
          await call(`${base}/challenges/${id}/uphold`, {
            answer: field("answer") ?? "",
            claim: field("claim") ?? "",
            lesson: field("lesson") ?? "",
            notices: noticeFields(form),
          });
          return here;
        case "file-challenge-issue":
          await call(`${base}/challenges/${id}/issue`, { url: field("url") ?? "" });
          return here;
        case "add-media":
          await call(`${base}/media`, {
            url: field("url") ?? "",
            source_url: field("source_url"),
            lead_id: field("lead_id"),
          });
          return `/${route.newsroom}/media`;
        case "record-licence":
          await call(`${base}/media/${id}/licence`, {
            licence: field("licence") ?? "",
            terms_url: field("terms_url") ?? "",
            credit: field("credit"),
          });
          return `/${route.newsroom}/media`;
        case "read-notice":
          await call(`${base}/notices/${id}/read`, {});
          return `/${route.newsroom}/notices`;
        default:
          throw new DeskApiError(400, "unknown action");
      }
    },
  };
}

/** A theme form's calendar: `week.<i>` and `focus.<i>` pairs, in the order of `i`. */
export function calendarFields(form: FormData): { week: string; focus: string }[] {
  const weeks: { i: number; week: string; focus: string }[] = [];
  form.forEach((value, name) => {
    const m = /^week\.([0-9]+)$/.exec(name);
    if (!m || typeof value !== "string") return;
    const focus = form.get(`focus.${m[1]}`);
    weeks.push({
      i: Number(m[1]),
      week: value,
      focus: typeof focus === "string" ? focus.replace(/\r\n/g, "\n").trim() : "",
    });
  });
  return weeks.sort((a, b) => a.i - b.i).map(({ week, focus }) => ({ week, focus }));
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

/** An uphold form's correction notices: `notice:<language>` fields, the empty ones left out. */
export function noticeFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  form.forEach((value, name) => {
    if (name.startsWith("notice:") && typeof value === "string" && value.trim())
      out[name.slice("notice:".length)] = value.trim();
  });
  return out;
}

/**
 * A prefilled issue for an upheld challenge's lesson (D116), as for sample misses (D102). The
 * repository is public: the issue carries the editor's lesson and where the piece is, never the
 * reader's text.
 */
export function challengeIssueLink(base: string, newsroom: string, c: ChallengeDetail): string {
  const body = [
    "A reader's challenge was upheld and the piece corrected.",
    "",
    `- Newsroom: \`${newsroom}\``,
    `- Publication: \`${c.publication}\` (${c.language})`,
    `- Challenge: \`${c.id}\``,
    "",
    "What the gate should have caught:",
    "",
    `> ${(c.lesson ?? "").replace(/\n/g, "\n> ")}`,
    "",
    "Make it a check (code) or a policy rule (config), and link the change here.",
  ].join("\n");
  const url = new URL(base);
  url.searchParams.set("title", `Correction (${newsroom}): ${c.title ?? c.publication}`);
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
