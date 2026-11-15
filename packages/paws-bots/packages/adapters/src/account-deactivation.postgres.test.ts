import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  cancelDeactivatedAccountRuns,
  createDb,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

type Identity = { userId: string; spaceId: string; botId: string; threadId: string };

describePostgres("a deactivated account's work (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const identities: Identity[] = [];
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);

  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    for (const identity of identities) {
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  async function person(): Promise<Identity> {
    const { userId, spaceId, botId, threadId } = await runAsSystem("deactivation fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address: `deactivation-${randomUUID()}@rakazo.test` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const identity = { userId, spaceId, botId, threadId };
    identities.push(identity);
    return identity;
  }
  async function run(identity: Identity, status: string) {
    const task = await system.task.create({
      data: { ...identity, prompt: "fixture", status: "queued" },
    });
    return system.run.create({
      data: { ...identity, taskId: task.id, trigger: "chat", status },
    });
  }
  const deactivate = (identity: Identity, at: Date | null = new Date()) =>
    system.user.update({ where: { id: identity.userId }, data: { deactivatedAt: at } });
  const status = async (runId: string) =>
    (await system.run.findUniqueOrThrow({ where: { id: runId } })).status;
  const executor = () =>
    createRunExecutor({
      prisma: system,
      jobs: {
        enqueue,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

  it("cancels only a deactivated account's active runs, and nothing once it is back", async () => {
    const alice = await person();
    const bob = await person();
    const queued = await run(alice, "queued");
    const waiting = await run(alice, "waiting_input");
    const done = await run(alice, "completed");
    const others = await run(bob, "queued");

    const announce = vi.fn(async (_threadId: string, _seq: number) => undefined);
    expect(await cancelDeactivatedAccountRuns(system, { notify: announce }, alice.userId)).toBe(0);
    expect(await status(queued.id)).toBe("queued");

    await deactivate(alice);
    expect(await cancelDeactivatedAccountRuns(system, { notify: announce }, alice.userId)).toBe(1);
    expect(announce).toHaveBeenCalledExactlyOnceWith(alice.threadId, expect.any(Number));
    expect(await status(queued.id)).toBe("cancelled");
    expect(await status(waiting.id)).toBe("cancelled");
    expect(await status(done.id)).toBe("completed");
    expect(await status(others.id)).toBe("queued");
    const cancelled = await system.event.findMany({
      where: { runId: { in: [queued.id, waiting.id] }, type: "run.cancelled" },
    });
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]?.payload).toMatchObject({ reason: "account_deactivated" });
    expect(await system.task.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("starts a teammate's follow-up that waited behind a stopped run", async () => {
    const erin = await person();
    const teammate = await person();
    const running = await run(erin, "running");
    const message = await system.message.create({
      data: {
        threadId: erin.threadId,
        seq: 1_000,
        role: "user",
        authorUserId: teammate.userId,
        blocks: [{ kind: "text", text: "Also this" }],
      },
    });
    await system.steeringMessage.create({
      data: { messageId: message.id, botId: erin.botId, userId: teammate.userId },
    });
    await deactivate(erin);

    expect(await cancelDeactivatedAccountRuns(system, { notify }, erin.userId)).toBe(1);
    expect(await status(running.id)).toBe("cancelled");
    expect(
      await system.run.findFirstOrThrow({ where: { threadId: erin.threadId, status: "queued" } }),
    ).toMatchObject({ userId: teammate.userId, sourceMessageId: message.id });
  });

  it("announces each chat whose runs were stopped, even when a later chat fails", async () => {
    const dana = await person();
    const helper = await createRepos(system).createBot(
      { userId: dana.userId, spaceId: dana.spaceId, email: "", isDeploymentOwner: false },
      { name: "Helper", description: "", instructions: "", notifyOnFinish: false },
    );
    const second = await system.thread.findFirstOrThrow({ where: { botId: helper.id } });
    await run(dana, "queued");
    await run({ ...dana, botId: helper.id, threadId: second.id }, "queued");
    await deactivate(dana);
    let transactions = 0;
    const failingSecond = new Proxy(system, {
      get(target, key, receiver) {
        if (key !== "$transaction") return Reflect.get(target, key, receiver);
        return (...args: Parameters<PrismaClient["$transaction"]>) => {
          if (++transactions === 2) return Promise.reject(new Error("connection lost"));
          return target.$transaction(...args);
        };
      },
    });
    const announce = vi.fn(async (_threadId: string, _seq: number) => undefined);

    await expect(
      cancelDeactivatedAccountRuns(failingSecond, { notify: announce }, dana.userId),
    ).rejects.toThrow("connection lost");
    expect(announce).toHaveBeenCalledOnce();
  });

  it("cancels a deactivated account's run when a worker picks it up, before it starts", async () => {
    const carol = await person();
    const queued = await run(carol, "queued");
    await deactivate(carol);
    notify.mockClear();

    await executor().continueRun(queued.id, "worker-1");

    const row = await system.run.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row).toMatchObject({ status: "cancelled", leaseOwner: null, startedAt: null });
    expect(await system.attempt.count({ where: { runId: queued.id } })).toBe(0);
    expect(notify).toHaveBeenCalledWith(carol.threadId, expect.any(Number));
  });

  it("skips a deactivated owner's routine occurrence and resumes after reactivation", async () => {
    const dana = await person();
    const due = new Date(Date.now() - 1_000);
    const routine = await system.routine.create({
      data: {
        ...dana,
        name: "every minute",
        prompt: "check in",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: due,
      },
    });
    await deactivate(dana);
    enqueue.mockClear();

    await executor().wakeRoutine(routine.id, due.toISOString());

    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
    const skipped = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(skipped.active).toBe(true);
    expect(skipped.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
    // Its next occurrence is still woken on time.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "routine.wakeup", availableAt: skipped.nextRunAt }),
    );

    // Back on, the next due occurrence runs.
    await deactivate(dana, null);
    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: due } });
    await executor().wakeRoutine(routine.id, due.toISOString());
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });

  it("keeps a watching routine's checks scheduled while its owner is deactivated", async () => {
    const erin = await person();
    const due = new Date(Date.now() - 1_000);
    const routine = await system.routine.create({
      data: {
        ...erin,
        name: "watch a file",
        prompt: "tell me what changed",
        crons: [],
        watch: { kind: "files", paths: ["notes.md"], everyMinutes: 15 },
        active: true,
        nextRunAt: due,
      },
    });
    await deactivate(erin);

    await executor().wakeRoutine(routine.id, due.toISOString());

    const skipped = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(skipped.active).toBe(true);
    expect(skipped.nextRunAt!.getTime()).toBeGreaterThanOrEqual(due.getTime() + 15 * 60_000);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
  });

  it("keeps a routine with a broken watch checking while its owner is deactivated", async () => {
    const fay = await person();
    const due = new Date(Date.now() - 1_000);
    const routine = await system.routine.create({
      data: {
        ...fay,
        name: "broken watch",
        prompt: "tell me what changed",
        crons: [],
        watch: { kind: "files" },
        active: true,
        nextRunAt: due,
      },
    });
    await deactivate(fay);

    await executor().wakeRoutine(routine.id, due.toISOString());

    const skipped = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(skipped.active).toBe(true);
    expect(skipped.nextRunAt!.getTime()).toBeGreaterThanOrEqual(due.getTime() + 15 * 60_000);
  });
});
