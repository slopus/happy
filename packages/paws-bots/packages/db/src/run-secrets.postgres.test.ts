import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import { deleteRunSecretsInTransaction, runLoginKind, runSecretKind } from "./run-secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("run secret cleanup (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `run-secret-owner-${suffix}`;
  const otherId = `run-secret-other-${suffix}`;
  const organizationId = `run-secret-organization-${suffix}`;
  const spaceId = `run-secret-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [ownerId, otherId]) {
      await prisma.user.create({
        data: { id, name: "Run Secret Test", email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Run Secret Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", createdByUserId: ownerId },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await close();
  });

  it("removes the run's waiting answer and run-only logins and leaves other rows alone", async () => {
    const rows = [
      { userId: ownerId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runLoginKind("run-1", "example-login") },
      { userId: otherId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runSecretKind("run-2") },
      { userId: ownerId, kind: runLoginKind("run-10", "example-login") },
      { userId: ownerId, kind: "agent-environment" },
    ];
    await prisma.secret.createMany({
      data: rows.map((row) => ({ ...row, spaceId, ciphertext: "fake-ciphertext" })),
    });

    await prisma.$transaction((tx) =>
      deleteRunSecretsInTransaction(tx, [{ id: "run-1", userId: ownerId, spaceId }]),
    );

    const left = await prisma.secret.findMany({
      where: { spaceId },
      select: { userId: true, kind: true },
      orderBy: [{ kind: "asc" }, { userId: "asc" }],
    });
    expect(left).toEqual([
      { userId: ownerId, kind: "agent-environment" },
      { userId: ownerId, kind: runLoginKind("run-10", "example-login") },
      { userId: otherId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runSecretKind("run-2") },
    ]);
  });
});
