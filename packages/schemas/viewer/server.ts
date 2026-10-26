// Schema viewer: `pnpm --filter @anr/schemas view`, then open http://localhost:4400.
// Reads schemas from disk on every request, so edits show up on reload.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { relative } from "node:path";
import { listSchemas, loadSchema } from "./catalog.ts";

const port = Number(process.env.SCHEMA_VIEWER_PORT ?? process.env.PORT ?? 4400);
const page = new URL("./index.html", import.meta.url);
const repo = new URL("../../..", import.meta.url).pathname;

const json = (body: unknown, status = 200) => ({
  status,
  type: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let out: { status: number; type: string; body: string };
  try {
    if (url.pathname === "/") {
      out = { status: 200, type: "text/html; charset=utf-8", body: readFileSync(page, "utf8") };
    } else if (url.pathname === "/api/schemas") {
      out = json(listSchemas().map((s) => ({ ...s, file: relative(repo, s.file) })));
    } else if (url.pathname.startsWith("/api/schemas/")) {
      const schema = await loadSchema(
        decodeURIComponent(url.pathname.slice("/api/schemas/".length)),
      );
      out = schema === undefined ? json({ error: "not found" }, 404) : json(schema);
    } else {
      out = json({ error: "not found" }, 404);
    }
  } catch (error) {
    out = json({ error: String(error) }, 500);
  }
  res.writeHead(out.status, { "content-type": out.type });
  res.end(out.body);
}).listen(port, "127.0.0.1", () => console.log(`schema viewer on http://localhost:${port}`));
