import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;
dbTests("operator model credit cap command", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const command = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "apps/api/src/cli/model-credit-cap.ts", ...args], {
      env: process.env,
    });

  it("sets an exact dollar amount, reports it, and clears it without reactivating the account", async () => {
    const prisma = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const deactivatedAt = new Date("2026-11-01T00:00:00Z");
    await prisma.user.create({ data: { id: userId, name: "Fixture", email, deactivatedAt } });
    try {
      expect((await command("set", email.toUpperCase(), "2.000001")).stdout).toContain(
        "Cap: $2.000001",
      );
      const status = (await command("status", email)).stdout;
      expect(status).toContain("Remaining: $2.000001");
      expect(status).toContain("Usage before per-user credit journaling is excluded.");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).deactivatedAt,
      ).toEqual(deactivatedAt);
      expect((await command("clear", email)).stdout).toContain("Cap: none");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).modelCreditCapMicros,
      ).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it("rejects invalid amounts and accidental extra arguments", async () => {
    for (const args of [
      ["set", "fixture@example.test", "-2"],
      ["set", "fixture@example.test", "10000.000001"],
      ["set", "fixture@example.test", "NaN"],
      ["clear", "fixture@example.test", "2"],
    ]) {
      await expect(command(...args)).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Usage:"),
      });
    }
  });
});
