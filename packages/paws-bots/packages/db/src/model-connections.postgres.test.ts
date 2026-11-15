import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { getModelRole, updateModelRole } from "./model-roles.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20261025120000_model_connections/migration.sql",
  ),
  "utf8",
);
/** The migration's pinning of existing rows, without the schema changes before it. */
const backfill = migration
  .slice(migration.indexOf('UPDATE "space_model_role_choices"'))
  .trim()
  .replace(/;$/, "");

class Rollback extends Error {
  constructor(readonly rows: unknown) {
    super("rollback");
  }
}

describePostgres("model connections (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `model-connections-user-${suffix}`;
  const organizationId = `model-connections-organization-${suffix}`;
  const spaceId = `model-connections-space-${suffix}`;
  const personal = `model-connections-personal-${suffix}`;
  const work = `model-connections-work-${suffix}`;
  const azure = `model-connections-azure-${suffix}`;
  // A Space's own copy; the account's shares the same code path.
  const scope = { userId, spaceId, scope: "space" as const };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  const connect = async (id: string, provider: string) => {
    await prisma.secret.create({
      data: { id, userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await prisma.userModelCredential.create({
      data: { id, userId, provider, label: provider, secretId: id },
    });
  };
  const rows = () =>
    prisma.spaceModelRoleChoice.findMany({
      where: { userId, spaceId },
      orderBy: [{ role: "asc" }, { position: "asc" }],
      select: { role: true, position: true, provider: true, modelId: true, credentialId: true },
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const createdAt = new Date();
    await prisma.user.create({
      data: {
        id: userId,
        name: "Connections",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Connections", slug: organizationId, createdAt },
    });
    await prisma.member.create({
      data: { id: `${userId}-member`, organizationId, userId, role: "owner", createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: spaceId, createdByUserId: userId },
    });
    await prisma.spaceMember.create({
      data: { id: `${spaceId}-member`, spaceId, organizationId, userId, createdAt },
    });
  });

  beforeEach(async () => {
    await prisma.spaceModelRoleChoice.deleteMany({ where: { userId } });
    await prisma.spaceModelPreference.deleteMany({ where: { userId } });
    await prisma.userModelCredential.deleteMany({ where: { userId } });
    await prisma.secret.deleteMany({ where: { userId } });
    await connect(personal, "openai-codex");
    await connect(azure, "azure-openai-responses");
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("pins existing rows to the provider's only connection", async () => {
    await connect(`${work}-xai`, "xai");
    await connect(`${work}-xai-2`, "xai");
    await prisma.spaceModelRoleChoice.createMany({
      data: [
        { spaceId, userId, role: "main", position: 0, provider: "openai-codex", modelId: "gpt-5" },
        { spaceId, userId, role: "main", position: 1, provider: "azure", modelId: "gpt-4o" },
        // Two connections: which one ran it is not known, so it keeps resolving at run time.
        { spaceId, userId, role: "main", position: 2, provider: "xai", modelId: "grok" },
        // Deployment-managed: no connection.
        { spaceId, userId, role: "approval", position: 0, provider: "openrouter", modelId: "m" },
      ],
    });
    const pinned = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(backfill);
        throw new Rollback(
          await tx.spaceModelRoleChoice.findMany({
            where: { userId, spaceId },
            orderBy: [{ role: "asc" }, { position: "asc" }],
            select: { provider: true, credentialId: true },
          }),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return error.rows;
        throw error;
      });
    expect(pinned).toEqual([
      { provider: "openrouter", credentialId: null },
      { provider: "openai-codex", credentialId: personal },
      { provider: "azure", credentialId: azure },
      { provider: "xai", credentialId: null },
    ]);
  });

  it("lists the same model on two connections, and falls back between them", async () => {
    await connect(work, "openai-codex");
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-codex", modelId: "gpt-5", credentialId: personal },
      backups: [{ provider: "openai-codex", modelId: "gpt-5", credentialId: work }],
    });
    await expect(getModelRole(prisma, scope, "main")).resolves.toEqual({
      primary: { provider: "openai-codex", modelId: "gpt-5", credentialId: personal },
      backups: [{ provider: "openai-codex", modelId: "gpt-5", credentialId: work }],
    });
  });

  it("keeps a model once per connection, including rows that name none", async () => {
    const row = { spaceId, userId, role: "main", provider: "xai", modelId: "grok" };
    await prisma.spaceModelRoleChoice.create({ data: { ...row, position: 0 } });
    await expect(
      prisma.spaceModelRoleChoice.create({ data: { ...row, position: 1 } }),
    ).rejects.toThrow();
  });

  it("removes a connection's rows with it and keeps the other account's", async () => {
    await connect(work, "openai-codex");
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-codex", modelId: "gpt-5", credentialId: personal },
      backups: [{ provider: "openai-codex", modelId: "gpt-5", credentialId: work }],
    });
    await prisma.userModelCredential.delete({ where: { id: personal } });
    expect(await rows()).toEqual([
      { role: "main", position: 1, provider: "openai-codex", modelId: "gpt-5", credentialId: work },
    ]);
  });

  it("keeps a row's connection when an older app saves it without one", async () => {
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-codex", modelId: "gpt-5", credentialId: personal },
      backups: [{ provider: "azure", modelId: "gpt-4o", credentialId: azure }],
    });
    // The previous order, reversed by an app that predates connections.
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "azure", modelId: "gpt-4o" },
      backups: [{ provider: "openai-codex", modelId: "gpt-5" }],
    });
    expect((await rows()).map((row) => row.credentialId)).toEqual([azure, personal]);
  });
});
