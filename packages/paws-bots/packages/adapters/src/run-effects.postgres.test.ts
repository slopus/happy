import { randomUUID } from "node:crypto";
import { createDb, createThreadEvents, RunHistoryWriteError, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { claimEffect, recordEffect } from "./run-effects.js";
import { withRunLease } from "./run-messages.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("tool effects under the run lease (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const id = `effect-lease-${randomUUID()}`;
  const spaceId = `${id}-space`;
  const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  let run: { id: string; spaceId: string; threadId: string; botId: string };

  beforeAll(async () => {
    run = await fixture(async () => {
      const userId = `${id}-user`;
      const organizationId = `${id}-org`;
      await prisma.user.create({
        data: { id: userId, name: "Effect tester", email: `${id}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Effect tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Effect tests" } });
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: "Effects",
          color: "ink",
          thread: { create: { spaceId, userId } },
        },
        include: { thread: true },
      });
      const threadId = bot.thread!.id;
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId,
          prompt: "Effect test",
          status: "running",
        },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user_message",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        select: { id: true, spaceId: true, threadId: true, botId: true },
      });
    });
  });

  afterAll(async () => {
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  });

  const attempt = (owner: string, fence: number) =>
    withRunLease(
      { prisma, events: createThreadEvents(prisma) } as unknown as ExecutorDeps,
      run.id,
      { owner, fence },
    );
  const send = vi.fn();
  // A tool records its effect, then reaches outside Rakazo.
  const sendTool = (deps: ExecutorDeps, key: string) =>
    runAsSystem("agent run tool call", async () => {
      const applied = await recordEffect(deps, run, "send_fixture", key, { to: key });
      send(key);
      return applied;
    });
  const takeOver = (owner: string, fence: number) =>
    fixture(() =>
      prisma.run.update({ where: { id: run.id }, data: { leaseOwner: owner, leaseFence: fence } }),
    );
  const effectCount = (idempotencyKey: string) =>
    fixture(() => prisma.externalEffect.count({ where: { idempotencyKey } }));

  it("runs the tool for the attempt that holds the lease", async () => {
    const applied = await sendTool(attempt("worker-1", 1), `${id}-current`);
    expect(applied.effect.status).toBe("intended");
    expect(send).toHaveBeenCalledWith(`${id}-current`);
    expect(
      await runAsSystem("agent run tool call", () =>
        claimEffect(attempt("worker-1", 1), run.id, applied.effect.id, "intended"),
      ),
    ).toBe(true);
  });

  it("refuses a superseded attempt's effect before the tool reaches outside", async () => {
    const stale = attempt("worker-1", 1);
    const pending = await sendTool(stale, `${id}-pending`);
    send.mockClear();
    await takeOver("worker-2", 2);

    await expect(sendTool(stale, `${id}-superseded`)).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(send).not.toHaveBeenCalled();
    expect(await effectCount(`${id}-superseded`)).toBe(0);

    await expect(
      runAsSystem("agent run tool call", () =>
        claimEffect(stale, run.id, pending.effect.id, "intended"),
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    const unclaimed = await fixture(() =>
      prisma.externalEffect.findUniqueOrThrow({ where: { id: pending.effect.id } }),
    );
    expect(unclaimed.status).toBe("intended");

    await sendTool(attempt("worker-2", 2), `${id}-takeover`);
    expect(send).toHaveBeenCalledWith(`${id}-takeover`);
  });
});
