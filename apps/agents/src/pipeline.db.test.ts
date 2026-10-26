// End to end across both languages: the ingest-source handler (this worker) calls the real
// ingestion service (Python, spawned here in replay mode over its recorded fixtures), which
// stores leads in anr_test as anr_app. No network.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestNewsroom, loadRootEnv, testDatabaseUrl, testPools } from "@anr/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleIngestSource, ingestionClient } from "./ingest.ts";

const ingestionDir = fileURLToPath(new URL("../../../services/ingestion", import.meta.url));
const pools = testPools();
let service: ChildProcess | undefined;
let baseUrl = "";
const rawDir = mkdtempSync(join(tmpdir(), "anr-raw-"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`ingestion did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  loadRootEnv();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error("DATABASE_URL is not set");
  service = spawn(
    "uv",
    [
      "run",
      "--frozen",
      "uvicorn",
      "anr_ingestion.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      `${port}`,
    ],
    {
      cwd: ingestionDir,
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(appUrl),
        ANR_INGESTION_REPLAY: join(ingestionDir, "tests/fixtures"),
        ANR_RAW_DIR: rawDir,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  await waitForHealth(baseUrl, 30_000);
}, 40_000);

afterAll(async () => {
  service?.kill();
  await pools.end();
  rmSync(rawDir, { recursive: true, force: true });
});

async function addSource(
  newsroomId: string,
  slug: string,
  kind: string,
  url: string,
  tier: number,
) {
  const { rows } = await pools.system.query<{ id: string }>(
    `insert into sources (newsroom_id, slug, kind, url, tier, fetch_every, terms_checked)
     values ($1, $2, $3, $4, $5, '1 hour', '2026-10-01') returning id`,
    [newsroomId, slug, kind, url, tier],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("source insert returned no row");
  return id;
}

describe("ingest-source, end to end", () => {
  it("fills the lead pool from every kind of source, with no duplicates across sources", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "e2e");
    const sources = [
      await addSource(newsroomId, "lab", "rss", "https://openai.com/news/rss.xml", 1),
      await addSource(newsroomId, "digest", "rss", "https://huggingface.co/blog/feed.xml", 3),
      await addSource(
        newsroomId,
        "arxiv",
        "api",
        "https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate",
        2,
      ),
      await addSource(
        newsroomId,
        "hn",
        "api",
        "https://hacker-news.firebaseio.com/v0/topstories.json",
        3,
      ),
      await addSource(newsroomId, "site", "site", "https://www.anthropic.com/news", 1),
    ];
    const ingestion = ingestionClient(baseUrl);
    const handed: string[] = [];
    const deps = {
      ingestion,
      onNewLeads: async (_n: string, ids: string[]) => {
        handed.push(...ids);
      },
      log: () => {},
    };
    // Two rounds, like two scheduled runs: the second adds nothing.
    for (const sourceId of [...sources, ...sources]) {
      await handleIngestSource({ newsroomId, sourceId }, deps);
    }

    const { rows: leads } = await pools.system.query<{
      uri: string;
      tier: number;
      content_hash: string;
    }>("select uri, tier, content_hash from leads where newsroom_id = $1 order by uri", [
      newsroomId,
    ]);
    expect(leads.map((l) => l.uri)).toEqual([
      "https://arxiv.org/abs/2610.01234",
      "https://arxiv.org/abs/2610.03333",
      "https://news.ycombinator.com/item?id=41000001",
      "https://news.ycombinator.com/item?id=41000002",
      "https://openai.com/index/introducing-orbit/",
      "https://openai.com/index/orbit-safety/",
      "https://www.anthropic.com/news/claude-orbit-comparison",
    ]);
    expect(new Set(leads.map((l) => l.content_hash)).size).toBe(leads.length);
    expect(handed).toHaveLength(leads.length); // every new lead goes on to the summariser, once

    const { rows: copies } = await pools.system.query<{ uri: string; match: string }>(
      `select uri, match from lead_sightings
       where newsroom_id = $1 and match <> 'original' order by uri`,
      [newsroomId],
    );
    expect(copies).toContainEqual({
      uri: "https://huggingface.co/blog/orbit-repost",
      match: "near-duplicate",
    });
    expect(copies).toContainEqual({
      uri: "https://openai.com/index/orbit-safety/",
      match: "same-uri",
    });
  }, 60_000);

  it("refuses a source without terms_checked, without retrying", async () => {
    const newsroomId = await createTestNewsroom(pools.system, "e2e");
    const { rows } = await pools.system.query<{ id: string }>(
      `insert into sources (newsroom_id, slug, kind, url, tier, fetch_every)
       values ($1, 'unchecked', 'rss', 'https://openai.com/news/rss.xml', 1, '1 hour') returning id`,
      [newsroomId],
    );
    const outcome = await ingestionClient(baseUrl).ingest({
      newsroomId,
      sourceId: rows[0]?.id ?? "",
    });
    expect(outcome.kind).toBe("refused");
  });
});
