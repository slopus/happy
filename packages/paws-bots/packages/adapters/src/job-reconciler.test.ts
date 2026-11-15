import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { stuckWorkStatusMessages } from "@rakazo/core";
import type { Pool, PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import type { ReconciliationLeadership } from "./job-reconciler.js";
import { createJobReconciler, createPostgresReconciliationLeadership } from "./job-reconciler.js";
import { loopGuardStopText } from "./tool-loop.js";

vi.mock("./bot-messages.js", () => ({ returnBotMessageOutcome: vi.fn() }));
vi.mock("./background-helpers.js", () => ({ returnHelperOutcome: vi.fn() }));

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
  const jobs: JobPublisher = {
    enqueue,
    enqueueIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function fakePrisma(
  runs: Array<{
    id: string;
    status: string;
    updatedAt: Date;
    wakeAt?: Date | null;
    botId?: string;
    bot?: { computerId: string | null };
  }> = [],
  routines: Array<{ id: string; nextRunAt: Date | null }> = [],
  controls: Array<{
    id: string;
    controlBotId: string | null;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
    updatedAt: Date;
  }> = [],
) {
  return {
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => []) },
    run: { findMany: vi.fn(async () => runs) },
    routine: { findMany: vi.fn(async () => routines) },
    computer: { findMany: vi.fn(async () => controls) },
  } as unknown as PrismaClient;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createJobReconciler", () => {
  it("continues the main scans when an auxiliary reconciler fails", async () => {
    const prisma = fakePrisma();
    const { jobs } = publisher();
    const reconcileCloudAgents = vi.fn(async () => {
      throw new Error("cloud unavailable");
    });
    const reconcileComputerUpdates = vi.fn(() => {
      throw new Error("queue unavailable");
    });
    const reconcileRoutineRetryNotices = vi.fn(async () => undefined);
    await createJobReconciler({
      prisma,
      jobs,
      reconcileRoutineRetryNotices,
      reconcileCloudAgents,
      reconcileComputerUpdates,
    }).reconcileOnce();
    expect(reconcileRoutineRetryNotices).toHaveBeenCalledOnce();
    expect(reconcileCloudAgents).toHaveBeenCalledOnce();
    expect(reconcileComputerUpdates).toHaveBeenCalledOnce();
    expect(prisma.run.findMany).toHaveBeenCalled();
    expect(prisma.routine.findMany).toHaveBeenCalled();
    expect(prisma.computer.findMany).toHaveBeenCalled();
  });

  it("keeps recovering due work while an auxiliary reconciler hangs", async () => {
    const prisma = fakePrisma([], [{ id: "routine-due", nextRunAt: new Date() }]);
    const { jobs, enqueue } = publisher();
    const storage = deferred();
    const reconcileHomeStorage = vi.fn(() => storage.promise);
    const reconciler = createJobReconciler({ prisma, jobs, reconcileHomeStorage });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    const wakeups = enqueue.mock.calls.filter(([job]) => job.name === "routine.wakeup");
    expect(wakeups).toHaveLength(2);
    // A pass still running is not started again.
    expect(reconcileHomeStorage).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    storage.resolve();
    await stopping;
  });

  it("waits for housekeeping a pass starts after stop was called", async () => {
    const { jobs } = publisher();
    const acquired = deferred();
    const storage = deferred();
    const leadership: ReconciliationLeadership = {
      tryAcquire: vi.fn(async () => {
        await acquired.promise;
        return true;
      }),
      release: vi.fn(async () => undefined),
    };
    const reconcileHomeStorage = vi.fn(() => storage.promise);
    const reconciler = createJobReconciler({
      prisma: fakePrisma(),
      jobs,
      leadership,
      reconcileHomeStorage,
    });

    const pass = reconciler.reconcileOnce();
    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    acquired.resolve();
    await pass;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reconcileHomeStorage).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    expect(leadership.release).not.toHaveBeenCalled();
    storage.resolve();
    await stopping;
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("runs the chat delivery sweep on every pass, beside the scans", async () => {
    const prisma = fakePrisma([], [{ id: "routine-due", nextRunAt: new Date() }]);
    const { jobs, enqueue } = publisher();
    const reconcileChatDelivery = vi.fn(async () => undefined);
    const reconciler = createJobReconciler({ prisma, jobs, reconcileChatDelivery });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(reconcileChatDelivery).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.filter(([job]) => job.name === "routine.wakeup")).toHaveLength(2);
  });

  it("restores queued runs and near-due routines with stable replacement keys", async () => {
    const scheduledFor = new Date(Date.now() + 30_000);
    const controlExpiresAt = new Date(Date.now() + 15_000);
    const prisma = fakePrisma(
      [{ id: "run-1", status: "queued", updatedAt: new Date() }],
      [{ id: "routine-1", nextRunAt: scheduledFor }],
      [
        {
          id: "computer-1",
          controlBotId: "bot-1",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: controlExpiresAt,
          updatedAt: new Date(),
        },
      ],
    );
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-1" },
      replaceKey: "run:run-1",
      keepExisting: true,
      replaceLockedBefore: expect.any(Date),
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledFor.toISOString() },
      availableAt: scheduledFor,
      replaceKey: "routine:routine-1",
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-1", leaseId: "lease-1" },
      availableAt: controlExpiresAt,
      replaceKey: "computer.control-expire:computer-1:lease-1",
    });
    expect(vi.mocked(prisma.computer.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { controlLeaseId: { not: null } },
            {
              OR: [
                { controlLeaseExpiresAt: null },
                { controlLeaseExpiresAt: { lte: expect.any(Date) } },
              ],
            },
          ],
        },
        orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("leaves queued resource waits untouched and recovers them after release", async () => {
    const run = {
      id: "run-waiting",
      status: "queued",
      wakeAt: null,
      updatedAt: new Date(Date.now() - 60_000),
      botId: "bot-1",
      bot: { computerId: "computer-1" },
    };
    const prisma = fakePrisma([run]);
    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([
      {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-holder",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ] as never);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(prisma.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { botId: { in: ["bot-1"] }, expiresAt: { gt: expect.any(Date) } },
      select: { computerId: true, botId: true, runId: true, expiresAt: true },
    });

    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([]);
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: run.id },
        keepExisting: true,
      }),
    );
  });

  it.each([
    { computerId: "computer-1", botId: "bot-1", runId: "run-lost" },
    { computerId: "old-computer", botId: "bot-1", runId: "run-holder" },
    { computerId: "computer-1", botId: "other-bot", runId: "run-holder" },
  ])("recovers a lost queued run with a nonblocking lease %j", async (lease) => {
    const prisma = fakePrisma([
      {
        id: "run-lost",
        status: "queued",
        wakeAt: null,
        updatedAt: new Date(),
        botId: "bot-1",
        bot: { computerId: "computer-1" },
      },
    ]);
    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([
      { ...lease, expiresAt: new Date(Date.now() + 60_000) },
    ] as never);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "run-lost" },
        keepExisting: true,
      }),
    );
  });

  it.each([
    { holder: [], blocks: false },
    { holder: [{ id: "run-holder", status: "cancelled" }], blocks: false },
    { holder: [{ id: "run-holder", status: "waiting_takeover" }], blocks: true },
  ])("frees a takeover hold only once its run is gone or ended %j", async ({ holder, blocks }) => {
    const waiting = {
      id: "run-waiting",
      status: "queued",
      wakeAt: null,
      updatedAt: new Date(Date.now() - 60_000),
      botId: "bot-1",
      bot: { computerId: "computer-1" },
    };
    const prisma = fakePrisma([waiting]);
    vi.mocked(prisma.run.findMany).mockImplementation((async (args: { where: { id?: unknown } }) =>
      args.where.id ? holder : [waiting]) as never);
    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([
      {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-holder",
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    ] as never);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    Object.assign(prisma.computerExecutionLease, { updateMany });
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    const recovered = expect.objectContaining({
      name: "run.continue",
      payload: { runId: waiting.id },
    });
    if (blocks) {
      expect(updateMany).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalledWith(recovered);
    } else {
      expect(updateMany).toHaveBeenCalledWith({
        where: { runId: { in: ["run-holder"] }, expiresAt: { gt: expect.any(Date) } },
        data: { expiresAt: new Date(0) },
      });
      expect(enqueue).toHaveBeenCalledWith(recovered);
    }
  });

  it("replaces any lock for an expired lease but only an old lock for a queued run", async () => {
    const prisma = fakePrisma([
      { id: "run-queued", status: "queued", updatedAt: new Date() },
      { id: "run-expired", status: "running", updatedAt: new Date() },
    ]);
    const { jobs, enqueue } = publisher();
    const before = Date.now();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    const cutoff = (runId: string) => {
      const job = enqueue.mock.calls
        .map(([queued]) => queued)
        .find((queued) => queued.name === "run.continue" && queued.payload.runId === runId);
      return job?.name === "run.continue" ? job.replaceLockedBefore?.getTime() : undefined;
    };
    expect(cutoff("run-expired")).toBeGreaterThanOrEqual(before);
    expect(cutoff("run-queued")).toBeLessThanOrEqual(Date.now() - 5 * 60_000);
    expect(cutoff("run-queued")).toBeGreaterThanOrEqual(before - 5 * 60_000);
  });

  it("restores expiry for orphaned user-control leases without a control bot", async () => {
    const controlExpiresAt = new Date(Date.now() - 5_000);
    const prisma = fakePrisma(
      [],
      [],
      [
        {
          id: "computer-orphan",
          controlBotId: null,
          controlLeaseId: "lease-orphan",
          controlLeaseExpiresAt: controlExpiresAt,
          updatedAt: new Date(),
        },
      ],
    );
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-orphan", leaseId: "lease-orphan" },
      availableAt: controlExpiresAt,
      replaceKey: "computer.control-expire:computer-orphan:lease-orphan",
    });
  });

  it("finishes a frozen control scan before admitting leases ahead of its cursor", async () => {
    const firstExpiry = new Date(Date.now() + 10_000);
    const secondExpiry = new Date(Date.now() + 20_000);
    const controls = [
      {
        id: "computer-1",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
        controlLeaseExpiresAt: firstExpiry,
      },
      {
        id: "computer-2",
        controlBotId: "bot-2",
        controlLeaseId: "lease-2",
        controlLeaseExpiresAt: secondExpiry,
      },
      {
        id: "computer-3",
        controlBotId: "bot-3",
        controlLeaseId: "lease-3",
        controlLeaseExpiresAt: null,
      },
    ];
    const computerFindMany = vi
      .fn()
      .mockResolvedValueOnce(controls.slice(0, 2))
      .mockResolvedValueOnce(controls.slice(2))
      .mockResolvedValueOnce([
        {
          id: "computer-0",
          controlBotId: "bot-0",
          controlLeaseId: "lease-0",
          controlLeaseExpiresAt: firstExpiry,
        },
      ]);
    const prisma = {
      run: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: computerFindMany },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(computerFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          expect.anything(),
          {
            OR: [
              { controlLeaseExpiresAt: { gt: secondExpiry } },
              { controlLeaseExpiresAt: secondExpiry, id: { gt: "computer-2" } },
              { controlLeaseExpiresAt: null },
            ],
          },
        ],
      },
    });
    const firstDeadline =
      computerFindMany.mock.calls[0]?.[0].where.AND[1].OR[1].controlLeaseExpiresAt.lte;
    const secondDeadline =
      computerFindMany.mock.calls[1]?.[0].where.AND[1].OR[1].controlLeaseExpiresAt.lte;
    expect(secondDeadline).toEqual(firstDeadline);
    expect(computerFindMany.mock.calls[2]?.[0].where.AND).toHaveLength(2);
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: { computerId: "computer-0", leaseId: "lease-0" },
      }),
    );
  });

  it("advances stable cursors so recoverable work beyond one batch is dispatched", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const runs = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index + 1}`,
      updatedAt: at,
    }));
    const routines = Array.from({ length: 5 }, (_, index) => ({
      id: `routine-${index + 1}`,
      nextRunAt: new Date(at.getTime() + index),
    }));
    const runPages = [runs.slice(0, 2), runs.slice(2, 4), runs.slice(4)];
    let runPage = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      // The stuck-work scan is the only run query that looks at takeover waits.
      if (JSON.stringify(args.where).includes("waiting_takeover")) return [];
      return runPages[runPage++] ?? [];
    });
    const routineFindMany = vi
      .fn()
      .mockResolvedValueOnce(routines.slice(0, 2))
      .mockResolvedValueOnce(routines.slice(2, 4))
      .mockResolvedValueOnce(routines.slice(4));
    const prisma = {
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      run: { findMany: runFindMany },
      routine: { findMany: routineFindMany },
      computer: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual([
      "run:run-1",
      "run:run-2",
      "routine:routine-1",
      "routine:routine-2",
      "run:run-3",
      "run:run-4",
      "routine:routine-3",
      "routine:routine-4",
      "run:run-5",
      "routine:routine-5",
    ]);
    expect(runFindMany.mock.calls[3]?.[0]).toMatchObject({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: "run-2" } }],
          },
        ],
      },
    });
    expect(routineFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [
              { nextRunAt: { gt: routines[1]?.nextRunAt } },
              {
                nextRunAt: routines[1]?.nextRunAt,
                id: { gt: "routine-2" },
              },
            ],
          },
        ],
      },
    });
  });

  it("publishes a thousand due routines in one bounded pass", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `routine-${String(index).padStart(4, "0")}`,
      nextRunAt: at,
    }));
    const prisma = fakePrisma();
    const findMany = vi.mocked(prisma.routine.findMany);
    findMany.mockImplementation(((args: Parameters<typeof prisma.routine.findMany>[0]) => {
      const filters = args?.where?.AND as Array<{ OR?: Array<{ id?: { gt: string } }> }>;
      const after = filters[1]?.OR?.[1]?.id?.gt;
      return Promise.resolve(rows.filter((row) => !after || row.id > after).slice(0, 100));
    }) as typeof prisma.routine.findMany);
    const { jobs, enqueue } = publisher();
    const auxiliary = vi.fn(async () => undefined);
    await createJobReconciler({ prisma, jobs, reconcileCloudAgents: auxiliary }).reconcileOnce();
    expect(enqueue).toHaveBeenCalledTimes(1_000);
    expect(new Set(enqueue.mock.calls.map(([job]) => job.replaceKey)).size).toBe(1_000);
    expect(findMany).toHaveBeenCalledTimes(10);
    expect(prisma.computer.findMany).toHaveBeenCalledOnce();
    // The stuck-work and run scans run once each.
    expect(prisma.run.findMany).toHaveBeenCalledTimes(2);
    expect(auxiliary).toHaveBeenCalledOnce();
  });

  it("resumes after its page budget without rescanning completed categories", async () => {
    const prisma = fakePrisma();
    const at = new Date();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `routine-${i}`, nextRunAt: at }));
    const findMany = vi.mocked(prisma.routine.findMany);
    findMany.mockImplementation(((args: Parameters<typeof prisma.routine.findMany>[0]) => {
      const filters = args?.where?.AND as Array<{ OR?: Array<{ id?: { gt: string } }> }>;
      const after = filters[1]?.OR?.[1]?.id?.gt;
      return Promise.resolve(rows.filter((row) => !after || row.id > after).slice(0, 2));
    }) as typeof prisma.routine.findMany);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 2 });
    await reconciler.reconcileOnce();
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(prisma.computer.findMany).toHaveBeenCalledOnce();
    await reconciler.reconcileOnce();
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual(
      rows.map((row) => `routine:${row.id}`),
    );
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("settles every publication before rejecting and retries the same page", async () => {
    const at = new Date();
    const prisma = fakePrisma(
      [],
      [
        { id: "routine-1", nextRunAt: at },
        { id: "routine-2", nextRunAt: at },
      ],
    );
    const { jobs, enqueue } = publisher();
    const pending = deferred();
    enqueue
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockImplementationOnce(() => pending.promise);
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });
    let settled = false;
    const first = reconciler.reconcileOnce().catch((error) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    const overlap = reconciler.reconcileOnce().catch(() => undefined);
    pending.resolve();
    expect(await first).toEqual(new Error("queue unavailable"));
    await overlap;
    await reconciler.reconcileOnce();
    expect(prisma.routine.findMany).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prisma.routine.findMany).mock.calls[1]?.[0]?.where?.AND).toHaveLength(1);
    expect(enqueue.mock.calls.slice(0, 2)).toEqual(enqueue.mock.calls.slice(2));
  });

  it("stops between pages after in-flight publication and then releases leadership", async () => {
    const prisma = fakePrisma([], [{ id: "routine-1", nextRunAt: new Date() }]);
    const pending = deferred();
    const { jobs, enqueue } = publisher();
    enqueue.mockImplementation(() => pending.promise);
    const leadership = {
      tryAcquire: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const reconciler = createJobReconciler({ prisma, jobs, leadership }, { batchSize: 1 });
    const first = reconciler.reconcileOnce();
    const overlap = reconciler.reconcileOnce();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    const stop = reconciler.stop();
    expect(leadership.release).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([first, overlap, stop]);
    await reconciler.reconcileOnce();
    expect(prisma.routine.findMany).toHaveBeenCalledOnce();
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("checks leadership again before starting another page", async () => {
    const prisma = fakePrisma([], [{ id: "routine-1", nextRunAt: new Date() }]);
    const { jobs, enqueue } = publisher();
    const leadership = {
      tryAcquire: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      release: vi.fn(),
    };
    await createJobReconciler({ prisma, jobs, leadership }, { batchSize: 1 }).reconcileOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(leadership.tryAcquire).toHaveBeenCalledTimes(2);
  });

  it("does not scan when another replica is the reconciliation leader", async () => {
    const prisma = fakePrisma();
    const leadership: ReconciliationLeadership = {
      tryAcquire: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    };
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs, leadership });

    await reconciler.reconcileOnce();
    await reconciler.stop();

    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("retries terminal bot outcomes that were not returned", async () => {
    const terminalRun = {
      id: "run-terminal",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    let terminalScan = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.trigger === "bot_message") {
        terminalScan += 1;
        return terminalScan === 2 ? [] : [terminalRun];
      }
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Finished." }], clientNonce: null },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true).mockResolvedValueOnce(false);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(runFindMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        where: {
          trigger: "bot_message",
          botOutcomeReturnedAt: null,
          OR: [
            { status: { in: ["completed", "failed"] } },
            { status: "cancelled", error: { in: [...stuckWorkStatusMessages()] } },
          ],
        },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Finished.",
      "result",
      { forceUnread: false },
    );
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: terminalRun.id, botOutcomeReturnedAt: null },
        data: { updatedAt: expect.any(Date) },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledTimes(2);
  });

  it("moves a helper whose result cannot go back yet behind the others", async () => {
    const stuck = { id: "helper-stuck", status: "completed", error: null };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) =>
      args.where?.trigger === "helper" ? [stuck] : [],
    );
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnHelperOutcome).mockRejectedValueOnce(new Error("deadlock"));

    await createJobReconciler({ prisma, jobs, events }).reconcileOnce();

    expect(returnHelperOutcome).toHaveBeenCalledOnce();
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: { id: "helper-stuck", botOutcomeReturnedAt: null },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("prefers the latest final reply over earlier untagged narration", async () => {
    const terminalRun = {
      id: "run-takeover",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Opening the calendar app…" }],
            clientNonce: null,
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
      { forceUnread: false },
    );
  });

  it("recovers a completed loop-guard stop as an unread result", async () => {
    const terminalRun = {
      id: "run-loop-guard",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const stuckText = loopGuardStopText("search", { key: undefined, count: 8 });
    const prisma = {
      run: {
        findMany: vi.fn(async (args: { where?: Record<string, unknown> } = {}) =>
          args.where?.trigger === "bot_message" ? [terminalRun] : [],
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Searching…" }], clientNonce: null },
          { blocks: [{ kind: "text", text: stuckText }], clientNonce: null },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    await createJobReconciler({ prisma, jobs, events }).reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      stuckText,
      "result",
      { forceUnread: true },
    );
  });

  it("prefers the final reply over progress when reconciling", async () => {
    const terminalRun = {
      id: "run-mixed",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-mixed:0",
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
      { forceUnread: false },
    );
  });

  it("returns progress-only transcripts as status", async () => {
    const terminalRun = {
      id: "run-progress",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-progress:0",
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Checking calendars…",
      "status",
      { forceUnread: false },
    );
  });

  it.each(["cancelled", "failed"])("returns a %s peer run as unread status", async (status) => {
    const terminalRun = {
      id: "run-stuck",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status,
      error: stuckWorkStatusMessages()[0],
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    await createJobReconciler({ prisma, jobs, events }).reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      status === "failed"
        ? `Could not complete the delegated request: ${stuckWorkStatusMessages()[0]}`
        : stuckWorkStatusMessages()[0],
      "status",
      { forceUnread: true },
    );
    expect(prisma.message.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ runId: expect.anything() }) }),
    );
  });
});

describe("createPostgresReconciliationLeadership", () => {
  it("retains leadership for one replica and transfers it after release", async () => {
    let locked = false;
    const clients: Array<{
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              const acquired = !locked;
              if (acquired) locked = true;
              return { rows: [{ acquired }] };
            }
            const released = locked;
            locked = false;
            return { rows: [{ released }] };
          }),
          release: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
        };
        clients.push(client);
        return client;
      }),
    } as unknown as Pick<Pool, "connect">;
    const first = createPostgresReconciliationLeadership(pool);
    const second = createPostgresReconciliationLeadership(pool);

    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(second.tryAcquire()).resolves.toBe(false);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]?.release).toHaveBeenCalledOnce();

    await first.release();
    await expect(second.tryAcquire()).resolves.toBe(true);
    expect(clients[0]?.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(clients[0]?.release).toHaveBeenCalledWith(false);
  });
});
