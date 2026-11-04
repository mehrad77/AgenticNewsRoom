// The MCP server on anr_test (D190): an MCP client with a personal token lists the tools and acts
// as the token's person, with their roles, and its acts are theirs.
import { randomBytes } from "node:crypto";
import { platformKey } from "@anr/db";
import { createTestNewsroom, testPools } from "@anr/db/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { MCP_TOOLS } from "./generated/mcp-tools.ts";

const pools = testPools();
afterAll(() => pools.end());
let signedIn: string | null = null;
const app = createApp({
  pool: pools.app,
  boss: { send: async () => "job" } as never,
  platform: platformKey(randomBytes(32).toString("base64")),
  verify: async () => signedIn,
  site: { rootDomain: "example.test" },
});

let slug = "";
let newsroomId = "";
const chief = `chief-${randomBytes(4).toString("hex")}@example.test`;
const editor = `editor-${randomBytes(4).toString("hex")}@example.test`;

/** A token for `email`, issued as the desk would. */
const tokenFor = async (email: string) => {
  signedIn = email;
  const res = await app.request("/desk/me/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "mcp test" }),
  });
  signedIn = null;
  return ((await res.json()) as { token: string }).token;
};

const connect = async (token: string) => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://api.example.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    }),
  );
  return client;
};
const text = (result: unknown) =>
  (result as { content: { type: string; text: string }[] }).content[0]?.text ?? "";

beforeAll(async () => {
  newsroomId = await createTestNewsroom(pools.system, "mcp");
  slug =
    (
      await pools.system.query<{ slug: string }>("select slug from newsrooms where id = $1", [
        newsroomId,
      ])
    ).rows[0]?.slug ?? "";
  for (const [email, role] of [
    [chief, "editor-in-chief"],
    [editor, "editor"],
  ] as const) {
    const { rows } = await pools.system.query<{ id: string }>(
      "insert into users (email) values ($1) returning id",
      [email],
    );
    await pools.system.query(
      "insert into memberships (newsroom_id, user_id, role) values ($1, $2, $3)",
      [newsroomId, rows[0]?.id, role],
    );
  }
});

describe("the MCP server", () => {
  it("lists every tool, with its annotations, to a client with a token", async () => {
    const client = await connect(await tokenFor(chief));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    expect(tools.find((t) => t.name === "approvePublication")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(client.getInstructions()).toMatch(/act as the person/);
    await client.close();
  });

  it("acts as the token's person, with their role", async () => {
    const chiefClient = await connect(await tokenFor(chief));
    const me = JSON.parse(text(await chiefClient.callTool({ name: "getDeskMe", arguments: {} })));
    expect(me).toMatchObject({ email: chief });
    const started = await chiefClient.callTool({
      name: "startRecheck",
      arguments: { newsroom: slug, body: {} },
    });
    expect(started.isError).toBeFalsy();
    expect(JSON.parse(text(started))).toMatchObject({ started_by: chief });
    expect(
      (await chiefClient.callTool({ name: "stopRecheck", arguments: { newsroom: slug } })).isError,
    ).toBeFalsy();
    await chiefClient.close();

    const editorClient = await connect(await tokenFor(editor));
    const refused = await editorClient.callTool({
      name: "startRecheck",
      arguments: { newsroom: slug, body: {} },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^HTTP 403/);
    await editorClient.close();
  });

  it("answers 401 without a valid token", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });
});
