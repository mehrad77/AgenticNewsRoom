// Sends a publication to an editor with the reason stored as a policy Check, so a hold always
// shows why. The publisher may hold a scheduled publication (D89, D90); a published one stays up.
import { auditedUpdate, type Client } from "@anr/db";

export interface HoldReason {
  name: string;
  result: "fail" | "error" | "timed-out";
  detail?: unknown;
}

const HOLDABLE = ["assigned", "drafted", "scheduled"];

export async function holdPublication(client: Client, id: string, reason: HoldReason) {
  await client.query(
    `insert into checks (newsroom_id, publication_id, kind, name, result, detail)
     values (anr.current_newsroom_id(), $1, 'policy', $2, $3, $4)`,
    [id, reason.name, reason.result, JSON.stringify(reason.detail ?? null)],
  );
  const { rows } = await client.query<{ status: string }>(
    "select status from publications where id = $1 for update",
    [id],
  );
  if (rows[0] && HOLDABLE.includes(rows[0].status)) {
    await auditedUpdate(client, { kind: "code", name: "publisher" }, "hold", "publications", id, {
      status: "with-editor",
      updated_at: new Date(),
    });
  }
}
