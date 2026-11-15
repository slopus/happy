import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { issueMessagingLinkCode, provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("provisionMessagingIdentity (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = "+15550001111";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let provisioned: { userId: string; spaceId: string; botId: string } | null = null;
  // Production provisions from the inbound messaging webhook.
  const provision = (from: string) =>
    runAsSystem("messaging inbound", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address: from },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );

  afterAll(async () => {
    if (provisioned) {
      await asSystem(prisma).messagingIdentity.deleteMany({ where: { provider, address } });
      await asSystem(prisma).organization.deleteMany({ where: { id: provisioned.spaceId } });
      await asSystem(prisma).user.deleteMany({ where: { id: provisioned.userId } });
    }
    await close?.();
  });

  it("provisions a user, workspace, bot, thread, and messaging identity row", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const result = await provision(address);
    provisioned = result;

    expect(result.created).toBe(true);
    expect(result.provider).toBe(provider);
    expect(result.address).toBe(address);

    const user = await asSystem(prisma).user.findUnique({
      where: { id: result.userId },
      include: { accounts: true, members: true },
    });
    expect(user).toBeTruthy();
    expect(user!.email).toMatch(/^msg-[a-f0-9]{32}@messaging\.invalid$/);
    expect(user!.accounts).toHaveLength(0);
    expect(user!.members).toHaveLength(1);
    expect(user!.members[0]!.organizationId).toBe(result.spaceId);
    expect(user!.members[0]!.role).toBe("owner");

    const org = await asSystem(prisma).organization.findUnique({ where: { id: result.spaceId } });
    expect(org!.name).toBe("Personal");
    expect(org!.slug).toBe(`user-${result.userId.slice(0, 12)}`);

    const space = await asSystem(prisma).space.findUnique({
      where: { id: result.spaceId },
      include: { memberships: true },
    });
    expect(space).toMatchObject({
      organizationId: org!.id,
      name: "Personal",
    });
    expect(space!.memberships).toEqual([expect.objectContaining({ userId: result.userId })]);

    const bot = await runAsSystem("test fixture", () =>
      prisma.bot.findUnique({
        where: { id: result.botId },
        include: { thread: true },
      }),
    );
    expect(bot).toBeTruthy();
    expect(bot!.spaceId).toBe(result.spaceId);
    expect(bot!.userId).toBe(result.userId);
    expect(bot!.thread).toBeTruthy();
    expect(result.threadId).toBe(bot!.thread!.id);

    const identity = await asSystem(prisma).messagingIdentity.findUnique({
      where: { provider_address: { provider, address } },
    });
    expect(identity).toBeTruthy();
    expect(identity!.userId).toBe(result.userId);
    expect(identity!.spaceId).toBe(result.spaceId);
    expect(identity!.botId).toBe(result.botId);
    expect(identity!.dmThreadId).toBeNull();
    expect(identity!.outboundSinceInbound).toBe(0);
    expect(identity!.verifiedAt).toBeNull();

    // bootstrap parity: same surrounding rows the auth signup hook creates
    const memories = await runAsSystem("test fixture", () =>
      prisma.memoryDocument.findMany({
        where: { spaceId: result.spaceId, userId: result.userId },
      }),
    );
    expect(memories.some((m) => m.scope === "user" && m.path === "MEMORY.md")).toBe(true);
    expect(memories.some((m) => m.scope === "bot" && m.botId === result.botId)).toBe(true);
    const pref = await asSystem(prisma).notificationPreference.findFirst({
      where: { spaceId: result.spaceId, userId: result.userId },
    });
    expect(pref).toBeTruthy();
  });

  it("does not let a texter claim deployment ownership", async () => {
    const settings = await asSystem(prisma).deploymentSettings.findUnique({
      where: { id: "default" },
    });
    expect(settings?.ownerUserId ?? null).not.toBe(provisioned!.userId);
  });

  it("is idempotent for a repeat inbound from the same address", async () => {
    const again = await provision(address);

    expect(again.created).toBe(false);
    expect(again.userId).toBe(provisioned!.userId);
    expect(again.spaceId).toBe(provisioned!.spaceId);
    expect(again.botId).toBe(provisioned!.botId);

    const users = await asSystem(prisma).user.findMany({
      where: { id: provisioned!.userId },
    });
    expect(users).toHaveLength(1);
    const identities = await asSystem(prisma).messagingIdentity.findMany({
      where: { provider, address },
    });
    expect(identities).toHaveLength(1);
  });

  it("does not reuse a legacy synthetic email without an identity binding", async () => {
    const partialAddress = "+15550002222";
    // This could be an abandoned attempt or an attacker registration. An
    // email address alone cannot distinguish those origins.
    const orphan = await asSystem(prisma).user.create({
      data: {
        id: `partial${Date.now()}`,
        name: "Sendblue 2222",
        email: "msg-sendblue15550002222@messaging.invalid",
        emailVerified: false,
      },
    });
    try {
      const result = await provision(partialAddress);

      expect(result.created).toBe(true);
      expect(result.userId).not.toBe(orphan.id);
      const identity = await asSystem(prisma).messagingIdentity.findUnique({
        where: { provider_address: { provider, address: partialAddress } },
      });
      expect(identity).toBeTruthy();
      const bots = await asSystem(prisma).bot.findMany({
        where: { spaceId: result.spaceId, userId: result.userId },
      });
      expect(bots).toHaveLength(1);

      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider, address: partialAddress },
      });
      await asSystem(prisma).organization.deleteMany({ where: { id: result.spaceId } });
      await asSystem(prisma).user.deleteMany({ where: { id: result.userId } });
    } finally {
      await asSystem(prisma).user.deleteMany({ where: { id: orphan.id } });
    }
  });

  it("resumes after a partial attempt that reached createBot, reusing the orphaned bot", async () => {
    const partialAddress = "+15550003333";
    // First attempt: let it provision fully, then delete only the identity row.
    const first = await provision(partialAddress);
    await asSystem(prisma).messagingIdentity.deleteMany({
      where: { provider, address: partialAddress },
    });
    try {
      const second = await provision(partialAddress);

      expect(second.userId).toBe(first.userId);
      expect(second.spaceId).toBe(first.spaceId);
      expect(second.botId).toBe(first.botId);
      const bots = await asSystem(prisma).bot.findMany({
        where: { spaceId: first.spaceId, userId: first.userId },
      });
      expect(bots).toHaveLength(1);
    } finally {
      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider, address: partialAddress },
      });
      await asSystem(prisma).organization.deleteMany({ where: { id: first.spaceId } });
      await asSystem(prisma).user.deleteMany({ where: { id: first.userId } });
    }
  });

  it("keeps one active link code per user when codes are issued concurrently", async () => {
    const request = { userId: `linkrace${Date.now()}`, spaceId: "space", botId: "bot" };
    try {
      await Promise.all(Array.from({ length: 8 }, () => issueMessagingLinkCode(prisma, request)));
      const codes = await asSystem(prisma).messagingLinkCode.findMany({
        where: { userId: request.userId },
      });
      expect(codes).toHaveLength(1);
    } finally {
      await asSystem(prisma).messagingLinkCode.deleteMany({ where: { userId: request.userId } });
    }
  });
});
