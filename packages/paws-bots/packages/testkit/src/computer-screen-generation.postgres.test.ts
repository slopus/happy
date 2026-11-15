import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("computer screen generation (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let computerId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("screen generation fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address: `screen-${randomUUID()}@example.test` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    computerId = bot.computerId!;
  });

  afterAll(async () => close?.());

  const update = (data: { state?: string; providerRef?: string | null; kind?: string }) =>
    prisma.computer.update({ where: { id: computerId }, data });

  it("keeps the generation through repeated saves of the same running machine", async () => {
    const initial = await update({ state: "running", providerRef: "machine-a", kind: "fake" });
    for (const state of ["suspending", "running", "suspending", "running"]) {
      expect((await update({ state })).screenGeneration).toBe(initial.screenGeneration);
    }
    expect((await update({ providerRef: "machine-a" })).screenGeneration).toBe(
      initial.screenGeneration,
    );
  });

  it.each(["suspended", "stopped", "error"])(
    "keeps old links revoked after %s and a restart with the same reference",
    async (state) => {
      const initial = await update({ state: "running", providerRef: "machine-a", kind: "fake" });
      await update({ state: "suspending" });
      const stopped = await update({ state });
      expect(stopped.screenGeneration).toBe(initial.screenGeneration + 1);
      const booting = await update({ state: "booting" });
      expect(booting.screenGeneration).toBe(stopped.screenGeneration + 1);
      const running = await update({ state: "running" });
      expect(running.screenGeneration).toBe(booting.screenGeneration);
      expect((await update({ state: "suspending" })).screenGeneration).toBe(
        running.screenGeneration,
      );
    },
  );

  it.each(["running", "suspending"])("revokes reference changes while %s", async (state) => {
    const initial = await update({ state, providerRef: "machine-a", kind: "fake" });
    const replaced = await update({
      state: state === "running" ? "suspending" : "running",
      providerRef: "machine-b",
    });
    expect(replaced.screenGeneration).toBe(initial.screenGeneration + 1);
    const destroyed = await update({ providerRef: null });
    expect(destroyed.screenGeneration).toBe(replaced.screenGeneration + 1);
    expect((await update({ providerRef: "machine-a" })).screenGeneration).toBe(
      destroyed.screenGeneration + 1,
    );
  });

  it("revokes a provider change even when its reference and active states match", async () => {
    const initial = await update({ state: "running", providerRef: "machine-a", kind: "fake" });
    const changed = await update({ state: "suspending", kind: "none" });
    expect(changed.screenGeneration).toBe(initial.screenGeneration + 1);
    expect((await update({ state: "running" })).screenGeneration).toBe(changed.screenGeneration);
  });
});
