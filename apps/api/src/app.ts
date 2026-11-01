import type { MembershipRole } from "@anr/core";
import { type Client, type PlatformKey, type Pool, withNewsroom } from "@anr/db";
import { createRenderer } from "@anr/render";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { ACCESS_HEADER, type VerifyAccess } from "./desk/access.ts";
import { budget } from "./desk/budget.ts";
import {
  acknowledgeChallenge,
  fileChallengeIssue,
  getChallenge,
  listChallenges,
  readerAddress,
  rejectChallenge,
  submitChallenge,
  upholdChallenge,
} from "./desk/challenges.ts";
import {
  addChannel,
  listChannels,
  replaceCredentials,
  requestCheck,
  setChannelStatus,
} from "./desk/channels.ts";
import { DeskError } from "./desk/errors.ts";
import { fileIssue, listNotices, listSamples, readNotice, reviewSample } from "./desk/followups.ts";
import { measures } from "./desk/measures.ts";
import { addMedia, isHttpUrl, listMedia, recordPressKit } from "./desk/media.ts";
import {
  cancelJob,
  opsState,
  pause,
  requestBackupCheck,
  resume,
  retryJob,
  setDrain,
} from "./desk/ops.ts";
import { type DeskPerson, deskPerson } from "./desk/people.ts";
import { approveTheme, choosePick, plan } from "./desk/plan.ts";
import { type PreviewSite, previewPublication } from "./desk/preview.ts";
import {
  approve,
  deskPublication,
  editPublication,
  pullBack,
  resolvePost,
  returnToDesk,
  reviewQueue,
  schedule,
} from "./desk/review.ts";
import { sourceHealth } from "./desk/sources.ts";
import { adminTts, newsroomTts, setAdminTts, setNewsroomTts, type TtsCatalog } from "./desk/tts.ts";
import type { components } from "./generated/api.ts";

type Health = components["schemas"]["Health"];

export interface DeskDeps {
  pool: Pool;
  /** Sends jobs; retries and cancels them for the Ops page (D144). */
  boss: Pick<PgBoss, "send" | "retry" | "cancel">;
  platform: PlatformKey;
  verify: VerifyAccess;
  /** Where the newsroom sites are, for the preview's links (as the publisher has them). */
  site: PreviewSite;
  renderer?: ReturnType<typeof createRenderer>;
  /** The models file's text-to-speech engines (D113). */
  tts?: TtsCatalog;
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

/** An object of short strings, such as channel credentials. */
function secrets(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  return Object.values(v).every((x) => text(x, 500) !== undefined)
    ? (v as Record<string, string>)
    : undefined;
}

/** Correction notices by language: an object of texts of at most 2,000 characters. */
function noticeTexts(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  return Object.values(v).every((x) => text(x, 2000) !== undefined)
    ? (v as Record<string, string>)
    : undefined;
}

/** The connection's own address on Node's server; none for in-process requests (tests). */
function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** A whole-number query parameter within bounds, or its default. */
function count(c: Context, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new DeskError(400, `${name} is a whole number from 1 to ${max}`);
  return n;
}

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
  const { pool, boss, platform, verify, site } = deps;
  const renderer = deps.renderer ?? createRenderer();

