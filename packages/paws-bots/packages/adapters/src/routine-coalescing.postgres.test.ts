import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { findPendingRoutineTick, routineTimerNonce } from "./routine-coalescing.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
describePostgres("routine timer coalescing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine coalescing fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
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
        name: "timer fixture",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
      },
    });
    const config = { ...identity, routineId: routine.id, prompt: "fixture" };
    async function create(tx: Prisma.TransactionClient, clientNonce: string | null) {
      const task = await tx.task.create({
        data: { ...identity, prompt: "fixture", status: "queued" },
      });
      return tx.run.create({
        data: {
          ...identity,
          routineId: routine.id,
          taskId: task.id,
          trigger: "routine",
          status: "queued",
          clientNonce,
        },
      });
    }
    return { routine, config, create };
  }

  it("serializes concurrent ticks into one pending catch-up", async () => {
    const { routine, config, create } = await fixture();
    const tick = (index: number) =>
      system.$transaction(async (tx) => {
        await tx.routine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
        return (
          (await findPendingRoutineTick(tx, config)) ??
          create(tx, routineTimerNonce(routine.id, `tick-${index}`))
        );
      });
    const results = await Promise.all([tick(1), tick(2)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });
  it("preserves ambiguous legacy runs even with scheduled firing events", async () => {
    const { config, create } = await fixture();
    const legacy = await system.$transaction((tx) => create(tx, null));
    await appendEvent(system, {
      spaceId: identity.spaceId,
      threadId: identity.threadId,
      botId: identity.botId,
      type: "routine.fired",
      runId: legacy.id,
      payload: { routineId: config.routineId, scheduledFor: "2026-01-01T00:00:00Z" },
    });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    expect(await system.run.findUnique({ where: { id: legacy.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("preserves a queued one-shot when its routine is edited into a recurring timer", async () => {
    const { routine, create } = await fixture();
    const scheduledAt = new Date(Date.now() - 1_000);
    await system.routine.update({
      where: { id: routine.id },
      data: {
        crons: [ONCE_ROUTINE_CRON],
        nextRunAt: scheduledAt,
      },
    });
    const executor = createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.wakeRoutine(routine.id, scheduledAt.toISOString());
    const oneShot = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    expect(oneShot.clientNonce).toBeNull();
    let duplicateId: string | null = null;
    for (let tick = 0; tick < 3; tick++) {
      const dueAt = new Date(scheduledAt.getTime() + tick);
      await system.routine.update({
        where: { id: routine.id },
        data: {
          crons: ["* * * * *"],
          active: true,
          nextRunAt: dueAt,
        },
      });
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      if (tick === 0) {
        const duplicate = await system.$transaction((tx) =>
          create(tx, routineTimerNonce(routine.id, "duplicate")),
        );
        duplicateId = duplicate.id;
      }
    }
    expect(await system.run.findUnique({ where: { id: oneShot.id } })).toMatchObject({
      status: "queued",
    });
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(3);
    expect(await system.run.findUnique({ where: { id: duplicateId! } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await system.run.count({
        where: {
          routineId: routine.id,
          status: "queued",
          clientNonce: { startsWith: `routine-timer:${routine.id}:` },
        },
      }),
    ).toBe(1);
    expect(await system.event.count({ where: { runId: oneShot.id, type: "run.cancelled" } })).toBe(
      0,
    );
  });
  it("keeps an existing busy-computer delay on a reused run", async () => {
    const { config, create, routine } = await fixture();
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "tick")),
    );
    const wakeAt = new Date(Date.now() + 60_000);
    const updated = await system.run.update({ where: { id: pending.id }, data: { wakeAt } });
    await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      wakeAt,
      updatedAt: updated.updatedAt,
    });
  });
  it("cancels redundant recurring ticks without touching an actual attempt", async () => {
    const { config, create, routine } = await fixture();
    const older = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "older")),
    );
    const duplicate = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "duplicate")),
    );
    const attempted = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "attempted")),
    );
    await system.attempt.create({ data: { runId: attempted.id, fence: 1, status: "running" } });
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.id).toBe(older.id);
    expect(reused?.cancelledEvents).toHaveLength(1);
    expect(await system.run.findUnique({ where: { id: duplicate.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.task.findUnique({ where: { id: duplicate.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await system.event.count({ where: { runId: duplicate.id, type: "run.cancelled" } }),
    ).toBe(1);
    expect(await system.run.findUnique({ where: { id: attempted.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("drains a bounded recurring batch within the default transaction deadline", async () => {
    const { routine, config } = await fixture();
    const rows = Array.from({ length: 100 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
    await system.task.createMany({
      data: rows.map(({ taskId }) => ({
        ...identity,
        id: taskId,
        status: "queued",
        prompt: "fixture",
      })),
    });
    await system.run.createMany({
      data: rows.map(({ id, taskId }, index) => ({
        ...identity,
        id,
        taskId,
        routineId: routine.id,
        trigger: "routine",
        status: "queued",
        clientNonce: routineTimerNonce(routine.id, `tick-${index}`),
      })),
    });
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.cancelledEvents).toHaveLength(99);
    expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(1);
    expect(await system.run.count({ where: { routineId: routine.id, status: "cancelled" } })).toBe(
      99,
    );
  });
  it("finds pending recurring work behind over a page of ambiguous legacy rows", async () => {
    const { routine, config, create } = await fixture();
    const rows = Array.from({ length: 120 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
    await system.task.createMany({
      data: rows.map(({ taskId }) => ({
        ...identity,
        id: taskId,
        status: "queued",
        prompt: "fixture",
      })),
    });
    await system.run.createMany({
      data: rows.map(({ id, taskId }) => ({
        ...identity,
        id,
        taskId,
        routineId: routine.id,
        trigger: "routine",
        status: "queued",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "tick")),
    );
    for (let tick = 0; tick < 3; tick++) {
      expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toMatchObject({
        id: pending.id,
      });
    }
    expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(
      121,
    );
    expect(await system.run.count({ where: { routineId: routine.id, status: "cancelled" } })).toBe(
      0,
    );
  });
  it.each(["leased", "completed"])(
    "preserves an already %s run when its publication rejects",
    async (status) => {
      const { routine } = await fixture();
      const dueAt = new Date(Date.now() - 1_000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      const published: string[] = [];
      const executor = createRunExecutor({
        prisma: system,
        jobs: {
          enqueue: async (job: BackgroundJob) => {
            published.push(job.name);
            if (job.name !== "run.continue") return;
            // Emulate the independent dispatcher winning before notification fails.
            const dispatched = await system.run.update({
              where: { id: job.payload.runId },
              data: {
                status,
                leaseFence: 1,
                ...(status === "leased"
                  ? { leaseOwner: "fixture-worker" }
                  : { completedAt: new Date() }),
              },
            });
            if (status === "completed") {
              await system.task.update({
                where: { id: dispatched.taskId },
                data: { status: "completed" },
              });
            }
            throw new Error("notification failed after dispatch");
          },
          cancel: async () => undefined,
          close: async () => undefined,
        },
        events: {
          append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
          notify: async () => undefined,
        },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      const surviving = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
      expect(surviving.status).toBe(status);
      expect(await system.task.findUnique({ where: { id: surviving.taskId } })).toMatchObject({
        status: status === "completed" ? "completed" : "queued",
      });
      expect(
        (
          await system.routine.findUniqueOrThrow({ where: { id: routine.id } })
        ).nextRunAt!.getTime(),
      ).toBeGreaterThan(dueAt.getTime());
      expect(published).toEqual(["run.continue", "routine.wakeup"]);
      // Retrying the original occurrence is now a safe no-op, not a nonce conflict.
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
    },
  );
  it("preserves work reused by a later tick before the original publication rejects", async () => {
    const { routine } = await fixture();
    const dueAt = new Date(Date.now() - 1_000);
    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
    const clock = vi.spyOn(Date, "now");
    let laterTickFired = false;
    let advancedSchedule: Date | null = null;
    let reusedId: string | null = null;
    let executor: ReturnType<typeof createRunExecutor>;
    executor = createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async (job: BackgroundJob) => {
          if (job.name !== "run.continue" || laterTickFired) return;
          reusedId = job.payload.runId;
          laterTickFired = true;
          const afterFirstTick = await system.routine.findUniqueOrThrow({
            where: { id: routine.id },
          });
          // The first publication stalls until the next natural occurrence is due.
          clock.mockReturnValue(afterFirstTick.nextRunAt!.getTime() + 1_000);
          await executor.wakeRoutine(routine.id, afterFirstTick.nextRunAt!.toISOString());
          advancedSchedule = (await system.routine.findUniqueOrThrow({ where: { id: routine.id } }))
            .nextRunAt;
          throw new Error("first publication failed after catch-up reuse");
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    try {
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      expect(laterTickFired).toBe(true);
      const surviving = await system.run.findUniqueOrThrow({ where: { id: reusedId! } });
      expect(surviving).toMatchObject({ status: "queued", leaseFence: 0 });
      expect(await system.task.findUnique({ where: { id: surviving.taskId } })).toMatchObject({
        status: "queued",
      });
      expect(
        (await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).nextRunAt,
      ).toEqual(advancedSchedule);
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
