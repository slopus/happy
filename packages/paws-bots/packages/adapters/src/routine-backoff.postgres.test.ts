import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  backOffRoutineAfterAccountError,
  clearRoutineBackoff,
  routineAccountBackoffMs,
} from "./routine-backoff.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("backing off a routine on refused model accounts (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-backoff-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem("routine backoff fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = { userId, spaceId, botId, threadId };
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Every minute",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: new Date(Math.ceil(Date.now() / 60_000) * 60_000),
      },
    });
    const enqueue = vi.fn(async () => undefined);
    const deps = {
      prisma: system,
      jobs: { enqueue, enqueueIn: vi.fn(), cancelIn: vi.fn(), cancel: vi.fn(), close: vi.fn() },
    };
    return { routine, deps, enqueue };
  }

  it("counts every concurrent failure and holds the schedule for the last count", async () => {
    const { routine, deps } = await fixture();
    const now = new Date();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        backOffRoutineAfterAccountError(
          deps,
          { routineId: routine.id, userId: routine.userId },
          now,
        ),
      ),
    );

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.accountFailures).toBe(4);
    expect(row.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + routineAccountBackoffMs(4),
    );
    expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(
      now.getTime() + routineAccountBackoffMs(4) + 60_000,
    );
  });

  it("returns a held routine to its cadence once a run gets through", async () => {
    const { routine, deps } = await fixture();
    for (let count = 0; count < 3; count++) {
      await backOffRoutineAfterAccountError(deps, {
        routineId: routine.id,
        userId: routine.userId,
      });
    }

    await clearRoutineBackoff(deps, { routineId: routine.id, userId: routine.userId });

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.accountFailures).toBe(0);
    expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});
