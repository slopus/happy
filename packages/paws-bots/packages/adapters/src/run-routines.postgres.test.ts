import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  createDb,
  createPendingSteeringRun,
  provisionMessagingIdentity,
  runAsSystem,
  SpaceDeletionInProgressError,
  sendUserMessage,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("routine tick prompt and model consistency (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-prompt-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine prompt fixture", () =>
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

  it("runs the prompt that was saved with the model it claims", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "OLD recipient",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: dueAt,
        modelProvider: "prov-a",
        modelId: "model-A",
      },
    });
    // The editor changes the prompt and the model but leaves nextRunAt alone,
    // so the tick's claim still matches; it must not pair the old prompt with
    // the new model. The edit lands right before the claim, after the tick
    // has already read the routine.
    const realTransaction = system.$transaction.bind(system);
    let editBeforeClaim: (() => Promise<unknown>) | null = async () => {
      await system.routine.update({
        where: { id: routine.id },
        data: { prompt: "CORRECTED recipient", modelProvider: "prov-b", modelId: "model-B" },
      });
    };
    const hooked = Object.create(system) as PrismaClient;
    hooked.$transaction = ((
      fn: Parameters<typeof realTransaction>[0],
      options?: Parameters<typeof realTransaction>[1],
    ) => {
      const edit = editBeforeClaim;
      editBeforeClaim = null;
      return (edit ? edit() : Promise.resolve()).then(() => realTransaction(fn, options));
    }) as PrismaClient["$transaction"];
    const executor = createRunExecutor({
      prisma: hooked,
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

    await executor.wakeRoutine(routine.id, dueAt.toISOString());

    const run = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    const task = await system.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.prompt).toContain("CORRECTED");
    expect(run).toMatchObject({ modelProvider: "prov-b", modelId: "model-B", modelPinned: true });
  });

  it("runs no routine in a Space that is being deleted", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: dueAt,
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
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}`,
      },
    });
    try {
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }

    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(0);
  });

  it("neither retries a routine nor takes a message in a Space that is being deleted", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "report", status: "failed" },
    });
    const failed = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "failed",
        trigger: "routine",
        routineId: routine.id,
      },
    });
    const enqueued: string[] = [];
    const executor = createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async (job: { name: string }) => {
          enqueued.push(job.name);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}:attempt`,
      },
    });
    let sent: Promise<unknown>;
    try {
      await executor.retryRoutineRun(failed.id);
      sent = sendUserMessage(system, {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
        userId: identity.userId,
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "webhook",
      });
      await sent.catch(() => undefined);
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }

    expect({
      retries: await system.run.count({ where: { retryOfRunId: failed.id } }),
      messageRuns: await system.run.count({
        where: { threadId: identity.threadId, trigger: "webhook" },
      }),
      enqueued,
    }).toEqual({ retries: 0, messageRuns: 0, enqueued: [] });
    await expect(sent).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
  });

  function testExecutor(enqueued: string[] = []) {
    return createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async (job: { name: string }) => {
          enqueued.push(job.name);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
  }

  async function queuedRun(trigger: string) {
    const task = await system.task.create({
      data: { ...identity, prompt: trigger, status: "queued" },
    });
    return system.run.create({
      data: { ...identity, taskId: task.id, status: "queued", trigger },
    });
  }

  const claimed = {
    deletingAt: new Date(),
    deletionClaimId: `organization-deletion:${randomUUID()}:test`,
  };
  async function settle() {
    await system.space.update({
      where: { id: identity.spaceId },
      data: { deletingAt: null, deletionClaimId: null },
    });
    await system.run.updateMany({
      where: { threadId: identity.threadId, status: { in: ["queued", "leased", "running"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId: identity.botId } });
  }

  /**
   * Runs `work` while a deletion claim of the Space is written under the Space's lock but not yet
   * committed, the way claiming a Space for deletion does; the claim commits once `work` has had
   * time to read the Space.
   */
  async function duringUncommittedClaim<T>(work: () => Promise<T>) {
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((done) => {
      locked = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    const claim = system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.spaceId}, 0))::text AS "lock"`;
        await tx.space.update({ where: { id: identity.spaceId }, data: claimed });
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await lockTaken;
    const outcome = work().then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((done) => setTimeout(done, 300));
    release();
    await claim;
    return outcome;
  }

  /** Opens a transaction that runs `hold`, then waits until `release` is called to commit. */
  function heldTransaction(hold: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let ready!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((done) => {
      ready = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    const committed = system.$transaction(
      async (tx) => {
        await hold(tx);
        ready();
        await released;
      },
      { timeout: 30_000 },
    );
    return { holding, release, committed };
  }

  const pause = () => new Promise((done) => setTimeout(done, 300));

  it("holds a follow-up while the Space is being deleted and recovers it when that is called off", async () => {
    // Earlier tests leave queued runs in the thread, and any live run holds the follow-up.
    await settle();
    const busy = await queuedRun("routine");
    try {
      // A webhook delivery waits behind the routine turn as steering.
      await sendUserMessage(system, {
        ...identity,
        blocks: [{ kind: "text", text: "held" }],
        prompt: "held",
        trigger: "webhook",
      });
      await system.space.update({ where: { id: identity.spaceId }, data: claimed });
      // The routine turn finishes while the organization deletion waits on billing.
      await system.run.update({ where: { id: busy.id }, data: { status: "cancelled" } });
      const followUp = await system.$transaction((tx) => createPendingSteeringRun(tx, identity));
      if (followUp) await testExecutor().continueRun(followUp, "worker-deleting");
      const held = followUp
        ? (await system.run.findUniqueOrThrow({ where: { id: followUp } })).status
        : null;

      // Billing cancellation fails and releases the claim; recovery starts the follow-up.
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
      const published: BackgroundJob[] = [];
      const jobs = {
        enqueue: async (job: BackgroundJob) => {
          published.push(job);
        },
        enqueueIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      };
      await runAsSystem("reconcile jobs", () =>
        createJobReconciler({ prisma: db.prisma, jobs }, { maxPagesPerPass: 1000 }).reconcileOnce(),
      );

      expect({
        held,
        recovered: published.some(
          (job) =>
            job.name === "run.continue" && (job.payload as { runId?: string }).runId === followUp,
        ),
      }).toEqual({ held: "queued", recovered: true });
    } finally {
      await settle();
    }
  });

  it("starts no run when the deletion claim commits while the lease waits for the run row", async () => {
    await settle();
    const queued = await queuedRun("user");
    try {
      const row = heldTransaction(
        (tx) => tx.$queryRaw`SELECT id FROM runs WHERE id = ${queued.id} FOR UPDATE`,
      );
      await row.holding;
      const claim = heldTransaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.spaceId}, 0))::text AS "lock"`;
        await tx.space.update({ where: { id: identity.spaceId }, data: claimed });
      });
      await claim.holding;
      const started = testExecutor()
        .continueRun(queued.id, "worker-racing")
        .catch(() => undefined);
      await pause();
      claim.release();
      await claim.committed;
      await pause();
      row.release();
      await row.committed;
      await started;

      expect((await system.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
        "queued",
      );
    } finally {
      await settle();
    }
  });

  it("keeps a transcript message that starts no run in a Space that is being deleted", async () => {
    await settle();
    try {
      await system.space.update({ where: { id: identity.spaceId }, data: claimed });
      await expect(
        sendUserMessage(system, {
          ...identity,
          blocks: [{ kind: "text", text: "mirrored" }],
          prompt: "mirrored",
          trigger: "messaging",
          createRun: false,
        }),
      ).resolves.toMatchObject({ runId: null });
    } finally {
      await settle();
    }
  });

  it("refuses a message when the deletion claim commits while the send is under way", async () => {
    try {
      const outcome = await duringUncommittedClaim(() =>
        sendUserMessage(system, {
          ...identity,
          blocks: [{ kind: "text", text: "racing" }],
          prompt: "racing",
          trigger: "webhook",
        }),
      );
      expect(outcome).toBeInstanceOf(SpaceDeletionInProgressError);
    } finally {
      await settle();
    }
  });

  it("neither retries nor wakes a routine when the deletion claim commits meanwhile", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "report", status: "failed" },
    });
    const failed = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "failed",
        trigger: "routine",
        routineId: routine.id,
      },
    });
    const enqueued: string[] = [];
    try {
      await duringUncommittedClaim(() => testExecutor(enqueued).retryRoutineRun(failed.id));
      await settle();
      const dueAt = new Date(Date.now() - 60_000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      await duringUncommittedClaim(() =>
        testExecutor(enqueued).wakeRoutine(routine.id, dueAt.toISOString()),
      );

      expect({
        runs: await system.run.count({
          where: { routineId: routine.id, id: { not: failed.id } },
        }),
        enqueued,
      }).toEqual({ runs: 0, enqueued: [] });
    } finally {
      await settle();
    }
  });
});
