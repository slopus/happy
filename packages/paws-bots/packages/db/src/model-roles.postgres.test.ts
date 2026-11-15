import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { getModelRole, updateModelRole } from "./model-roles.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("model roles (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `model-roles-user-${suffix}`;
  const organizationId = `model-roles-organization-${suffix}`;
  const spaceId = `model-roles-space-${suffix}`;
  const otherSpaceId = `model-roles-other-space-${suffix}`;
  const anthropic = `model-roles-anthropic-${suffix}`;
  const compatible = `model-roles-compatible-${suffix}`;
  // A Space's own copy; see the account test below for the member's defaults.
  const scope = { userId, spaceId, scope: "space" as const };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  const mainRows = (space = spaceId) =>
    prisma.spaceModelRoleChoice.findMany({
      where: { userId, spaceId: space, role: "main" },
      orderBy: { position: "asc" },
      select: { position: true, provider: true, modelId: true, thinkingLevel: true },
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
        name: "Model Roles",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Model Roles", slug: organizationId, createdAt },
    });
    await prisma.member.create({
      data: { id: `${userId}-member`, organizationId, userId, role: "owner", createdAt },
    });
    for (const id of [spaceId, otherSpaceId]) {
      await prisma.space.create({
        data: { id, organizationId, name: id, createdByUserId: userId },
      });
      await prisma.spaceMember.create({
        data: { id: `${id}-member`, spaceId: id, organizationId, userId, createdAt },
      });
    }
    for (const [id, provider] of [
      [anthropic, "azure-openai-responses"],
      [compatible, "openai-compatible"],
    ] as const) {
      await prisma.secret.create({
        data: { id, userId, kind: "model", ciphertext: "fake-ciphertext" },
      });
      await prisma.userModelCredential.create({
        data: { id, userId, provider, label: provider, secretId: id },
      });
    }
  });

  beforeEach(async () => {
    await prisma.spaceModelRoleChoice.deleteMany({ where: { userId } });
    await prisma.userModelRoleChoice.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("writes the main model to the role table", async () => {
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-compatible", modelId: "llama", thinkingLevel: "low" },
      backups: [{ provider: "azure-openai-responses", modelId: "gpt-5" }],
    });

    expect(await mainRows()).toEqual([
      { position: 0, provider: "openai-compatible", modelId: "llama", thinkingLevel: "low" },
      { position: 1, provider: "azure", modelId: "gpt-5", thinkingLevel: null },
    ]);
  });

  it("keeps the account's models apart from a Space's own copy", async () => {
    const account = { userId, spaceId, scope: "account" as const };
    await updateModelRole(prisma, account, "main", {
      primary: { provider: "azure", modelId: "gpt-5", thinkingLevel: "high" },
    });
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-compatible", modelId: "llama" },
    });

    await expect(getModelRole(prisma, account, "main")).resolves.toEqual({
      primary: { provider: "azure", modelId: "gpt-5", thinkingLevel: "high" },
      backups: [],
    });
    await expect(
      getModelRole(prisma, { ...account, spaceId: otherSpaceId }, "main"),
    ).resolves.toMatchObject({ primary: { modelId: "gpt-5" } });
    await expect(getModelRole(prisma, scope, "main")).resolves.toMatchObject({
      primary: { modelId: "llama" },
    });
    expect(await mainRows(otherSpaceId)).toEqual([]);
  });

  it("keeps a model's effort when the list is reordered", async () => {
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "azure", modelId: "gpt-5", thinkingLevel: "high" },
      backups: [{ provider: "openai-compatible", modelId: "llama" }],
    });
    await updateModelRole(prisma, scope, "main", {
      primary: { provider: "openai-compatible", modelId: "llama" },
      backups: [{ provider: "azure", modelId: "gpt-5" }],
    });

    await expect(getModelRole(prisma, scope, "main")).resolves.toEqual({
      primary: { provider: "openai-compatible", modelId: "llama" },
      backups: [{ provider: "azure", modelId: "gpt-5", thinkingLevel: "high" }],
    });
  });
});
