import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditedUpdate, recordAudit } from "./audit.ts";
import { withNewsroom } from "./index.ts";
import { createTestNewsroom, testPools } from "./testing.ts";

const pools = testPools();
let a: string;
let b: string;
let channelA: string;
let channelB: string;

const insertChannel = (newsroomId: string) =>
  withNewsroom(pools.app, newsroomId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into channels (newsroom_id, kind, language) values ($1, 'telegram', 'fa') returning id",
      [newsroomId],
    );
    return rows[0]?.id ?? "";
  });

beforeAll(async () => {
  a = await createTestNewsroom(pools.system, "audit-a");
  b = await createTestNewsroom(pools.system, "audit-b");
  channelA = await insertChannel(a);
  channelB = await insertChannel(b);
});
afterAll(() => pools.end());

describe("auditedUpdate", () => {
  it("changes the row and records before and after in the same transaction", async () => {
    const actor = { kind: "code", name: "test" } as const;
    await withNewsroom(pools.app, a, (c) =>
      auditedUpdate(c, actor, "disable", "channels", channelA, { status: "disabled" }),
    );
    const entries = await withNewsroom(pools.app, a, async (c) => {
      const { rows } = await c.query(
        "select actor_kind, actor_name, action, before->>'status' as before, after->>'status' as after from audit_log where entity_id = $1",
        [channelA],
      );
      return rows;
    });
    expect(entries).toEqual([
      {
        actor_kind: "code",
        actor_name: "test",
        action: "disable",
        before: "active",
        after: "disabled",
      },
    ]);
  });

  it("rolls the audit entry back with a failed change", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        auditedUpdate(c, { kind: "code", name: "test" }, "break", "channels", channelA, {
          status: "not-a-status",
        }),
      ),
    ).rejects.toThrow(/check constraint/);
    const { rows } = await pools.system.query(
      "select 1 from audit_log where entity_id = $1 and action = 'break'",
      [channelA],
    );
    expect(rows).toEqual([]);
  });

  it("cannot edit another newsroom's row", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        auditedUpdate(c, { kind: "code", name: "test" }, "edit", "channels", channelB, {
          status: "disabled",
        }),
      ),
    ).rejects.toThrow("not found");
  });

  it("refuses identifiers that are not plain names", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        auditedUpdate(c, { kind: "code", name: "t" }, "x", "channels; drop table x", channelA, {
          status: "active",
        }),
      ),
    ).rejects.toThrow("not a plain identifier");
  });
});

describe("recordAudit", () => {
  it("requires a user for a person's action", async () => {
    await expect(
      withNewsroom(pools.app, a, (c) =>
        recordAudit(c, {
          actor: { kind: "person", userId: crypto.randomUUID() },
          action: "approve",
          entity: "channels",
          entityId: channelA,
        }),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
