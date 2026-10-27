// The editor's desk pages: a thin client of the API's desk routes. The API verifies the Cloudflare
// Access JWT and the membership on every call; this module only forwards it (D95).
import type { components } from "@anr/api/types";

type S = components["schemas"];
export type DeskMe = S["DeskMe"];
export type QueueItem = S["QueueItem"];
export type DeskPublication = S["DeskPublication"];
export type Channel = S["Channel"];
export type Sample = S["Sample"];
export type Notice = S["Notice"];

export type DeskRoute =
  | { kind: "home" }
  | { kind: "queue"; newsroom: string }
  | { kind: "publication"; newsroom: string; id: string }
  | { kind: "channels"; newsroom: string }
  | { kind: "samples"; newsroom: string }
  | { kind: "notices"; newsroom: string }
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
  m = new RegExp(`^/(${SLUG})/(channels|samples|notices)$`).exec(p);
  if (m?.[1] && m[2]) return { kind: m[2] as "channels", newsroom: m[1] };
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
      switch (action) {
        case "approve":
          await call(`${base}/publications/${id}/approve`, {});
          return `/${route.newsroom}`;
        case "return":
          await call(`${base}/publications/${id}/return`, { note: field("note") ?? "" });
          return `/${route.newsroom}`;
        case "resolve-post":
          await call(`${base}/posts/${id}/resolve`, {
            went_out: form.get("went_out") === "yes",
            ...(field("external_id") && { external_id: field("external_id") }),
          });
          return route.kind === "publication"
            ? `/${route.newsroom}/p/${route.id}`
            : `/${route.newsroom}`;
        case "add-channel":
          await call(`${base}/channels`, {
            kind: field("kind"),
            language: field("language"),
            ...(field("external_id") && { external_id: field("external_id") }),
            ...(field("bot_token") && { credentials: { bot_token: field("bot_token") } }),
          });
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
        case "read-notice":
          await call(`${base}/notices/${id}/read`, {});
          return `/${route.newsroom}/notices`;
        default:
          throw new DeskApiError(400, "unknown action");
      }
    },
  };
}
