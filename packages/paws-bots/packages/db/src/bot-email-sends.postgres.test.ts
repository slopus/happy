import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reserveBotEmailSend } from "./bot-email-sends.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("bot email send limits (PostgreSQL)", () => {
  const userId = `email-sends-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).user.create({
      data: { id: userId, name: "Sender", email: `${userId}@example.test`, emailVerified: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    await close();
  });

  beforeEach(async () => {
    const system = asSystem(prisma);
    await system.botEmailSend.deleteMany({ where: { userId } });
    await system.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        deactivatedAt: null,
        botEmailDailyLimit: 10,
        botEmailRepliesEnabled: false,
        botEmailAllowedRecipients: [],
      },
    });
  });

  const reserve = (
    botId: string,
    spaceId: string,
    recipients = [`${userId}@example.test`],
    verifiedReplySender?: string,
    now?: Date,
  ) =>
    runAsTenant({ spaceId, userId }, () =>
      reserveBotEmailSend(prisma, { userId, botId, recipients, verifiedReplySender }, now),
    );

  it("charges existing reservations and overlapping previous-release writers their maximum recipients", async () => {
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261212120000_bot_email_policy/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await asSystem(prisma).$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "user" (id TEXT PRIMARY KEY) ON COMMIT DROP');
      await tx.$executeRawUnsafe(
        "CREATE TEMP TABLE bot_email_sends (id TEXT PRIMARY KEY) ON COMMIT DROP",
      );
      await tx.$executeRaw`INSERT INTO bot_email_sends (id) VALUES ('before-migration')`;
      for (const statement of sql
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((statement) => statement.trim()))
        await tx.$executeRawUnsafe(statement);
      await tx.$executeRaw`INSERT INTO bot_email_sends (id) VALUES ('previous-release')`;
      const rows = await tx.$queryRaw<{ id: string; recipientCount: number }[]>`
        SELECT id, "recipientCount" FROM bot_email_sends ORDER BY id`;
      expect(rows).toEqual([
        { id: "before-migration", recipientCount: 10 },
        { id: "previous-release", recipientCount: 10 },
      ]);
    });
    await asSystem(prisma).botEmailSend.create({ data: { userId, botId: "previous-release" } });
    expect(await reserve("bot", "space")).toBe("limit");
  });

  it("shares ten deliveries across concurrent bots in different Spaces", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserve(`bot-${index}`, `space-${index}`)),
    );
    expect(results.filter((result) => typeof result === "object")).toHaveLength(10);
    expect(results.filter((result) => result === "limit")).toHaveLength(2);
    expect(await reserve("new-bot", "new-space")).toBe("limit");
  });

  it("waits for a previous-release reservation before checking the allowance", async () => {
    let pending: ReturnType<typeof reserve> | undefined;
    try {
      await asSystem(prisma).$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${`bot-email-send:${userId}`}, 0))::text AS "lock"`;
          pending = reserve("new-worker", "space");
          await expect
            .poll(async () => {
              const [row] = await asSystem(prisma).$queryRaw<{ waiting: bigint }[]>`
                SELECT count(*) AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%SELECT pg_advisory_xact_lock(hashtextextended(%'`;
              return Number(row?.waiting ?? 0);
            })
            .toBeGreaterThan(0);
          // This is the previous writer: no recipientCount field in its insert.
          await tx.botEmailSend.create({ data: { userId, botId: "old-worker" } });
        },
        { timeout: 15_000 },
      );
      expect(await pending).toBe("limit");
    } finally {
      await pending;
    }
  });

  it("charges every recipient and refuses a send that would exceed the allowance", async () => {
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailRepliesEnabled: true },
    });
    const recipients = [`${userId}@example.test`, "sender@example.test"];
    for (let send = 0; send < 5; send++)
      expect(await reserve("bot", "space", recipients, "sender@example.test")).toHaveProperty("id");
    expect(await reserve("bot", "space", recipients, "sender@example.test")).toBe("limit");
    expect(await reserve("bot", "space")).toBe("limit");
    const total = await asSystem(prisma).botEmailSend.aggregate({
      where: { userId },
      _sum: { recipientCount: true },
    });
    expect(total._sum.recipientCount).toBe(10);
  });

  it("requires a verified active owner, permits only the owner by default, and supports a pause", async () => {
    expect(await reserve("bot", "space", ["stranger@example.test"], "stranger@example.test")).toBe(
      "recipient",
    );
    await asSystem(prisma).user.update({ where: { id: userId }, data: { emailVerified: false } });
    expect(await reserve("bot", "space")).toBe("unverified");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { emailVerified: true, deactivatedAt: new Date() },
    });
    expect(await reserve("bot", "space")).toBe("disabled");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { deactivatedAt: null, botEmailDailyLimit: 0 },
    });
    expect(await reserve("bot", "space")).toBe("disabled");
    expect(await asSystem(prisma).botEmailSend.count({ where: { userId } })).toBe(0);
  });

  it("honors operator-approved recipients and their revocation without granting other addresses", async () => {
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailAllowedRecipients: ["reports@example.test"] },
    });
    expect(await reserve("bot", "space", ["reports@example.test"])).toHaveProperty("id");
    expect(await reserve("bot", "space", ["other@example.test"])).toBe("recipient");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailAllowedRecipients: [] },
    });
    expect(await reserve("bot", "space", ["reports@example.test"])).toBe("recipient");
  });

  it("uses a rolling window and applies manual increases without clearing previous usage", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    await asSystem(prisma).botEmailSend.createMany({
      data: [
        {
          userId,
          botId: "deleted",
          sentAt: new Date(now.getTime() - 86_400_001),
          recipientCount: 10,
        },
        { userId, botId: "other", sentAt: new Date(now.getTime() - 1_000), recipientCount: 10 },
      ],
    });
    expect(await reserve("bot", "space", undefined, undefined, now)).toBe("limit");
    await asSystem(prisma).user.update({ where: { id: userId }, data: { botEmailDailyLimit: 11 } });
    expect(await reserve("bot", "space", undefined, undefined, now)).toHaveProperty("id");
    expect(await reserve("bot", "space", undefined, undefined, now)).toBe("limit");
    expect(
      await reserve("bot", "space", undefined, undefined, new Date(now.getTime() + 86_400_001)),
    ).toHaveProperty("id");
  });
});
