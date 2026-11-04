// The MCP server (D190): every API operation a personal token may call is a tool, generated from
// openapi.yaml. A tool call is an ordinary request to the API's own routes with the caller's
// credentials, so it has the same roles, checks and audit as the desk; this module never touches
// Postgres. Stateless: each HTTP request gets its own server and transport, and is answered as JSON.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ACCESS_HEADER } from "./desk/access.ts";
import { MCP_TOOLS, type McpTool } from "./generated/mcp-tools.ts";

/** Calls one of the API's own routes; the app's `request`. */
type CallApi = (path: string, init: RequestInit) => Response | Promise<Response>;

const INSTRUCTIONS = `ANR (Agentic News Room) runs newsrooms where people set the editorial direction, AI agents research and write, and code publishes. These tools are the editor's desk: each one is an API operation, and you act as the person whose token you hold, with their roles and nothing more. What you do is theirs: an approval through a tool is their approval, recorded in the audit log with the token.

Start with getDeskMe to learn the person's newsrooms (by slug) and roles; most tools take that slug as \`newsroom\`. A tool marked destructive decides, removes or stops something: confirm with the person first when they have not asked for exactly that. Tools return the API's JSON; an error says why (401 the token is not valid, 403 the person's role cannot do this, 404 nothing with that id, 409 the thing is not in a state that allows it).`;

/** The request a tool call makes: its path with parameters filled in, query and body. */
export function toolRequest(
  tool: McpTool,
  args: Record<string, unknown>,
): { path: string; body?: string } {
  const used = new Set<string>(["body"]);
  const path = tool.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    used.add(name);
    const value = args[name];
    if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args))
    if (!used.has(name) && value !== undefined && value !== null) query.set(name, String(value));
  const qs = query.toString();
  return {
    path: qs ? `${path}?${qs}` : path,
    ...(args.body !== undefined && { body: JSON.stringify(args.body) }),
  };
}

function mcpServer(call: CallApi, credentials: Record<string, string>): Server {
  const server = new Server(
    { name: "anr", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description:
        t.who === "member" || t.who === "anyone"
          ? t.description
          : `${t.description}\n\nOnly the ${t.who === "platform-admin" ? "platform admin" : "Editor-in-Chief"} can do this.`,
      inputSchema: t.inputSchema as { type: "object" },
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        destructiveHint: t.destructive,
        idempotentHint: t.readOnly || t.method === "PUT" || t.method === "DELETE",
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool)
      return { isError: true, content: [{ type: "text", text: `no tool ${request.params.name}` }] };
    let req: { path: string; body?: string };
    try {
      req = toolRequest(tool, request.params.arguments ?? {});
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
    const res = await call(req.path, {
      method: tool.method,
      headers: { ...credentials, "content-type": "application/json" },
      ...(req.body !== undefined && { body: req.body }),
    });
    const text = await res.text();
    return res.ok
      ? { content: [{ type: "text", text }] }
      : { isError: true, content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }] };
  });
  return server;
}

/** Answers one request to /mcp; 401 unless it carries a personal token or an Access JWT. */
export async function handleMcp(request: Request, call: CallApi): Promise<Response> {
  const credentials: Record<string, string> = {};
  const authorization = request.headers.get("authorization");
  const access = request.headers.get(ACCESS_HEADER);
  if (authorization) credentials.authorization = authorization;
  if (access) credentials[ACCESS_HEADER] = access;
  const me = await call("/desk/me", { headers: credentials });
  if (!me.ok)
    return new Response(
      JSON.stringify({ error: "send a personal token: Authorization: Bearer anr_…" }),
      {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="anr"' },
      },
    );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = mcpServer(call, credentials);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
