import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import { deleteClaimedSpace } from "./spaces.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("claimed Space deletion (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `claim-user-${suffix}`;
  const organizationId = `claim-organization-${suffix}`;
  const spaceId = `claim-space-${suffix}`;
  let system: PrismaClient;
  let close: () => Promise<void>;

  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("returns no artifact keys for a Space another claim took over", async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Claimed", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: {
        id: spaceId,
        organizationId,
        name: "Claimed",
        isDefault: true,
        createdByUserId: userId,
      },
    });
    await system.artifact.create({
      data: {
        spaceId,
        userId,
        name: "plan.txt",
        mimeType: "text/plain",
        size: 4,
        hash: "hash-claim",
        storageKey: `blob-claim-${suffix}`,
      },
    });
    // The claiming attempt stalled, and another deletion took the Space over.
    await system.space.update({
      where: { id: spaceId },
      data: { deletingAt: new Date(), deletionClaimId: "stalled-attempt" },
    });
    await system.space.update({
      where: { id: spaceId },
      data: { deletingAt: new Date(), deletionClaimId: "another-deletion" },
    });

    const deleted = await deleteClaimedSpace(system, { spaceId, claimId: "stalled-attempt" });

    // The Space stays with its new claim, so its files must stay in the store too.
    expect(deleted).toEqual({ artifactKeys: [], pageShareSecrets: [] });
    expect(await system.space.findUnique({ where: { id: spaceId } })).toMatchObject({
      deletionClaimId: "another-deletion",
    });
    expect(await system.artifact.count({ where: { spaceId } })).toBe(1);
  });
});
