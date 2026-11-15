import type * as DbModule from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { ComputerBusyError } from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const leases = vi.hoisted(() => ({
  acquire: vi.fn(),
  dedicated: vi.fn(),
  release: vi.fn(),
}));

const settleTakeoverCards = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  settleReleasedTakeoverCards: settleTakeoverCards,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: leases.acquire,
  acquireDedicatedScreenLeaseFence: leases.dedicated,
  releaseComputerExecutionLease: leases.release,
}));

const lease = {
  computerId: "computer-1",
  botId: "bot-1",
  runId: "run-1",
  fence: 1,
};
const sink = createTestSink();

function fixture(
  options: {
    startedAt?: Date;
    switching?: boolean;
    dedicated?: boolean;
    heldBy?: string;
    checkpoint?: string;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    status: "queued",
    leaseFence: 0,
    checkpoint: options.checkpoint ?? null,
    startedAt: options.startedAt ?? null,
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased" })),
      updateMany: vi.fn(async (_args: { data: { startedAt?: Date } }) => ({
        count: 1,
      })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        computerId: "computer-1",
        computerSwitching: options.switching ?? false,
        computer: { scope: options.dedicated ? "dedicated" : "team" },
      })),
    },
    computerExecutionLease: {
      findFirst: vi.fn(async () => (options.heldBy ? { id: options.heldBy } : null)),
    },
    // Stop at attempt setup so the fixture exercises only the real startup path.
    attempt: {
      create: vi.fn(async () => Promise.reject(new Error("attempt setup failed"))),
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    prisma,
    enqueue,
    start: () => executor.continueRun("run-1", "worker-1"),
  };
}

describe("execution start timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sink.events.length = 0;
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    leases.acquire.mockResolvedValue(lease);
    leases.release.mockResolvedValue(undefined);
  });

  afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

  it.each(["busy", "switching"])(
    "does not report execution while the computer is %s",
    async (state) => {
      if (state === "busy") leases.acquire.mockRejectedValue(new ComputerBusyError());
      const { prisma, enqueue, start } = fixture({
        switching: state === "switching",
      });
      await start();
      expect(
        prisma.run.updateMany.mock.calls.every(([args]) => args.data.startedAt === undefined),
      ).toBe(true);
      expect(sink.events.some((event) => event.message === "run.execution_started")).toBe(false);
      expect(prisma.attempt.create).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledOnce();
    },
  );

  it("waits without a retry timer while another run of the bot holds the computer", async () => {
    leases.acquire.mockRejectedValue(new ComputerBusyError());
    const { prisma, enqueue, start } = fixture({ heldBy: "lease-of-run-0" });
    await start();
    expect(enqueue).not.toHaveBeenCalled();
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "queued", wakeAt: null }),
      }),
    );
  });

  it.each([undefined, new Date("2026-01-01T00:00:00Z")])(
    "stamps execution after acquiring the computer and preserves the first start (%s)",
    async (startedAt) => {
      const { prisma, start } = fixture({ startedAt });
      leases.acquire.mockImplementation(async () => {
        expect(
          prisma.run.updateMany.mock.calls.every(([args]) => args.data.startedAt === undefined),
        ).toBe(true);
        expect(sink.events).toEqual([]);
        return lease;
      });
      await expect(start()).rejects.toThrow("attempt setup failed");
      expect(prisma.run.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "run-1",
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        data: { startedAt: startedAt ?? expect.any(Date) },
      });
      expect(sink.events.filter((event) => event.message === "run.execution_started")).toHaveLength(
        1,
      );
      expect(leases.release).toHaveBeenCalledWith(prisma, lease);
    },
  );

  it.each(["lost fence", "database error"])(
    "releases a dedicated computer if the start update encounters %s",
    async (failure) => {
      const { prisma, start } = fixture({ dedicated: true });
      leases.acquire.mockResolvedValue(null);
      leases.dedicated.mockImplementation(async () => {
        // Dedicated acquisition requires running status but must precede the timestamp.
        expect(prisma.run.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: { status: "running" } }),
        );
        return lease;
      });
      prisma.run.updateMany.mockImplementation(async (args) => {
        if (!args.data.startedAt) return { count: 1 };
        if (failure === "database error") throw new Error("database unavailable");
        return { count: 0 };
      });
      if (failure === "database error")
        await expect(start()).rejects.toThrow("database unavailable");
      else await start();
      expect(leases.release).toHaveBeenCalledWith(prisma, lease);
      expect(prisma.attempt.create).not.toHaveBeenCalled();
      expect(sink.events.some((event) => event.message === "run.execution_started")).toBe(false);
    },
  );
});

it("stops a superseded claim before it settles the new attempt's takeover cards", async () => {
  vi.clearAllMocks();
  settleTakeoverCards.mockRejectedValue(new RunHistoryWriteError());
  const { prisma, start } = fixture({ checkpoint: "takeover-skipped" });
  await start();
  expect(settleTakeoverCards).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({ runId: "run-1", lease: { owner: "worker-1", fence: 1 } }),
    expect.any(Function),
  );
  expect(leases.acquire).not.toHaveBeenCalled();
  expect(prisma.attempt.create).not.toHaveBeenCalled();
});
