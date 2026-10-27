import type { MembershipRole } from "@anr/core";
import { type Client, type PlatformKey, type Pool, withNewsroom } from "@anr/db";
import { type Context, Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { ACCESS_HEADER, type VerifyAccess } from "./desk/access.ts";
import { addChannel, listChannels, setChannelStatus } from "./desk/channels.ts";
import { DeskError } from "./desk/errors.ts";
import { listNotices, listSamples, readNotice, reviewSample } from "./desk/followups.ts";
import { type DeskPerson, deskPerson } from "./desk/people.ts";
import { approve, deskPublication, resolvePost, returnToDesk, reviewQueue } from "./desk/review.ts";
import type { components } from "./generated/api.ts";

type Health = components["schemas"]["Health"];

export interface DeskDeps {
  pool: Pool;
  boss: Pick<PgBoss, "send">;
  platform: PlatformKey;
  verify: VerifyAccess;
}

type Env = { Variables: { person: DeskPerson } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function body(c: Context): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeskError(400, "the body must be a JSON object");
  return value as Record<string, unknown>;
}

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

function id(c: Context, name: string): string {
  const value = c.req.param(name) ?? "";
  if (!UUID.test(value)) throw new DeskError(404, `no such ${name}`);
  return value;
}

export function createApp(deps?: DeskDeps) {
  const app = new Hono<Env>();

  app.get("/healthz", (c) => c.json<Health>({ status: "ok", service: "api" }));

  app.onError((error, c) => {
    if (error instanceof DeskError) return c.json({ error: error.message }, error.status);
    console.error(`[api] ${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  if (!deps) return app;
  const { pool, boss, platform, verify } = deps;

  // Every desk request: a verified Access JWT whose email is a user (D95).
  app.use("/desk/*", async (c, next) => {
    const email = await verify(c.req.header(ACCESS_HEADER));
    const person = email ? await deskPerson(pool, email) : null;
    if (!person) return c.json({ error: "sign in through Cloudflare Access" }, 401);
    c.set("person", person);
    await next();
  });

  /** Runs `fn` in the path's newsroom, for a member with one of `roles`. */
  const inNewsroom = <T>(
    c: Context<Env>,
    fn: (client: Client, actor: { kind: "person"; userId: string }) => Promise<T>,
    roles: MembershipRole[] = ["editor-in-chief", "editor"],
  ): Promise<T> => {
    const person = c.get("person");
    const membership = person.memberships.find((m) => m.newsroom === c.req.param("newsroom"));
    if (!membership) throw new DeskError(403, "you have no membership in this newsroom");
    if (!roles.includes(membership.role))
      throw new DeskError(403, `only the ${roles.join(" or ")} can do this`);
    return withNewsroom(pool, membership.newsroomId, (client) =>
      fn(client, { kind: "person", userId: person.userId }),
    );
  };

  app.get("/desk/me", (c) => {
    const p = c.get("person");
    return c.json({
      email: p.email,
      memberships: p.memberships.map((m) => ({ newsroom: m.newsroom, name: m.name, role: m.role })),
    });
  });

  const base = "/desk/newsrooms/:newsroom";
  app.get(`${base}/queue`, async (c) => c.json(await inNewsroom(c, (db) => reviewQueue(db))));
  app.get(`${base}/publications/:publication`, async (c) =>
    c.json(await inNewsroom(c, (db) => deskPublication(db, id(c, "publication")))),
  );
  app.post(`${base}/publications/:publication/approve`, async (c) =>
    c.json(await inNewsroom(c, (db, actor) => approve(db, actor, id(c, "publication")))),
  );
  app.post(`${base}/publications/:publication/return`, async (c) => {
    const note = text((await body(c)).note, 2000)?.trim();
    if (!note) throw new DeskError(400, "say what the desk should change");
    return c.json(
      await inNewsroom(c, (db, actor) => returnToDesk(db, boss, actor, id(c, "publication"), note)),
    );
  });
  app.post(`${base}/posts/:post/resolve`, async (c) => {
    const b = await body(c);
    if (typeof b.went_out !== "boolean") throw new DeskError(400, "went_out must be true or false");
    const external = b.external_id === undefined ? undefined : text(b.external_id, 200);
    if (b.external_id !== undefined && external === undefined)
      throw new DeskError(400, "external_id must be a short string");
    const wentOut = b.went_out;
    return c.json(
      await inNewsroom(c, (db, actor) => resolvePost(db, actor, id(c, "post"), wentOut, external)),
    );
  });

  const chief: MembershipRole[] = ["editor-in-chief"];
  app.get(`${base}/channels`, async (c) => c.json(await inNewsroom(c, (db) => listChannels(db))));
  app.post(`${base}/channels`, async (c) => {
    const b = await body(c);
    const credentials = b.credentials;
    if (
      credentials !== undefined &&
      (typeof credentials !== "object" ||
        credentials === null ||
        Array.isArray(credentials) ||
        !Object.values(credentials).every((v) => text(v, 500) !== undefined))
    )
      throw new DeskError(400, "credentials must be an object of short strings");
    const input = {
      kind: String(b.kind ?? ""),
      language: String(b.language ?? ""),
      external_id: text(b.external_id, 200),
      credentials: credentials as Record<string, string> | undefined,
    };
    return c.json(
      await inNewsroom(c, (db, actor) => addChannel(db, actor, platform, input), chief),
      201,
    );
  });
  app.post(`${base}/channels/:channel/status`, async (c) => {
    const status = String((await body(c)).status ?? "");
    return c.json(
      await inNewsroom(
        c,
        (db, actor) => setChannelStatus(db, actor, id(c, "channel"), status),
        chief,
      ),
    );
  });

  app.get(`${base}/samples`, async (c) => c.json(await inNewsroom(c, (db) => listSamples(db))));
  app.post(`${base}/samples/:sample/review`, async (c) => {
    const b = await body(c);
    const outcome = String(b.outcome ?? "");
    const note = b.note === undefined ? undefined : text(b.note, 2000);
    return c.json(
      await inNewsroom(c, (db, actor) => reviewSample(db, actor, id(c, "sample"), outcome, note)),
    );
  });
  app.get(`${base}/notices`, async (c) => c.json(await inNewsroom(c, (db) => listNotices(db))));
  app.post(`${base}/notices/:notice/read`, async (c) =>
    c.json(await inNewsroom(c, (db) => readNotice(db, id(c, "notice")))),
  );

  return app;
}

/** The API without desk routes (no database); the server builds the full app. */
export const app = createApp();
