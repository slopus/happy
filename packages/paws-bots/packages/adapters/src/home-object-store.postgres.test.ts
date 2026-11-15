import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  ContentKeyRing,
  createDb,
  LocalKeyProvider,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAgentHomeRecords } from "./home-object-store.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("agent home storage records (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string };
  const address = `home-records-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("home storage records fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("records a save without moving the stamp an idle suspension claimed", async () => {
    const homeKey = `home-records-${randomUUID()}`;
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: homeKey,
        homeKey,
        kind: "fake",
        state: "running",
      },
    });
    const claimedAt = new Date(computer.updatedAt.getTime() + 1_000);
    await system.computer.update({
      where: { id: computer.id },
      data: { state: "suspending", updatedAt: claimedAt },
    });
    const records = new PrismaAgentHomeRecords(db.prisma, memoryRing());

    const stored = await records.create(homeKey);
    expect(stored?.revision).toBeNull();
    expect(await records.advance(homeKey, stored!.storageId, null, "rev-1")).toBe(true);
    expect(await records.advance(homeKey, stored!.storageId, null, "rev-2")).toBe(false);

    const finished = await system.computer.updateMany({
      where: { id: computer.id, state: "suspending", updatedAt: claimedAt },
      data: { state: "suspended" },
    });
    expect(finished.count).toBe(1);
    expect((await records.load(homeKey))?.revision).toBe("rev-1");
  });
});

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}
