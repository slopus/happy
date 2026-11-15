import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;

dbTests("operator bot email policy command", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const command = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "apps/api/src/cli/bot-email-policy.ts", ...args], {
      env: process.env,
    });

  it("changes limits and reply access, records the operator change, and does not reactivate an account", async () => {
    const prisma = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const deactivatedAt = new Date("2026-11-01T00:00:00Z");
    await prisma.user.create({ data: { id: userId, name: "Fixture", email, deactivatedAt } });
    try {
      expect((await command("status", email)).stdout).toContain(
        "Daily recipient allowance: 10\nExternal replies: off",
      );
      expect((await command("limit", email.toUpperCase(), "20")).stdout).toContain(
        "Daily recipient allowance: 20",
      );
      expect((await command("replies", email, "on")).stdout).toContain("External replies: on");
      expect((await command("replies", email, "off")).stdout).toContain("External replies: off");
      expect((await command("limit", email, "0")).stdout).toContain("Daily recipient allowance: 0");
      expect((await command("allow", email, "reports@Example.test")).stdout).toContain(
        "Approved recipients: 1",
      );
      expect((await command("allow", email, "reports@example.test")).stdout).toContain(
        "Approved recipients: 1",
      );
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).botEmailAllowedRecipients,
      ).toEqual(["reports@example.test"]);
      expect((await command("deny", email, "reports@example.test")).stdout).toContain(
        "Approved recipients: 0",
      );
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.deactivatedAt).toEqual(deactivatedAt);
      expect(user.botEmailDailyLimit).toBe(0);
      expect(user.botEmailRepliesEnabled).toBe(false);
      const events = await prisma.securityEvent.findMany({
        where: { userId, type: "bot_email.policy.changed" },
      });
      expect(events).toHaveLength(7);
      const recipientEvents = events
        .map((event) => event.metadata as Record<string, unknown>)
        .filter((metadata) => metadata.recipient !== undefined);
      expect(recipientEvents).toHaveLength(3);
      expect(recipientEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            change: "allow",
            recipient: "reports@example.test",
            changed: true,
          }),
          expect.objectContaining({
            change: "allow",
            recipient: "reports@example.test",
            changed: false,
          }),
          expect.objectContaining({
            change: "deny",
            recipient: "reports@example.test",
            changed: true,
          }),
        ]),
      );
      expect(events.map((event) => event.metadata)).toContainEqual({
        by: "operator",
        previousLimit: 10,
        previousReplies: false,
        limit: 20,
        replies: false,
        recipientCount: 0,
        previousRecipientCount: 0,
        change: "limit",
        changed: true,
      });
    } finally {
      await prisma.securityEvent.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it("refuses a grant when the selected account changes email before its lock is acquired", async () => {
    const prisma = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await prisma.user.create({ data: { id: userId, name: "Fixture", email } });
    let pending: Promise<{ error?: { stderr: string }; stdout?: string }> | undefined;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "user" WHERE id=${userId} FOR UPDATE`;
          // The first lookup can read the old email, but the command must then wait on our lock.
          pending = command("allow", email, "reports@example.test").catch((error) => ({ error }));
          await expect
            .poll(
              async () => {
                const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE 'SELECT id FROM "user"%FOR NO KEY UPDATE%'`;
                return Number(row!.waiting);
              },
              { timeout: 30_000 },
            )
            .toBeGreaterThan(0);
          await tx.user.update({ where: { id: userId }, data: { email: `changed-${email}` } });
        },
        { timeout: 40_000 },
      );
      const result = await pending!;
      expect(result.error?.stderr).toContain("Account email changed while waiting");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).botEmailAllowedRecipients,
      ).toEqual([]);
      expect(
        await prisma.securityEvent.count({ where: { userId, type: "bot_email.policy.changed" } }),
      ).toBe(0);
    } finally {
      await pending;
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it("rejects invalid policy arguments", async () => {
    for (const args of [
      ["limit", "fixture@example.test", "-1"],
      ["limit", "fixture@example.test", "1001"],
      ["limit", "fixture@example.test", "NaN"],
      ["replies", "fixture@example.test", "true"],
      ["status", "fixture@example.test", "extra"],
      ["allow", "fixture@example.test", "invalid"],
      ["deny", "fixture@example.test", "invalid"],
    ])
      await expect(command(...args)).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Usage:"),
      });
  });
});
