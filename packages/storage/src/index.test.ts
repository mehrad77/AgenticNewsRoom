// The S3 store and presigned links against an in-process stand-in for R2's path-style API: the
// SDK's real requests, no network. Signatures are R2's to check, so the stand-in ignores them.

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  localStore,
  objectStore,
  PRESIGNED_SECONDS,
  presignedUrl,
  r2Client,
  s3Store,
} from "./index.ts";

const objects = new Map<string, { body: Buffer; type: string }>();
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://s3").pathname;
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        objects.set(path, {
          body: Buffer.concat(chunks),
          type: String(req.headers["content-type"]),
        });
        res.writeHead(200, { etag: '"x"' }).end();
      });
      return;
    }
    const object = objects.get(path);
    if (!object) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end("<Error><Code>NoSuchKey</Code><Message>no such key</Message></Error>");
      return;
    }
    res.writeHead(200, { "content-type": object.type, "content-length": object.body.length });
    res.end(object.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const env = () => ({
  ANR_S3_ENDPOINT: endpoint,
  R2_ACCESS_KEY_ID: "test",
  R2_SECRET_ACCESS_KEY: "test",
});

describe("s3Store", () => {
  it("puts and gets an object in its bucket, path-style, with its content type", async () => {
    const store = s3Store(r2Client(env()), "anr-media");
    await store.put("a/episode.mp3", Buffer.from("ID3 audio"), "audio/mpeg");
    expect(objects.get("/anr-media/a/episode.mp3")?.type).toBe("audio/mpeg");
    expect((await store.get("a/episode.mp3"))?.toString()).toBe("ID3 audio");
  });

  it("answers null for a missing object", async () => {
    expect(await s3Store(r2Client(env()), "anr-media").get("m/missing.jpg")).toBeNull();
  });

  it("refuses a key that could leave its prefix", async () => {
    await expect(s3Store(r2Client(env()), "b").get("../etc/passwd")).rejects.toThrow("bad object");
  });
});

describe("presignedUrl", () => {
  it("links one object for an hour, readable without credentials", async () => {
    const store = s3Store(r2Client(env()), "anr-media");
    await store.put("m/0b1c.jpg", Buffer.from("jpeg bytes"), "image/jpeg");
    const url = new URL(await presignedUrl(r2Client(env()), "anr-media", "m/0b1c.jpg"));
    expect(url.pathname).toBe("/anr-media/m/0b1c.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGNED_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const res = await fetch(url);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await res.text()).toBe("jpeg bytes");
  });
});

describe("objectStore", () => {
  it("is the local directory where no bucket is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anr-store-"));
    const store = objectStore(undefined, dir, env());
    await store.put("raw/ab/cd", Buffer.from("page"), "text/html");
    expect((await localStore(dir).get("raw/ab/cd"))?.toString()).toBe("page");
  });
});
