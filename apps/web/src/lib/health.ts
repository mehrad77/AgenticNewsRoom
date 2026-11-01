// /healthz (D128): 200 only while Postgres answers and every worker beat within 3 minutes. The
// external uptime check calls it through the tunnel on the root host (D141); never cached.
import { health, type Pool } from "@anr/db";

const reply = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function healthResponse(pool: Pick<Pool, "query">): Promise<Response> {
  try {
    const h = await health(pool);
    return h.ok ? reply(200, { status: "ok" }) : reply(503, { status: "late", workers: h.late });
  } catch {
    return reply(503, { status: "no-database" });
  }
}