  // A reader's challenge, posted by the newsroom's site for its form (D114). Public: no sign-in.
  app.post("/reader/newsrooms/:newsroom/publications/:publication/challenges", async (c) => {
    const newsroom = c.req.param("newsroom");
    if (!/^[a-z][a-z0-9-]*$/.test(newsroom)) throw new DeskError(404, "no such newsroom");
    const b = await body(c);
    const said = text(b.text, 4000)?.trim();
    if (!said || said.length < 20) throw new DeskError(400, "text: 20 to 4,000 characters");
    const source = b.source_url === undefined ? undefined : text(b.source_url, 500)?.trim();
    if (source !== undefined && !/^https?:\/\/\S+$/.test(source))
      throw new DeskError(400, "source_url: an http or https address");
    const receipt = await submitChallenge(pool, boss, {
      newsroom,
      publicationId: id(c, "publication"),
      text: said,
      sourceUrl: source || undefined,
      address: readerAddress(c.req.header("cf-connecting-ip"), connectionAddress(c)),
    });
    return c.json(receipt, 201);
  });

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
      platform_admin: p.platformAdmin,
      memberships: p.memberships.map((m) => ({ newsroom: m.newsroom, name: m.name, role: m.role })),
    });
  });

  const base = "/desk/newsrooms/:newsroom";
  app.get(`${base}/queue`, async (c) => c.json(await inNewsroom(c, (db) => reviewQueue(db))));
  app.get(`${base}/publications/:publication`, async (c) =>
    c.json(await inNewsroom(c, (db, actor) => deskPublication(db, actor, id(c, "publication")))),
  );
  app.get(`${base}/publications/:publication/preview`, async (c) =>
    c.json(
      await inNewsroom(c, (db) => previewPublication(db, renderer, site, id(c, "publication"))),
    ),
  );
  app.post(`${base}/publications/:publication/edit`, async (c) => {
    const b = await body(c);
    const changes = b.changes;
    const version = text(b.version, 100);
    if (!version) throw new DeskError(400, "version: the one the page showed");
    if (
      !Array.isArray(changes) ||
      changes.length === 0 ||
      changes.length > 200 ||
      !changes.every(
        (x) =>
          typeof x === "object" &&
          x !== null &&
          text((x as Record<string, unknown>).pointer, 500) !== undefined &&
          text((x as Record<string, unknown>).text, 20000) !== undefined,
      )
    )
      throw new DeskError(400, "changes is a list of {pointer, text}");
    const list = changes as { pointer: string; text: string }[];
    return c.json(
      await inNewsroom(c, (db, actor) =>
        editPublication(db, actor, id(c, "publication"), version, list),
      ),
    );
  });
  app.post(`${base}/publications/:publication/pull-back`, async (c) => {
    const note = text((await body(c)).note, 2000)?.trim();
    if (!note) throw new DeskError(400, "say why it is pulled back");
    return c.json(
      await inNewsroom(c, (db, actor) => pullBack(db, actor, id(c, "publication"), note)),
    );
  });
  app.get(`${base}/schedule`, async (c) => {
    const days = count(c, "days", 7, 31);
    return c.json(await inNewsroom(c, (db) => schedule(db, days)));
  });
  app.post(`${base}/publications/:publication/approve`, async (c) => {
    const version = text((await body(c)).version, 100);
    if (!version) throw new DeskError(400, "version: the one the page showed");
    return c.json(
      await inNewsroom(c, (db, actor) => approve(db, actor, id(c, "publication"), version)),
    );
  });
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
    const credentials = secrets(b.credentials);
    if (b.credentials !== undefined && !credentials)
      throw new DeskError(400, "credentials must be an object of short strings");
    const input = {
      kind: String(b.kind ?? ""),
      language: String(b.language ?? ""),
      external_id: text(b.external_id, 200),
      credentials,
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

  app.post(`${base}/channels/:channel/credentials`, async (c) => {
    const credentials = secrets((await body(c)).credentials);
    if (!credentials) throw new DeskError(400, "credentials must be an object of short strings");
    return c.json(
      await inNewsroom(
        c,
        (db, actor) => replaceCredentials(db, actor, platform, boss, id(c, "channel"), credentials),
        chief,
      ),
    );
  });
  app.post(`${base}/channels/:channel/check`, async (c) =>
    c.json(await inNewsroom(c, (db) => requestCheck(db, boss, id(c, "channel")), chief)),
  );

  app.get(`${base}/samples`, async (c) => c.json(await inNewsroom(c, (db) => listSamples(db))));
  app.post(`${base}/samples/:sample/review`, async (c) => {
    const b = await body(c);
    const outcome = String(b.outcome ?? "");
    const note = b.note === undefined ? undefined : text(b.note, 2000);
    return c.json(
      await inNewsroom(c, (db, actor) => reviewSample(db, actor, id(c, "sample"), outcome, note)),
    );
  });
  app.post(`${base}/samples/:sample/issue`, async (c) => {
    const url = text((await body(c)).url, 500)?.trim() ?? "";
    return c.json(await inNewsroom(c, (db, actor) => fileIssue(db, actor, id(c, "sample"), url)));
  });
  app.get(`${base}/budget`, async (c) => c.json(await inNewsroom(c, (db) => budget(db))));
  app.get(`${base}/sources`, async (c) => c.json(await inNewsroom(c, (db) => sourceHealth(db))));
  app.get(`${base}/measures`, async (c) => {
    const weeks = count(c, "weeks", 8, 26);
    return c.json(await inNewsroom(c, (db) => measures(db, weeks)));
  });
  app.get(`${base}/notices`, async (c) => c.json(await inNewsroom(c, (db) => listNotices(db))));
  app.post(`${base}/notices/:notice/read`, async (c) =>
    c.json(await inNewsroom(c, (db) => readNotice(db, id(c, "notice")))),
  );

  // Text-to-speech engines: the platform admin enables, each newsroom chooses (D113).
  const tts = deps.tts ?? { default: "", engines: [] };
  const admin = (c: Context<Env>) => {
    const person = c.get("person");
    if (!person.platformAdmin) throw new DeskError(403, "only the platform admin can do this");
    return { kind: "person" as const, userId: person.userId };
  };
  app.get("/desk/admin/tts", async (c) => {
    admin(c);
    return c.json(await adminTts(pool, tts));
  });
  app.post("/desk/admin/tts", async (c) => {
    const actor = admin(c);
    return c.json(await setAdminTts(pool, actor, tts, (await body(c)).engines));
  });
  // Ops controls, for the platform admin only (D144); every action is in platform_audit_log.
  app.get("/desk/admin/ops", async (c) => {
    admin(c);
    return c.json(await opsState(pool));
  });
  const newsroomOrAll = (b: Record<string, unknown>) => {
    if (b.newsroom === undefined || b.newsroom === null) return undefined;
    if (typeof b.newsroom !== "string") throw new DeskError(400, "newsroom: a slug, or none");
    return b.newsroom;
  };
  app.post("/desk/admin/ops/pause", async (c) => {
    await pause(pool, admin(c), newsroomOrAll(await body(c)));
    return c.json({ ok: true });
  });
  app.post("/desk/admin/ops/resume", async (c) => {
    return c.json(await resume(pool, admin(c), newsroomOrAll(await body(c))));
  });
  app.post("/desk/admin/ops/drain", async (c) => {
    const b = await body(c);
    await setDrain(pool, admin(c), b.queue, b.drained);
    return c.json({ ok: true });
  });
  app.post("/desk/admin/ops/jobs/retry", async (c) => {
    const b = await body(c);
    await retryJob(pool, boss, admin(c), b.queue, b.id);
    return c.json({ ok: true });
  });
  app.post("/desk/admin/ops/jobs/cancel", async (c) => {
    const b = await body(c);
    await cancelJob(pool, boss, admin(c), b.queue, b.id);
    return c.json({ ok: true });
  });
  app.post("/desk/admin/ops/backup-check", async (c) =>
    c.json(await requestBackupCheck(pool, admin(c))),
  );
  app.get(`${base}/tts`, async (c) => c.json(await inNewsroom(c, (db) => newsroomTts(db, tts))));
  app.post(`${base}/tts`, async (c) => {
    const b = await body(c);
    const language = text(b.language, 5) ?? "";
    const engine = b.engine === null ? null : text(b.engine, 100);
    if (engine === undefined) throw new DeskError(400, "engine: an engine id, or null to clear");
    return c.json(
      await inNewsroom(c, (db, actor) => setNewsroomTts(db, actor, tts, language, engine), chief),
    );
  });

  // Readers' challenges and corrections (D114–D116): any member of the newsroom handles them.
  app.get(`${base}/challenges`, async (c) =>
    c.json(await inNewsroom(c, (db) => listChallenges(db))),
  );
  app.get(`${base}/challenges/:challenge`, async (c) =>
    c.json(await inNewsroom(c, (db) => getChallenge(db, id(c, "challenge")))),
  );
  app.post(`${base}/challenges/:challenge/acknowledge`, async (c) => {
    const note = (await body(c)).note;
    if (note !== undefined && text(note, 2000) === undefined)
      throw new DeskError(400, "note: at most 2,000 characters");
    return c.json(
      await inNewsroom(c, (db, actor) =>
        acknowledgeChallenge(db, actor, id(c, "challenge"), note as string | undefined),
      ),
    );
  });
  app.post(`${base}/challenges/:challenge/reject`, async (c) => {
    const answer = text((await body(c)).answer, 4000)?.trim();
    if (!answer) throw new DeskError(400, "answer: why the piece stands");
    return c.json(
      await inNewsroom(c, (db, actor) => rejectChallenge(db, actor, id(c, "challenge"), answer)),
    );
  });
  app.post(`${base}/challenges/:challenge/uphold`, async (c) => {
    const b = await body(c);
    const answer = text(b.answer, 4000)?.trim();
    const lesson = text(b.lesson, 2000)?.trim();
    const claim = typeof b.claim === "string" && /^c[0-9]+$/.test(b.claim) ? b.claim : undefined;
    const notices = noticeTexts(b.notices);
    if (!answer || !lesson || !claim || !notices)
      throw new DeskError(
        400,
        "answer, the wrong claim, the lesson and a notice per language (at most 2,000 characters)",
      );
    return c.json(
      await inNewsroom(c, (db, actor) =>
        upholdChallenge(db, boss, actor, id(c, "challenge"), { answer, claim, lesson, notices }),
      ),
    );
  });
  app.post(`${base}/challenges/:challenge/issue`, async (c) => {
    const url = text((await body(c)).url, 500) ?? "";
    return c.json(
      await inNewsroom(c, (db, actor) => fileChallengeIssue(db, actor, id(c, "challenge"), url)),
    );
  });

  // Media items (D16, D119): any member adds images and records a press kit's licence.
  app.get(`${base}/media`, async (c) => c.json(await inNewsroom(c, (db) => listMedia(db))));
  app.post(`${base}/media`, async (c) => {
    const b = await body(c);
    const url = text(b.url, 2048)?.trim() ?? "";
    const sourceUrl = text(b.source_url, 2048)?.trim() || undefined;
    const leadId = typeof b.lead_id === "string" && UUID.test(b.lead_id) ? b.lead_id : undefined;
    return c.json(
      await inNewsroom(c, (db, actor) => addMedia(db, boss, actor, { url, sourceUrl, leadId })),
      202,
    );
  });
  app.post(`${base}/media/:media/licence`, async (c) => {
    const b = await body(c);
    const licence = text(b.licence, 200)?.trim();
    const termsUrl = text(b.terms_url, 2048)?.trim() ?? "";
    const credit = text(b.credit, 200)?.trim() || undefined;
    if (!licence || !isHttpUrl(termsUrl))
      throw new DeskError(
        400,
        "licence: the press kit's terms, and terms_url: the page stating them",
      );
    return c.json(
      await inNewsroom(c, (db, actor) =>
        recordPressKit(db, actor, id(c, "media"), { licence, termsUrl, credit }),
      ),
    );
  });

  // Planning: the Editor-in-Chief sets the agenda (charter: human-directed, D105).
  app.get(`${base}/plan`, async (c) => c.json(await inNewsroom(c, (db) => plan(db))));
  app.post(`${base}/cycles/:cycle/approve`, async (c) => {
    const b = await body(c);
    const theme = text(b.theme, 140)?.trim();
    const angle = text(b.angle, 800)?.trim();
    if (!theme || !angle) throw new DeskError(400, "theme and angle: short, non-empty text");
    const calendar = Array.isArray(b.calendar) ? b.calendar : [];
    const weeks = calendar.map((w) => {
      const week = text((w as Record<string, unknown>)?.week, 10);
      const focus = text((w as Record<string, unknown>)?.focus, 240);
      if (!week || focus === undefined)
        throw new DeskError(400, "calendar: each week with its focus");
      return { week, focus };
    });
    return c.json(
      await inNewsroom(
        c,
        (db, actor) => approveTheme(db, actor, id(c, "cycle"), { theme, angle, calendar: weeks }),
        chief,
      ),
    );
  });
  app.post(`${base}/picks/:pick/choose`, async (c) => {
    const candidate = (await body(c)).candidate;
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0)
      throw new DeskError(400, "candidate: 0, 1 or 2");
    return c.json(
      await inNewsroom(
        c,
        (db, actor) => choosePick(db, boss, actor, id(c, "pick"), candidate),
        chief,
      ),
    );
  });

  return app;
}

/** The API without desk routes (no database); the server builds the full app. */
export const app = createApp();
