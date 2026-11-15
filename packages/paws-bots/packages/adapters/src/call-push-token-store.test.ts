import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { PrismaPushTokenStore, PushSessionEndedError } from "./push-token-store.js";

type Row = {
  id: string;
  userId: string;
  sessionId: string;
  ciphertext: string;
  expoTokenDigest?: string | null;
  voipTokenDigest?: string | null;
};
function fixture() {
  const rows = new Map<string, Row>();
  let live = true;
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Record<string, unknown>[]).some((part) => matches(row, part));
      if (value && typeof value === "object" && "not" in value)
        return row[key as keyof Row] !== value.not;
      return row[key as keyof Row] === value;
    });
  const table = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Row;
        update: Partial<Row>;
      }) => {
        rows.set(where.id, rows.has(where.id) ? { ...rows.get(where.id)!, ...update } : create);
      },
    ),
    findMany: vi.fn(async ({ where }: { where: Partial<Row> }) =>
      [...rows.values()].filter((row) => matches(row, where)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Partial<Row> }) => {
      for (const row of rows.values()) if (matches(row, where)) rows.delete(row.id);
      return { count: 1 };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
      for (const row of rows.values())
        if (matches(row, where)) rows.set(row.id, { ...row, ...data });
      return { count: 1 };
    }),
  };
  const tx = {
    callPushDevice: table,
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("").includes('FROM "session"') ? (live ? [{ id: "session-1" }] : []) : [],
    ),
    pushToken: { deleteMany: vi.fn(async () => {}) },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return {
    store: new PrismaPushTokenStore(prisma, "offline-test-key"),
    rows,
    endSession: () => {
      live = false;
    },
  };
}
const registration = {
  deviceId: "installation-1",
  platform: "ios" as const,
  expoToken: "ExponentPushToken[fake]",
  voipToken: "fake-voip-token",
};
describe("call push registrations", () => {
  it("encrypts tokens, isolates owners, and retains multiple installations", async () => {
    const { store, rows } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    await store.saveDevice(
      "user-1",
      {
        ...registration,
        deviceId: "installation-2",
        expoToken: "ExponentPushToken[second]",
        voipToken: "second-voip-token",
      },
      "session-2",
    );
    expect(await store.devices("user-1")).toHaveLength(2);
    expect(await store.devices("user-2")).toEqual([]);
    for (const row of rows.values()) {
      expect(row.ciphertext).not.toContain(registration.voipToken);
      expect(row.ciphertext).not.toContain(registration.expoToken);
    }
    await store.saveDevice("user-2", registration, "session-3");
    expect(await store.devices("user-1")).toHaveLength(1);
    expect(await store.devices("user-2")).toHaveLength(1);
  });
  it("merges independently arriving Expo and VoIP registrations", async () => {
    const { store } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    await store.saveDevice(
      "user-1",
      { deviceId: registration.deviceId, platform: "ios", voipToken: "replacement-token" },
      "session-1",
    );
    expect((await store.devices("user-1"))[0]).toMatchObject({
      expoToken: registration.expoToken,
      voipToken: "replacement-token",
    });
  });
  it("moves reused tokens to one owner even with a new installation id", async () => {
    const { store } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    await store.saveDevice(
      "user-2",
      { ...registration, deviceId: "new-installation" },
      "session-2",
    );
    expect(await store.devices("user-1")).toEqual([]);
    expect(await store.devices("user-2")).toHaveLength(1);
  });
  it("rejects late registration after sign-out", async () => {
    const { store, endSession } = fixture();
    endSession();
    await expect(store.saveDevice("user-1", registration, "session-1")).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    expect(await store.devices("user-1")).toEqual([]);
  });
  it("invalidates one transport without deleting a replacement or another transport", async () => {
    const { store } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    const old = (await store.devices("user-1"))[0]!;
    await store.saveDevice(
      "user-1",
      { ...registration, voipToken: "replacement-token" },
      "session-1",
    );
    await store.removeDevice("user-1", registration.deviceId, old.revision, "voip");
    const current = (await store.devices("user-1"))[0]!;
    expect(current.voipToken).toBe("replacement-token");
    await store.removeDevice("user-1", registration.deviceId, current.revision, "voip");
    expect((await store.devices("user-1"))[0]).toMatchObject({ expoToken: registration.expoToken });
    expect((await store.devices("user-1"))[0]?.voipToken).toBeUndefined();
  });
  it("applies both transports' invalidations taken from the same revision", async () => {
    const { store } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    const { revision } = (await store.devices("user-1"))[0]!;
    await store.removeDevice("user-1", registration.deviceId, revision, "voip");
    await store.removeDevice("user-1", registration.deviceId, revision, "expo");
    expect(await store.devices("user-1")).toEqual([]);
  });
  it("revokes only the session's devices", async () => {
    const { store } = fixture();
    await store.saveDevice("user-1", registration, "session-1");
    await store.saveDevice(
      "user-1",
      {
        ...registration,
        deviceId: "installation-2",
        expoToken: "ExponentPushToken[second]",
        voipToken: "second-voip-token",
      },
      "session-2",
    );
    await store.endSession("user-1", "session-1");
    expect((await store.devices("user-1")).map((device) => device.sessionId)).toEqual([
      "session-2",
    ]);
  });
});
