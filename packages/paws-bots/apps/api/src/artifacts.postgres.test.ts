import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MCP_APP_MIME_TYPE } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, IsolationError, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnedArtifact, listSpaceArtifacts } from "./artifacts.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("artifact upload nonce (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `artifact-nonce-user-${suffix}`;
  const organizationId = `artifact-nonce-org-${suffix}`;
  const spaceId = `artifact-nonce-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const stored = new Set<string>();
  let puts = 0;
  const artifacts = {
    async put() {
      puts += 1;
      const id = `blob-${puts}`;
      stored.add(id);
      return { id };
    },
    async remove(id: string) {
      stored.delete(id);
    },
  } as unknown as ArtifactStore;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let otherBotId: string;
  const upload = (clientNonce: string | undefined, target: { botId: string; groupId?: string }) =>
    runAsTenant(actor, () =>
      createOwnedArtifact({ prisma, artifacts }, actor, {
        ...target,
        name: "notes.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("hello").toString("base64"),
        clientNonce,
      }),
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Nonce Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    botId = (await system.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
    otherBotId = (
      await system.bot.create({ data: { spaceId, userId, name: "Scout", color: "green" } })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("returns the artifact a retried upload already created", async () => {
    const first = await upload("send-1:0", { botId });
    const retry = await upload("send-1:0", { botId });
    expect(retry).toEqual(first);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-1:0" } })).toBe(1);
    expect(stored.size).toBe(1);
  });

  it("creates one artifact when two retries of an upload race", async () => {
    const [a, b] = await Promise.all([
      upload("send-2:0", { botId }),
      upload("send-2:0", { botId }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-2:0" } })).toBe(1);
    expect(stored.size).toBe(2);
  });

  it("replays one artifact when retries of a group upload race under different member bots", async () => {
    const group = await system.chatGroup.create({ data: { spaceId, userId, name: "Race" } });
    const uploads = await Promise.all(
      [botId, otherBotId, botId, otherBotId].map((member) =>
        upload("send-5:0", { botId: member, groupId: group.id }),
      ),
    );
    expect(new Set(uploads.map((artifact) => artifact.id)).size).toBe(1);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-5:0" } })).toBe(1);
  });

  it("keeps an MCP app's document out of the artifact list", async () => {
    await upload("send-6:0", { botId });
    await system.artifact.create({
      data: {
        spaceId,
        userId,
        botId,
        name: "Forecast app.html",
        mimeType: MCP_APP_MIME_TYPE,
        size: 5,
        hash: "app-hash",
        storageKey: "blob-app",
      },
    });
    const listed = await runAsTenant(actor, () => listSpaceArtifacts({ prisma }, actor, { botId }));
    expect(new Set(listed.items.map((item) => item.name))).toEqual(new Set(["notes.txt"]));

    // A file that happens to share the app document's name starts its own history.
    const sameName = await runAsTenant(actor, () =>
      createOwnedArtifact({ prisma, artifacts }, actor, {
        botId,
        name: "Forecast app.html",
        mimeType: "text/html",
        contentBase64: Buffer.from("<p>mine</p>").toString("base64"),
      }),
    );
    expect(sameName.version).toBe(1);
  });

  it("refuses a nonce reused for another chat", async () => {
    await upload("send-3:0", { botId });
    await expect(upload("send-3:0", { botId: otherBotId })).rejects.toBeInstanceOf(IsolationError);
  });
});
