import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import { pruneSecurityEvents } from "./security-events.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("security events (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    // Pruning runs in the reconciler, as system; so do the fixtures.
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.securityEvent.deleteMany({
        where: { userId: { startsWith: suffix } },
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => close?.());

  it("rejects rewriting an event", async () => {
    const row = await prisma.securityEvent.create({
      data: { type: "auth.sign_in", userId: `${suffix}-a`, ip: "203.0.113.5" },
    });
    await expect(
      prisma.securityEvent.update({
        where: { id: row.id },
        data: { ip: "192.0.2.1" },
      }),
      // The runtime login has no UPDATE grant; an owner connection hits the trigger.
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it("prunes past the retention window and keeps recent events", async () => {
    const now = new Date();
    await prisma.securityEvent.createMany({
      data: [
        {
          type: "auth.sign_in",
          userId: `${suffix}-old`,
          createdAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
        },
        { type: "auth.sign_in", userId: `${suffix}-new`, createdAt: now },
      ],
    });
    await pruneSecurityEvents(prisma, 30, now);
    const remaining = await prisma.securityEvent.findMany({
      where: { userId: { in: [`${suffix}-old`, `${suffix}-new`] } },
      select: { userId: true },
    });
    expect(remaining).toEqual([{ userId: `${suffix}-new` }]);
  });
});
