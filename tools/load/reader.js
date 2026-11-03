// k6 load test of the reader sites (D142): pages, publications, search, ninjs twins and podcast
// feeds at a constant rate, against the origin (Caddy), never through Cloudflare. Run it with
// run.sh, which passes the env below and sends the results to Grafana over OTLP.
//   TARGET    base URL of the origin, e.g. http://caddy
//   HOSTS     the newsroom sites' host names, comma-separated
//   FEEDS     podcast feeds as host/path, comma-separated
//   KINDS     which requests to make (default all: home,publication,search,ninjs,feed)
//   RATE      requests a second (default 20); DURATION (default 2m)
import { check, fail } from "k6";
import http from "k6/http";

const list = (value) => (value ?? "").split(",").filter(Boolean);
const TARGET = __ENV.TARGET;
const HOSTS = list(__ENV.HOSTS);
const FEEDS = list(__ENV.FEEDS);
const KINDS = list(__ENV.KINDS ?? "home,publication,search,ninjs,feed");
const QUERIES = ["ai", "art", "music", "model", "news"];
/**
 * A publication path as the publisher writes it (apps/web/src/lib/routes.ts), maybe after a
 * language, in a link with the site's origin (pageUrl). Only the path is kept: requests go to TARGET.
 */
const PUBLICATION =
  /href="(?:https?:\/\/[^/"]+)?((?:\/[a-z]{2})?\/[a-z0-9][a-z0-9-]*\/\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?)"/g;

export const options = {
  // No url or proto tags: one series per kind and site, not per publication or query.
  systemTags: [
    "status",
    "method",
    "name",
    "group",
    "check",
    "error_code",
    "expected_response",
    "scenario",
  ],
  scenarios: {
    readers: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE ?? 20),
      timeUnit: "1s",
      duration: __ENV.DURATION ?? "2m",
      preAllocatedVUs: 50,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<500"],
    // Requests k6 could not start in time: the server fell behind the rate.
    dropped_iterations: ["count==0"],
  },
};

function get(host, path, kind) {
  return http.get(`${TARGET}${path}`, {
    headers: { Host: host },
    tags: { kind, host, name: kind },
  });
}

/** Finds what to request on each site, so the test needs no fixture data. */
export function setup() {
  if (!TARGET || HOSTS.length === 0) fail("TARGET and HOSTS are required");
  const publications = [];
  for (const host of HOSTS) {
    const home = get(host, "/", "home");
    if (home.status !== 200) fail(`${host}: home answered ${home.status}`);
    for (const m of String(home.body).matchAll(PUBLICATION))
      publications.push({ host, path: m[1] });
  }
  const feeds = FEEDS.map((f) => ({
    host: f.slice(0, f.indexOf("/")),
    path: f.slice(f.indexOf("/")),
  }));
  // A kind with nothing to request would pass without testing anything.
  if ((KINDS.includes("publication") || KINDS.includes("ninjs")) && publications.length === 0)
    fail(
      "no published publications on the sites' home pages: drop publication and ninjs from KINDS",
    );
  if (KINDS.includes("feed") && feeds.length === 0) fail("no podcast feeds: drop feed from KINDS");
  return { publications, feeds };
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];

export default function ({ publications, feeds }) {
  const kind = pick(KINDS);
  let response;
  if (kind === "home") response = get(pick(HOSTS), "/", kind);
  else if (kind === "search") response = get(pick(HOSTS), `/search?q=${pick(QUERIES)}`, kind);
  else if (kind === "feed") {
    const feed = pick(feeds);
    response = get(feed.host, feed.path, kind);
  } else {
    const p = pick(publications);
    response = get(p.host, kind === "ninjs" ? `${p.path}.json` : p.path, kind);
  }
  check(response, { "status 200": (r) => r.status === 200 });
}
