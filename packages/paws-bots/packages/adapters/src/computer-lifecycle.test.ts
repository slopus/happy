import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  CommandRequest,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  SandboxAllowanceUsedError,
  SandboxDamagedError,
  SandboxSizeUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { clearThread, planComputerSize } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  computerSupportsTerminal,
  computerSupportsUpdate,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  replaceComputer,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { SandboxUnsafeStopError } from "./sandbox-errors.js";

// The plan's size is read from billing, which these Prisma doubles do not model.
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  planComputerSize: vi.fn(async () => "standard"),
}));

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("computer provisioning", () => {
  it("provisions a Private Computer with Wuying selected", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-private-provision-"));
    const ref: ComputerRef = {
      id: "computer-1",
      botId: "bot-1",
      kind: "wuying",
      providerRef: "ecd-fake",
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...ref,
          homeKey: "bot-1",
          scope: "dedicated",
          state: "stopped",
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      computerRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const provision = vi.fn().mockResolvedValue(ref);
    const sandbox = {
      describe: () => ({ id: "wuying" }),
      provision,
      prepare: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).resolves.toEqual(ref);
      expect(provision).toHaveBeenCalledOnce();
      expect(prisma.computer.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: "running" }) }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("starts a computer in its owner's time zone and language, or the provider's defaults", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-owner-locale-"));
    const ref: ComputerRef = {
      id: "computer-1",
      botId: "bot-1",
      kind: "docker",
      providerRef: "box-1",
    };
    const provisioned = async (findUnique: () => Promise<unknown>) => {
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...ref,
            userId: "owner-1",
            homeKey: "bot-1",
            scope: "dedicated",
            state: "stopped",
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        computerRun: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        user: { findUnique: vi.fn(findUnique) },
      } as unknown as PrismaClient;
      const provision = vi.fn().mockResolvedValue(ref);
      const sandbox = {
        describe: () => ({ id: "docker" }),
        provision,
        prepare: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxProvider;
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      // The computer's owner, not whoever started this run.
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "owner-1" } }),
      );
      return provision.mock.calls[0]?.[0] as Record<string, unknown>;
    };

    try {
      expect(
        await provisioned(async () => ({ timezone: "Europe/Warsaw", locale: "pt-BR" })),
      ).toMatchObject({ timezone: "Europe/Warsaw", language: "pt-BR" });
      for (const owner of [
        async () => ({ timezone: null, locale: null }),
        async () => null,
        async () => {
          throw new Error("database unavailable");
        },
      ]) {
        const request = await provisioned(owner);
        expect(request).not.toHaveProperty("timezone");
        expect(request).not.toHaveProperty("language");
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("stops a provider when archive invalidates its boot claim", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-race-"));
    const stop = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const computerRow = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "cloud",
      scope: "dedicated",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...computerRow })),
        updateMany: vi.fn(async (args) => {
          const result = await updateMany(args);
          if (result.count === 1) {
            Object.assign(
              computerRow,
              { updatedAt: new Date(computerRow.updatedAt.getTime() + 1) },
              args.data,
            );
          }
          return result;
        }),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue({
        id: "provider-1",
        botId: "bot-1",
        kind: "cloud",
        providerRef: "provider-1",
      }),
      prepare: vi.fn().mockResolvedValue(undefined),
      stop,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("Computer is busy");
      expect(releaseScreen).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(prisma.computer.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            maintenanceId: null,
            id: "computer-1",
            state: "booting",
            updatedAt: expect.any(Date),
            providerRef: "provider-1",
            kind: "cloud",
            bots: { some: { id: "bot-1", archivedAt: null } },
          },
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim abandoned booting when a live foreign lease exists", async () => {
    // Live foreign lease present: Prisma matches the booting reclaim only when the where
    // requires no live leases (heldByNobodyElse(null)). Returning count:0 for any expiresAt
    // filter would ignore a missing expiresAt.gt and a missing NOT for the caller's own lease.
    function matchesLiveLeasePredicate(
      none: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } } | undefined,
      own?: { runId: string; fence: number },
    ) {
      const gt = none?.expiresAt?.gt;
      if (!(gt instanceof Date)) return false;
      if (!own) return none?.NOT == null;
      return none?.NOT?.runId === own.runId && none?.NOT?.fence === own.fence;
    }

    const updateMany = vi.fn().mockImplementation(
      async (args: {
        where: {
          state?: string;
          updatedAt?: Date;
          executionLeases?: {
            none?: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } };
          };
        };
      }) => {
        if (args.where.state !== "booting") return { count: 1 };
        const none = args.where.executionLeases?.none;
        // Simulate a live foreign lease: only a correct "no other live lease" predicate fails the claim.
        return { count: matchesLiveLeasePredicate(none) ? 0 : 1 };
      },
    );
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };

    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(provisionComputer(deps, "computer-1", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "booting",
          updatedAt: row.updatedAt,
          executionLeases: { none: { expiresAt: { gt: expect.any(Date) } } },
        }),
      }),
    );

    updateMany.mockClear();
    updateMany.mockImplementation(
      async (args: {
        where: {
          state?: string;
          executionLeases?: {
            none?: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } };
          };
        };
      }) => {
        if (args.where.state !== "booting") return { count: 1 };
        const none = args.where.executionLeases?.none;
        return {
          count: matchesLiveLeasePredicate(none, { runId: "run-1", fence: 3 }) ? 0 : 1,
        };
      },
    );
    const setTimeoutReal2 = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal2(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(
        provisionComputer(deps, "computer-1", {
          ...context,
          screenLeaseId: "run-1:3",
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "booting",
          updatedAt: row.updatedAt,
          executionLeases: {
            none: {
              expiresAt: { gt: expect.any(Date) },
              NOT: { runId: "run-1", fence: 3 },
            },
          },
        }),
      }),
    );
  });

  it("reclaims a stale suspending computer after the wait times out", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-stale-suspend-reclaim-"));
    const observed = new Date("2024-01-01T00:00:00.000Z");
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "suspending",
      controlLeaseId: null,
      updatedAt: observed,
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    );
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const claim = updateMany.mock.calls[0]?.[0] as {
        where: { state?: string; updatedAt?: Date };
      };
      expect(claim.where.state).toBe("suspending");
      expect(claim.where.updatedAt).toEqual(observed);
      expect(row.state).toBe("running");
    } finally {
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a suspending claim that ages past the TTL during the wait", async () => {
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const ttlMs = 5 * 60_000;
    const updateMany = vi.fn();
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "cloud",
          scope: "dedicated",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: new Date(nowMs - ttlMs + 1),
        })),
        updateMany,
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    // First Date.now() is the first-observation stale check (still live). Later calls sit
    // past the TTL so a post-wait re-check would wrongly reclaim an in-flight suspend.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(nowMs)
      .mockReturnValue(nowMs + 2);
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox: {} as SandboxProvider,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not reclaim a fresh suspending claim after waiting", async () => {
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const updateMany = vi.fn();
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "cloud",
          scope: "dedicated",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: new Date(nowMs),
        })),
        updateMany,
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox: {} as SandboxProvider,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects booting discovered only after waiting on suspending", async () => {
    const updateMany = vi.fn();
    const rowSuspending = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "suspending",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const rowBooting = {
      ...rowSuspending,
      state: "booting",
      updatedAt: new Date("2024-01-01T00:00:01.000Z"),
    };
    let reads = 0;
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => {
          reads += 1;
          // First read is suspending; wait loop then observes another caller's booting claim.
          return reads === 1 ? { ...rowSuspending } : { ...rowBooting };
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(provisionComputer(deps, "computer-1", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not adopt a concurrent reclaim stamp after claiming", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-claim-stamp-race-"));
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
        return { count: 1 };
      },
    );
    const findUniqueOrThrow = vi.fn(async () => ({ ...row }));
    const prisma = {
      computer: { findUniqueOrThrow, updateMany },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const claimData = updateMany.mock.calls[0]?.[0]?.data as { updatedAt?: Date };
      const activationWhere = updateMany.mock.calls[1]?.[0]?.where as { updatedAt?: Date };
      expect(claimData.updatedAt).toBeInstanceOf(Date);
      expect(activationWhere.updatedAt).toEqual(claimData.updatedAt);
      // Stamp must come from the claim write, not a follow-up read that a concurrent reclaim could win.
      expect(findUniqueOrThrow).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("advances the claim stamp past the observed updatedAt when the clock does not move", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-claim-stamp-skew-"));
    const observed = new Date("2024-01-01T00:00:00.000Z");
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      updatedAt: observed,
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    );
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      executionLease: {
        findFirst: vi.fn(async () => null),
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    // First Date.now() is the stale-claim check (must see the stamp older than an
    // execution-lease TTL); later calls freeze at the observed ms so the claim stamp
    // still advances by +1.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(observed.getTime() + 5 * 60_000)
      .mockReturnValue(observed.getTime());
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const claim = updateMany.mock.calls[0]?.[0] as {
        where: { updatedAt?: Date };
        data: { updatedAt?: Date };
      };
      const activationWhere = updateMany.mock.calls[1]?.[0]?.where as { updatedAt?: Date };
      expect(claim.where.updatedAt).toEqual(observed);
      expect(claim.data.updatedAt?.getTime()).toBe(observed.getTime() + 1);
      expect(activationWhere.updatedAt).toEqual(claim.data.updatedAt);
      expect(row.state).toBe("running");
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a fresh booting claim without waiting", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-fresh-boot-claim-"));
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      // Claim stamp is "now" — still inside the boot-wait window, so not abandoned.
      updatedAt: new Date(nowMs),
    };
    const updateMany = vi.fn();
    const findUniqueOrThrow = vi.fn(async () => ({ ...row }));
    const prisma = {
      computer: {
        findUniqueOrThrow,
        updateMany,
      },
      executionLease: {
        findFirst: vi.fn(async () => null),
      },
      run: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
      // Fail fast before the boot-wait poll — only the initial read, no wait loop.
      expect(findUniqueOrThrow).toHaveBeenCalledTimes(1);
      expect(row.state).toBe("booting");
    } finally {
      now.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a stale booting claim while another run still holds a live worker lease", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-stale-boot-live-run-"));
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      // Older than an execution-lease TTL — stamp looks abandoned, but the run is alive.
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const updateMany = vi.fn();
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      executionLease: {
        findFirst: vi.fn(async () => null),
      },
      run: {
        findFirst: vi.fn(async () => ({ id: "other-run" })),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          { ...context, runId: "recovering-run" },
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
      expect(prisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: "recovering-run" },
            leaseExpiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
        }),
      );
      expect(row.state).toBe("booting");
    } finally {
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("activates a boot even if another Team bot takes a lease mid-provision", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-lease-mid-boot-"));
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "team",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
        return { count: 1 };
      },
    );
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      const ref = await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        { ...context, screenLeaseId: "run-1:1" },
      );
      expect(ref.providerRef).toBeTruthy();
      expect(row.state).toBe("running");
      // Activation must not require "no other live lease" — a concurrent Team lease mid-boot
      // would otherwise block activation and the failure write, wedging the row in "booting".
      expect(updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.not.objectContaining({
            executionLeases: expect.anything(),
          }),
        }),
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    "confirmed",
    "transient",
    "unknown",
    "refused",
    "cancelled while unreachable",
    "cancelled while paused",
    "cancelled while damaged",
  ] as const)(
    "reuses a running Team Computer only when the provider confirms it runs: %s",
    async (status) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-reuse-"));
      const sandbox = new FakeSandboxProvider();
      const ref = await sandbox.provision({ botId: "team-1", homePath: dataDir }, context);
      const row = {
        id: "computer-1",
        spaceId: "workspace-1",
        userId: "user-1",
        homeKey: "team-1",
        providerRef: ref.providerRef as string | null,
        kind: "fake",
        scope: "team",
        state: "running",
        screenGeneration: 3,
        maintenanceId: null,
        controlLeaseId: null,
        runningSince: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const states: string[] = [];
      const updateMany = vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = Object.entries(where).every(
            ([key, value]) => !(key in row) || row[key as keyof typeof row] === value,
          );
          if (!matches) return { count: 0 };
          // The database trigger revokes screens on every state change except booting -> running.
          if (
            typeof data.state === "string" &&
            data.state !== row.state &&
            !(row.state === "booting" && data.state === "running")
          )
            row.screenGeneration++;
          Object.assign(row, data);
          states.push(row.state);
          return { count: 1 };
        },
      );
      const prisma = {
        computer: { findUniqueOrThrow: vi.fn(async () => ({ ...row })), updateMany },
        computerRun: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as PrismaClient;
      const provision = vi.spyOn(sandbox, "provision");
      const prepare = vi.spyOn(sandbox, "prepare");
      const isRunning = vi.spyOn(sandbox, "isRunning");
      if (status === "transient")
        isRunning.mockRejectedValueOnce(new Error("503 Service Unavailable"));
      const abort = new AbortController();
      const checkedAt: number[] = [];
      const cancel = () => abort.abort(new Error("run cancelled"));
      if (status === "unknown" || status === "cancelled while unreachable")
        isRunning.mockImplementation(async () => {
          checkedAt.push(performance.now());
          if (status !== "unknown") cancel();
          throw new Error("503 Service Unavailable");
        });
      // A status read that ignores the signal answers after the run was cancelled.
      if (status === "cancelled while paused")
        isRunning.mockImplementation(async () => {
          cancel();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return false;
        });
      if (status === "cancelled while damaged")
        prepare.mockImplementation(async () => {
          cancel();
          throw new SandboxDamagedError();
        });
      if (status === "refused")
        isRunning.mockRejectedValue(Object.assign(new Error("401 Unauthorized"), { status: 401 }));
      const deps = {
        prisma,
        sandbox,
        home: new LocalAgentHomeStore(dataDir),
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
        dataDir,
      };

      try {
        if (status.startsWith("cancelled")) {
          await expect(
            provisionComputer(deps, "computer-1", { ...context, signal: abort.signal }),
          ).rejects.toThrow("run cancelled");
          expect(isRunning).toHaveBeenCalledOnce();
          expect(provision).not.toHaveBeenCalled();
          expect(states).toEqual(status === "cancelled while damaged" ? ["running"] : []);
          expect(row.screenGeneration).toBe(3);
          return;
        }
        await provisionComputer(deps, "computer-1", context);
        if (status === "unknown") {
          expect(checkedAt[1]! - checkedAt[0]!).toBeGreaterThanOrEqual(200);
          expect(checkedAt[2]! - checkedAt[1]!).toBeGreaterThanOrEqual(600);
        }
        if (status === "unknown" || status === "refused") {
          // Like before the check: one reconnect, which revokes screens once, and the run goes on.
          // Asking again only helps when the provider could not answer.
          expect(isRunning).toHaveBeenCalledTimes(status === "unknown" ? 3 : 1);
          expect(provision).toHaveBeenCalledOnce();
          expect(row.state).toBe("running");
          expect(row.screenGeneration).toBe(4);
          return;
        }
        await Promise.all(
          ["bot-1", "bot-2"].map((botId) =>
            provisionComputer(deps, "computer-1", { ...context, botId }),
          ),
        );

        expect(isRunning).toHaveBeenCalledTimes(status === "transient" ? 4 : 3);
        expect(provision).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledTimes(3);
        expect(states).toEqual(["running", "running", "running"]);
        expect(row.screenGeneration).toBe(3);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { stage: "prepare", rollbackFails: false, providerRef: "provider-2", kind: "e2b" },
    { stage: "restore", rollbackFails: false, providerRef: "provider-2", kind: "e2b" },
    { stage: "record", rollbackFails: false, providerRef: "provider-2", kind: "e2b" },
    { stage: "restore", rollbackFails: true, providerRef: "provider-2", kind: "e2b" },
    { stage: "restore", rollbackFails: true, providerRef: "provider-2", kind: "boat" },
    { stage: "restore", rollbackFails: true, providerRef: "provider-1", kind: "e2b" },
    // A new machine under the stored name: the original is gone, so the computer is marked.
    { stage: "restore", rollbackFails: false, providerRef: "provider-1", kind: "boat" },
    { stage: "prepare", rollbackFails: true, providerRef: "provider-1", kind: "boat" },
    { stage: "mark", rollbackFails: true, providerRef: "provider-1", kind: "boat" },
  ] as const)(
    "handles a failed reconnect $stage (rollbackFails=$rollbackFails, replacement $kind/$providerRef)",
    async ({ stage, rollbackFails, providerRef, kind }) => {
      const sameName = providerRef === "provider-1" && kind === "boat";
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reconnect-rollback-"));
      const failure = new Error(`${stage} failed`);
      const rollbackError = new Error("replacement deletion failed");
      const original = {
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "boat",
        scope: "dedicated",
        state: "running",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const ref = { id: providerRef, botId: "bot-1", kind, providerRef, fresh: true };
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue(original),
          updateMany:
            stage === "record"
              ? vi
                  .fn()
                  .mockResolvedValueOnce({ count: 1 })
                  .mockRejectedValueOnce(failure)
                  .mockResolvedValue({ count: 1 })
              : vi.fn(async ({ data }) => {
                  if (stage === "mark" && data.restorePending && !data.state) throw failure;
                  return { count: 1 };
                }),
        },
      } as unknown as PrismaClient;
      const sandbox = {
        provision: vi.fn().mockResolvedValue(ref),
        prepare: stage === "prepare" ? vi.fn().mockRejectedValue(failure) : vi.fn(),
        importWorkspace: stage === "restore" ? vi.fn().mockRejectedValue(failure) : vi.fn(),
        releaseScreen: vi.fn().mockResolvedValue(undefined),
        destroy: rollbackFails ? vi.fn().mockRejectedValue(rollbackError) : vi.fn(),
        stop: vi.fn(),
      } as unknown as SandboxProvider;

      try {
        const result = provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        );
        if (rollbackFails) {
          await expect(result).rejects.toMatchObject({ errors: [failure, rollbackError] });
        } else {
          await expect(result).rejects.toBe(failure);
        }
        expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(ref, context);
        expect(sandbox.destroy).toHaveBeenCalledExactlyOnceWith(ref, context);
        expect(sandbox.stop).not.toHaveBeenCalled();
        expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
          where: {
            maintenanceId: null,
            id: "computer-1",
            state: "booting",
            providerRef: "provider-1",
            kind: "boat",
            updatedAt: expect.any(Date),
          },
          data: sameName ? { state: "error", restorePending: true } : { state: "running" },
        });
        const marks = vi
          .mocked(prisma.computer.updateMany)
          .mock.calls.flatMap(([args], index) =>
            args.data.restorePending === true && !args.data.state ? [index] : [],
          );
        if (sameName) {
          // Marked before setup or the restore can fail, and recorded even if that write failed.
          expect(marks).toEqual([1]);
          if (stage !== "mark") {
            const markedAt = vi.mocked(prisma.computer.updateMany).mock.invocationCallOrder[1]!;
            expect(markedAt).toBeLessThan(vi.mocked(sandbox.prepare).mock.invocationCallOrder[0]!);
          }
        } else {
          expect(marks).toEqual([]);
        }
        expect(original).toMatchObject({
          state: "running",
          kind: "boat",
          providerRef: "provider-1",
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("does not stop a pre-existing computer when reconnect setup fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reconnect-unowned-"));
    const failure = new Error("prepare failed");
    const original = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "boat",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const ref = {
      id: "provider-2",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "provider-2",
      fresh: false,
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(original),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockRejectedValue(failure),
      importWorkspace: vi.fn(),
      releaseScreen: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      stop: vi.fn(),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBe(failure);
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(sandbox.destroy).not.toHaveBeenCalled();
      expect(prisma.computer.update).not.toHaveBeenCalled();
      expect(prisma.computer.updateMany).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("marks a new machine under the stored name that automatic recovery creates", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-auto-recover-mark-"));
    const resumed = {
      id: "provider-1",
      botId: "bot-1",
      kind: "boat" as const,
      providerRef: "provider-1",
    };
    const replacement = { ...resumed, fresh: true };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "boat",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
          homeRevisionAt: null,
          autoRecoveredAt: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValueOnce(resumed).mockResolvedValueOnce(replacement),
      prepare: vi
        .fn()
        .mockRejectedValueOnce(new SandboxDamagedError())
        .mockRejectedValueOnce(new Error("setup failed")),
      stop: vi.fn(),
      releaseScreen: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockRejectedValue(new Error("provider deletion failed")),
    } as unknown as SandboxProvider;
    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow();
      const markIndex = updateMany.mock.calls.findIndex(
        ([args]) => args.data.restorePending === true,
      );
      expect(markIndex).toBeGreaterThan(-1);
      expect(updateMany.mock.invocationCallOrder[markIndex]).toBeLessThan(
        vi.mocked(sandbox.prepare).mock.invocationCallOrder[1]!,
      );
      expect(updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { state: "error", restorePending: true } }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not restore a new machine under the stored name once the boot claim is lost", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-mark-lost-"));
    const sandbox = new FakeSandboxProvider();
    const ref = {
      ...(await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context)),
      providerRef: "provider-1",
      kind: "boat" as const,
      fresh: true,
    };
    vi.spyOn(sandbox, "provision").mockResolvedValue(ref);
    const importWorkspace = vi.spyOn(sandbox, "importWorkspace");
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "boat",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(importWorkspace).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: "e2b" as const, providerRef: "provider-2", fresh: true, state: "running" },
    { kind: "boat" as const, providerRef: "provider-2", fresh: false, state: "running" },
    { kind: "e2b" as const, providerRef: "provider-1", fresh: false, state: "running" },
    { kind: "boat" as const, providerRef: "provider-1", fresh: true, state: "running" },
    // Taking over an abandoned boot: the provider resumes the same machine, which may be part-way.
    { kind: "boat" as const, providerRef: "provider-1", fresh: false, state: "booting" },
  ])(
    "restores saved files before starting $kind/$providerRef (fresh=$fresh) from $state",
    async ({ state, ...next }) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-reconnect-update-"));
      const home = new LocalAgentHomeStore(dataDir);
      const sandbox = new FakeSandboxProvider();
      const ref = {
        ...(await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context)),
        ...next,
      };
      vi.spyOn(sandbox, "provision").mockResolvedValue(ref);
      const prepare = vi.spyOn(sandbox, "prepare");
      const destroy = vi.spyOn(sandbox, "destroy");
      const stop = vi.spyOn(sandbox, "stop");
      const saved = new TextEncoder().encode("saved work");
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "computer-1",
            homeKey: "bot-1",
            providerRef: "provider-1",
            kind: "boat",
            scope: "dedicated",
            state,
            controlLeaseId: null,
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany: vi
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockImplementation(async ({ data }) => {
              // Only the mark comes before the restore.
              if (data.restorePending !== true)
                expect(await sandbox.readFile(ref, "notes/keep.txt", context)).toEqual(saved);
              return { count: 1 };
            }),
        },
        run: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient;

      try {
        await home.writeFile("bot-1", "notes/keep.txt", "saved work", context);
        // A takeover first waits out the abandoned boot.
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const started = provisionComputer(
          {
            prisma,
            sandbox,
            home,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        );
        let settled = false;
        void started.finally(() => {
          settled = true;
        });
        while (!settled) {
          await vi.advanceTimersByTimeAsync(250);
          await new Promise((resolve) => setImmediate(resolve));
        }
        await expect(started).resolves.toEqual(ref);
        const activation = {
          state: "running",
          providerRef: next.providerRef,
          kind: next.kind,
          restorePending: false,
          runningSince: expect.any(Date),
        };
        expect(prepare).toHaveBeenCalledWith(ref, context);
        expect(await sandbox.readFile(ref, "notes/keep.txt", context)).toEqual(saved);
        expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
          where: {
            maintenanceId: null,
            id: "computer-1",
            state: "booting",
            providerRef: "provider-1",
            kind: "boat",
            updatedAt: expect.any(Date),
            bots: { some: { id: "bot-1", archivedAt: null } },
          },
          // A start that is not a reconnect also settles who controls the screen.
          data: state === "booting" ? expect.objectContaining(activation) : activation,
        });
        // A new machine under the stored name, or a taken-over boot, is marked under the claim.
        const marks = vi
          .mocked(prisma.computer.updateMany)
          .mock.calls.filter(([args]) => args.data.restorePending === true);
        if (
          state === "booting" ||
          (next.fresh && next.providerRef === "provider-1" && next.kind === "boat")
        ) {
          expect(marks).toEqual([
            [
              {
                where: {
                  id: "computer-1",
                  state: "booting",
                  updatedAt: expect.any(Date),
                  providerRef: "provider-1",
                  kind: "boat",
                  maintenanceId: null,
                },
                data: { restorePending: true, updatedAt: expect.any(Date) },
              },
            ],
          ]);
          // Before setup, and so before the restore.
          const markIndex = vi
            .mocked(prisma.computer.updateMany)
            .mock.calls.findIndex(([args]) => args.data.restorePending === true);
          expect(
            vi.mocked(prisma.computer.updateMany).mock.invocationCallOrder[markIndex],
          ).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
        } else {
          expect(marks).toEqual([]);
        }
        expect(destroy).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  const savedAt = new Date("2024-01-01T00:20:00.000Z");
  it.each([
    {
      saved: "a timed save",
      homeRevision: "revision-1",
      homeRevisionAt: savedAt,
      expected: savedAt,
    },
    {
      saved: "a save of unknown age",
      homeRevision: "revision-1",
      homeRevisionAt: null,
      expected: undefined,
    },
    { saved: "no save", homeRevision: "empty", homeRevisionAt: savedAt, expected: undefined },
  ])("tells the provider when the workspace was saved for $saved", async (row) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-saved-at-"));
    const home = new LocalAgentHomeStore(dataDir);
    const sandbox = new FakeSandboxProvider();
    const ref = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    const provision = vi
      .spyOn(sandbox, "provision")
      .mockResolvedValue({ ...ref, kind: "boat", providerRef: "provider-1", fresh: false });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          homeRevision: row.homeRevision,
          homeRevisionAt: row.homeRevisionAt,
          providerRef: "provider-1",
          kind: "boat",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const request = provision.mock.calls[0]?.[0] as { savedAt?: Date } | undefined;
      expect(request).toBeDefined();
      expect(request?.savedAt).toEqual(row.expected);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { fresh: true, cleanup: "destroy" as const },
    { fresh: false, cleanup: "stop" as const },
  ])("rolls back $cleanup when shared preparation fails", async ({ fresh, cleanup }) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-prepare-rollback-"));
    const ref = {
      id: "provider-1",
      botId: "bot-1",
      kind: "fake" as const,
      providerRef: "provider-1",
      fresh,
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockRejectedValue(new Error("provider preparation failed"));
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: fresh ? null : "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare,
      stop,
      destroy,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("provider preparation failed");
      expect(prepare).toHaveBeenCalledWith(ref, context);
      expect(releaseScreen).toHaveBeenCalledWith(ref, context);
      expect(cleanup === "destroy" ? destroy : stop).toHaveBeenCalledWith(ref, context);
      expect(cleanup === "destroy" ? stop : destroy).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the screen when activation fails on a resumed Team computer", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-activation-rollback-"));
    const ref = {
      id: "provider-1",
      botId: "team-home",
      kind: "docker" as const,
      providerRef: "provider-1",
      fresh: false,
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "team-home",
          providerRef: "provider-1",
          kind: "docker",
          scope: "team",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(async function* () {
        yield { type: "exit", code: 0 };
      }),
      stop,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("Computer is busy");
      expect(sandbox.execute).toHaveBeenCalled();
      expect(releaseScreen).toHaveBeenCalledWith(ref, context);
      expect(stop).toHaveBeenCalledWith(ref, context);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { unsafeStop: false, reconnecting: false },
    { unsafeStop: true, reconnecting: false },
    { unsafeStop: true, reconnecting: true },
  ])(
    "retains a fresh provider reference when rollback also fails (unsafe stop=$unsafeStop, reconnecting=$reconnecting)",
    async ({ unsafeStop, reconnecting }) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-prepare-rollback-failure-"));
      const prepareError = unsafeStop
        ? new SandboxUnsafeStopError("provider preparation failed", new Error("stop unconfirmed"))
        : new Error("provider preparation failed");
      const rollbackError = new Error("provider deletion failed");
      const ref = {
        id: "new-provider-1",
        botId: "bot-1",
        kind: "e2b" as const,
        providerRef: "new-provider-1",
        fresh: true,
      };
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "computer-1",
            homeKey: "bot-1",
            providerRef: reconnecting ? "old-provider" : null,
            kind: "e2b",
            scope: "dedicated",
            state: reconnecting ? "running" : "stopped",
            controlLeaseId: null,
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany,
        },
      } as unknown as PrismaClient;
      const sandbox = {
        provision: vi.fn().mockResolvedValue(ref),
        prepare: vi.fn().mockRejectedValue(prepareError),
        destroy: vi.fn().mockRejectedValue(rollbackError),
      } as unknown as SandboxProvider;

      try {
        const result = provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        );
        await expect(result).rejects.toMatchObject({
          errors: [prepareError, rollbackError],
        });
        expect(updateMany).toHaveBeenLastCalledWith({
          where: {
            maintenanceId: null,
            id: "computer-1",
            state: "booting",
            providerRef: reconnecting ? "old-provider" : null,
            kind: "e2b",
            updatedAt: expect.any(Date),
          },
          data: {
            state: unsafeStop ? "quarantined" : "error",
            providerRef: "new-provider-1",
            kind: "e2b",
            restorePending: true,
          },
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("reports only the start failure when the provider is also down for the rollback", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-rollback-outage-"));
    const prepareError = new SandboxUnresponsiveError("provider unreachable");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "e2b",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue({
        id: "new-provider-1",
        botId: "bot-1",
        kind: "e2b",
        providerRef: "new-provider-1",
        fresh: true,
      }),
      prepare: vi.fn().mockRejectedValue(prepareError),
      destroy: vi.fn().mockRejectedValue(new SandboxUnresponsiveError("provider unreachable")),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBe(prepareError);
      expect(updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "error",
            providerRef: "new-provider-1",
            kind: "e2b",
          }),
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "preserves a running computer's files on ordinary reconnect (prepare fails=%s)",
    async (prepareFails) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-reconnect-"));
      const ref = {
        id: "provider-1",
        botId: "bot-1",
        kind: "cloud" as const,
        providerRef: "provider-1",
        fresh: false,
      };
      const prepare = prepareFails
        ? vi.fn().mockRejectedValue(new Error("provider preparation failed"))
        : vi.fn().mockResolvedValue(undefined);
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "computer-1",
            homeKey: "bot-1",
            providerRef: "provider-1",
            kind: "cloud",
            scope: "dedicated",
            state: "running",
            controlLeaseId: null,
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
      } as unknown as PrismaClient;
      const sandbox = {
        provision: vi.fn().mockResolvedValue(ref),
        prepare,
        importWorkspace: vi.fn(),
        destroy: vi.fn(),
        stop: vi.fn(),
      } as unknown as SandboxProvider;

      try {
        const result = provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        );
        if (prepareFails) {
          await expect(result).rejects.toThrow("provider preparation failed");
        } else {
          await expect(result).resolves.toEqual(ref);
        }
        expect(prepare).toHaveBeenCalledWith(ref, context);
        expect(sandbox.importWorkspace).not.toHaveBeenCalled();
        expect(sandbox.destroy).not.toHaveBeenCalled();
        expect(sandbox.stop).not.toHaveBeenCalled();
        expect(prisma.computer.updateMany).toHaveBeenCalledTimes(2);
        expect(prisma.computer.update).not.toHaveBeenCalled();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("restores the workspace and records the new reference when reconnect replaces the sandbox", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reconnect-replacement-"));
    const ref = {
      id: "provider-2",
      botId: "bot-1",
      kind: "createos" as const,
      providerRef: "provider-2",
      fresh: true,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const importWorkspace = vi.fn().mockResolvedValue(undefined);
    const exportHome = vi.fn().mockReturnValue((async function* () {})());
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "createos",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
        update: vi.fn(),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockResolvedValue(undefined),
      importWorkspace,
      destroy: vi.fn(),
      stop: vi.fn(),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: { exportHome } as unknown as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).resolves.toEqual(ref);
      expect(importWorkspace).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledTimes(2);
      expect(updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "running",
            providerRef: "provider-2",
            kind: "createos",
          }),
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("Team Computer wake", () => {
  function isFolderListing(request: CommandRequest) {
    return request.argv[0] === "bash" && request.argv.length === 4;
  }

  function wakeHarness(
    state: "stopped" | "running",
    findMany = vi.fn().mockResolvedValue([{ id: "deleted-bot" }]),
    provisioned: Partial<ComputerRef> = {},
    stored: Record<string, unknown> = {},
  ) {
    const ref = {
      id: "sandbox-1",
      botId: "team-workspace-1",
      kind: "e2b" as const,
      providerRef: "sandbox-1",
      fresh: false,
      ...provisioned,
    };
    const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
      // The cleanup first lists what is on the computer.
      if (isFolderListing(request)) yield { type: "stdout" as const, data: "bots/deleted-bot\n" };
      yield { type: "exit" as const, code: 0 };
    });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          spaceId: "workspace-1",
          homeKey: "team-workspace-1",
          providerRef: "sandbox-1",
          kind: "e2b",
          scope: "team",
          state,
          controlLeaseId: null,
          maintenanceId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          ...stored,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      computerRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
      botDeletion: { findMany },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockResolvedValue(undefined),
      importWorkspace: vi.fn().mockResolvedValue(undefined),
      execute,
    } as unknown as SandboxProvider;
    return { ref, prisma, sandbox, execute, findMany };
  }

  async function boot(harness: ReturnType<typeof wakeHarness>, bootContext = context) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-"));
    try {
      return await provisionComputer(
        {
          prisma: harness.prisma,
          sandbox: harness.sandbox,
          home: {
            exportHome: vi.fn().mockReturnValue((async function* () {})()),
          } as unknown as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        bootContext,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  function activation(harness: ReturnType<typeof wakeHarness>) {
    const calls = vi.mocked(harness.prisma.computer.updateMany).mock.calls;
    return calls.map(([args]) => args).find((args) => args.data.state === "running")?.data;
  }

  it("does not start a billed computer once its organization spent the month's allowance", async () => {
    const harness = wakeHarness("stopped");
    Object.assign(harness.sandbox, { billsWhileRunning: () => true });
    Object.assign(harness.prisma, {
      space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "organization-1" }) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ modelCreditsEnabled: true }) },
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          modelCredits: { mode: "credits" },
          billing: { creditAmountCents: 5000 },
        }),
      },
      // $10 of a $50 plan, at the default $0.10 an hour.
      $queryRaw: vi.fn().mockResolvedValue([{ kind: "e2b", hours: 100 }]),
    });

    await expect(boot(harness)).rejects.toBeInstanceOf(SandboxAllowanceUsedError);

    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.sandbox.provision).not.toHaveBeenCalled();
  });

  it("starts the computer at the size its plan provides", async () => {
    const harness = wakeHarness("stopped");
    vi.mocked(planComputerSize).mockResolvedValueOnce("large");

    await boot(harness);

    expect(planComputerSize).toHaveBeenLastCalledWith(harness.prisma, expect.any(String));
    expect(harness.sandbox.provision).toHaveBeenCalledOnce();
    expect(vi.mocked(harness.sandbox.provision).mock.calls[0]![0].size).toBe("large");
  });

  it("starts the computer at the size it has when the provider cannot move it", async () => {
    const harness = wakeHarness("stopped");
    vi.mocked(harness.sandbox.provision).mockRejectedValueOnce(
      new SandboxSizeUnavailableError("too_small"),
    );

    await expect(boot(harness)).resolves.toMatchObject({ providerRef: "sandbox-1" });

    const sizes = vi.mocked(harness.sandbox.provision).mock.calls.map(([request]) => request.size);
    expect(sizes).toEqual(["standard", undefined]);
    expect(activation(harness)?.state).toBe("running");
  });

  it("starts the active-lifetime clock when a stopped computer starts", async () => {
    const harness = wakeHarness("stopped", undefined, {}, { runningSince: null });
    const before = Date.now();

    await boot(harness);

    const runningSince = activation(harness)?.runningSince as Date;
    expect(runningSince).toBeInstanceOf(Date);
    expect(runningSince.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the active-lifetime clock when reconnecting to a running computer", async () => {
    const runningSince = new Date("2024-01-01T00:00:00.000Z");
    const harness = wakeHarness("running", undefined, {}, { runningSince });

    await boot(harness);

    expect(activation(harness)?.runningSince).toEqual(runningSince);
  });

  it("restarts the active-lifetime clock when reconnecting had to start the computer", async () => {
    const harness = wakeHarness(
      "running",
      undefined,
      { started: true },
      { runningSince: new Date("2024-01-01T00:00:00.000Z") },
    );
    const before = Date.now();

    await boot(harness);

    const runningSince = activation(harness)?.runningSince as Date;
    expect(runningSince.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("records a run from the clock's start, closing a missed earlier run as reconciled", async () => {
    const harness = wakeHarness("stopped", undefined, {}, { runningSince: null, userId: "user-1" });

    await boot(harness);

    const startedAt = activation(harness)?.runningSince as Date;
    // Earlier open runs end when last seen running, or at this start when never seen.
    expect(closedRuns(harness)).toEqual([[startedAt, "reconciled", "computer-1", startedAt]]);
    expect(vi.mocked(harness.prisma.computerRun.createMany)).toHaveBeenCalledWith({
      data: [
        {
          computerId: "computer-1",
          spaceId: "workspace-1",
          userId: "user-1",
          kind: "e2b",
          providerRef: "sandbox-1",
          startedAt,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("records the sandbox the provider returned, not the one the computer had before", async () => {
    const harness = wakeHarness(
      "stopped",
      undefined,
      { id: "sandbox-2", providerRef: "sandbox-2" },
      { runningSince: null, userId: "user-1" },
    );

    await boot(harness);

    expect(vi.mocked(harness.prisma.computerRun.createMany)).toHaveBeenCalledWith({
      data: [expect.objectContaining({ providerRef: "sandbox-2" })],
      skipDuplicates: true,
    });
  });

  it("keeps the same run when reconnecting to a computer that stayed up", async () => {
    const runningSince = new Date("2024-01-01T00:00:00.000Z");
    const harness = wakeHarness("running", undefined, {}, { runningSince });

    await boot(harness);

    expect(vi.mocked(harness.prisma.computerRun.createMany)).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ startedAt: runningSince })] }),
    );
    expect(vi.mocked(harness.prisma.computerRun.updateMany)).toHaveBeenCalledWith({
      where: { computerId: "computer-1", startedAt: runningSince, endedAt: null },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it("ends a run the provider stopped on its own when reconnecting has to start it again", async () => {
    const harness = wakeHarness(
      "running",
      undefined,
      { started: true },
      { runningSince: new Date("2024-01-01T00:00:00.000Z") },
    );

    await boot(harness);

    const startedAt = activation(harness)?.runningSince as Date;
    expect(closedRuns(harness)).toEqual([[startedAt, "gone", "computer-1", startedAt]]);
  });

  it("starts the computer even when the usage write fails", async () => {
    const harness = wakeHarness("stopped");
    vi.mocked(harness.prisma.computerRun.createMany).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(boot(harness)).resolves.toEqual(harness.ref);
  });

  it("removes folders of bots deleted while the Team Computer was stopped", async () => {
    const harness = wakeHarness("stopped");

    await expect(boot(harness)).resolves.toEqual(harness.ref);

    expect(harness.findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1" },
      select: { id: true },
    });
    expect(harness.execute).toHaveBeenCalledWith(
      harness.ref,
      {
        argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "deleted-bot"],
        cwd: ".",
      },
      expect.objectContaining({ botId: "bot-1" }),
    );
  });

  it("does not look for deleted bots' folders when reconnecting to a running Team Computer", async () => {
    const harness = wakeHarness("running");

    await expect(boot(harness)).resolves.toEqual(harness.ref);

    expect(harness.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["started the stopped computer", { started: true }],
    ["replaced the computer", { id: "sandbox-2", providerRef: "sandbox-2", fresh: true }],
  ])(
    "removes deleted bots' folders when a reconnect %s",
    async (_case, provisioned: Partial<ComputerRef>) => {
      const harness = wakeHarness(
        "running",
        vi.fn().mockResolvedValue([{ id: "deleted-bot" }]),
        provisioned,
      );

      await expect(boot(harness)).resolves.toEqual(harness.ref);

      expect(harness.execute).toHaveBeenCalledWith(
        harness.ref,
        {
          argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "deleted-bot"],
          cwd: ".",
        },
        expect.objectContaining({ botId: "bot-1" }),
      );
    },
  );

  it("does not hold the boot past the folder cleanup's time budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let markStarted: () => void = () => undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const harness = wakeHarness("stopped");
      harness.execute.mockImplementation(async function* (_computer, request) {
        if (isFolderListing(request)) {
          markStarted();
          await new Promise(() => undefined);
        }
        yield { type: "exit" as const, code: 0 };
      });

      const booting = boot(harness);
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(booting).resolves.toEqual(harness.ref);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still boots and reports it when the folder cleanup fails", async () => {
    const harness = wakeHarness(
      "stopped",
      vi.fn().mockRejectedValue(new Error("database unavailable")),
    );
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      await expect(boot(harness)).resolves.toEqual(harness.ref);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }

    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "error", message: "team bot folder cleanup" }),
    );
  });

  it("does not report a folder cleanup the cancelled run cut short", async () => {
    const run = new AbortController();
    const harness = wakeHarness("stopped");
    harness.execute.mockImplementation(async function* (_computer, request) {
      if (isFolderListing(request)) {
        run.abort();
        throw new Error("command aborted");
      }
      yield { type: "exit" as const, code: 0 };
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      await boot(harness, { ...context, signal: run.signal }).catch(() => undefined);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }

    expect(harness.execute).toHaveBeenCalledWith(
      harness.ref,
      expect.objectContaining({ argv: expect.arrayContaining(["bash"]) }),
      expect.anything(),
    );
    expect(sink.events).not.toContainEqual(
      expect.objectContaining({ message: "team bot folder cleanup" }),
    );
  });

  it("still reports an unrelated cleanup failure during a cancelled run", async () => {
    const run = new AbortController();
    const harness = wakeHarness("stopped");
    harness.execute.mockImplementation(async function* (_computer, request) {
      if (isFolderListing(request)) {
        run.abort();
        throw new Error("database unavailable");
      }
      yield { type: "exit" as const, code: 0 };
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      await boot(harness, { ...context, signal: run.signal }).catch(() => undefined);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }

    expect(harness.execute).toHaveBeenCalledWith(
      harness.ref,
      expect.objectContaining({ argv: expect.arrayContaining(["bash"]) }),
      expect.anything(),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "error", message: "team bot folder cleanup" }),
    );
  });
});

describe("computer execution leases", () => {
  it("leaves dedicated serialization to the screen lease", async () => {
    const prisma = leasePrisma({ scope: "dedicated" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toBeNull();
    expect(prisma.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("fences one Team bot's screen and expires only the matching lease", async () => {
    const prisma = leasePrisma({ scope: "team" });
    const lease = await acquireComputerExecutionLease(prisma.client, {
      workerId: "worker-1",
      runFence: 1,
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });

    expect(lease).toEqual({
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
    });
    expect(prisma.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          computerId: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 1,
        }),
        select: { fence: true },
      }),
    );

    prisma.updateMany.mockClear();
    await expect(renewComputerExecutionLease(prisma.client, lease)).resolves.toBe(true);
    expect(prisma.updateMany).toHaveBeenCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { expiresAt: expect.any(Date) },
    });
    await releaseComputerExecutionLease(prisma.client, lease);
    expect(prisma.updateMany).toHaveBeenLastCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.deleteMany).not.toHaveBeenCalled();
  });

  it("does not let a late renewal resurrect a released lease", async () => {
    let expiresAt = new Date(Date.now() + 60_000);
    const create = vi.fn();
    const updateManyAndReturn = vi.fn().mockImplementation(async ({ data }) => {
      if (expiresAt >= new Date()) return [];
      expiresAt = data.expiresAt;
      return [{ fence: 2 }];
    });
    const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
      if (where.expiresAt?.gt && expiresAt <= where.expiresAt.gt) return { count: 0 };
      expiresAt = data.expiresAt;
      return { count: 1 };
    });
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "run-1" }]),
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ scope: "team", state: "running" }),
      },
      computerExecutionLease: { create, updateMany, updateManyAndReturn },
    };
    const prisma = {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    } as unknown as PrismaClient;
    const lease = {
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
    };

    await releaseComputerExecutionLease(prisma, lease);
    await expect(renewComputerExecutionLease(prisma, lease)).resolves.toBe(false);
    expect(expiresAt).toEqual(new Date(0));
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { ...lease, expiresAt: { gt: expect.any(Date) } },
      data: { expiresAt: expect.any(Date) },
    });
    await expect(
      acquireComputerExecutionLease(prisma, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-2",
      }),
    ).resolves.toMatchObject({ runId: "run-2", fence: 2 });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["renewal", renewComputerExecutionLease],
    ["takeover", holdComputerExecutionLeaseForTakeover],
  ] as const)(
    "does not let late %s revive an expired lease during checkpointing",
    async (_, extend) => {
      const now = new Date("2026-01-01T00:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        let expiresAt = new Date(now.getTime() + 1_000);
        const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
          if (expiresAt <= where.expiresAt.gt) return { count: 0 };
          expiresAt = data.expiresAt;
          return { count: 1 };
        });
        const prisma = { computerExecutionLease: { updateMany } } as unknown as PrismaClient;
        const lease = { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 1 };

        await expect(extend(prisma, lease)).resolves.toBe(true);
        const extendedExpiry = expiresAt;
        vi.setSystemTime(extendedExpiry);
        // The checkpoint claim may now exclude this expired peer. It must stay expired.
        await expect(extend(prisma, lease)).resolves.toBe(false);
        expect(expiresAt).toEqual(extendedExpiry);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("increments the screen fence when the same Team bot starts another run", async () => {
    const prisma = leasePrisma({ scope: "team" });
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot-1", homePath: "/tmp" }, context);
    const first = await acquireComputerExecutionLease(prisma.client, {
      workerId: "worker-1",
      runFence: 1,
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });
    await sandbox.observe(computer, {
      ...context,
      screenLeaseId: screenLeaseIdForRun(first, "run-1"),
    });
    await releaseComputerExecutionLease(prisma.client, first);
    prisma.updateManyAndReturn.mockResolvedValueOnce([{ fence: 2 }]);

    const second = await acquireComputerExecutionLease(prisma.client, {
      workerId: "worker-1",
      runFence: 1,
      computerId: "computer-1",
      runId: "run-2",
      botId: "bot-1",
    });
    expect(second).toEqual({
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-2",
      fence: 2,
    });
    await expect(
      sandbox.observe(computer, {
        ...context,
        screenLeaseId: screenLeaseIdForRun(second, "run-2"),
      }),
    ).resolves.toMatchObject({ activeWindow: expect.anything() });
    expect(prisma.create).toHaveBeenCalledOnce();
  });

  it("increments the screen fence after clearing a thread with an open screen", async () => {
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot-1", homePath: "/tmp" }, context);
    const lease = {
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "run-2" }]),
      threadRead: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      thread: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 0, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      computerExecutionLease: {
        updateMany: vi.fn().mockImplementation(async ({ data }) => {
          lease.expiresAt = data.expiresAt;
          return { count: 1 };
        }),
        updateManyAndReturn: vi.fn().mockImplementation(async ({ data }) => {
          if (lease.expiresAt >= new Date()) return [];
          lease.runId = data.runId;
          lease.expiresAt = data.expiresAt;
          lease.fence += data.fence.increment;
          return [{ fence: lease.fence }];
        }),
        create,
      },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ scope: "team", state: "running" }),
        updateMany: vi.fn(),
      },
      message: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
      artifact: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "event-1",
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          seq: 0,
          type: "thread.cleared",
          payload: {},
          runId: null,
          createdAt: new Date(),
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    } as unknown as PrismaClient;

    await sandbox.observe(computer, { ...context, screenLeaseId: "run-1:1" });
    await clearThread(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
    });
    const next = await acquireComputerExecutionLease(prisma, {
      workerId: "worker-1",
      runFence: 1,
      computerId: "computer-1",
      runId: "run-2",
      botId: "bot-1",
    });

    expect(next).toMatchObject({ runId: "run-2", fence: 2 });
    await expect(
      sandbox.observe(computer, {
        ...context,
        runId: "run-2",
        screenLeaseId: screenLeaseIdForRun(next, "run-2"),
      }),
    ).resolves.toMatchObject({ activeWindow: expect.anything() });
    expect(create).not.toHaveBeenCalled();
  });

  it("lets two Team bots hold leases at the same time", async () => {
    const prisma = leasePrisma({ scope: "team" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toMatchObject({ botId: "bot-1", runId: "run-1" });
    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-2",
      }),
    ).resolves.toMatchObject({ botId: "bot-2", runId: "run-2" });
    expect(prisma.create).toHaveBeenCalledTimes(2);
  });

  it("rejects a second run for the same Team bot while its lease is held", async () => {
    const prisma = leasePrisma({ scope: "team", uniqueConflict: true });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
  });

  it("does not reclaim a same-run lease without the current worker claim", async () => {
    const prisma = leasePrisma({ scope: "team", reclaim: true });
    prisma.queryRaw.mockResolvedValueOnce([]);

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
        workerId: "worker-old",
        runFence: 1,
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(prisma.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("reclaims an active same-run lease for the current run owner", async () => {
    const prisma = leasePrisma({ scope: "team", reclaim: true, fence: 8 });

    await acquireComputerExecutionLease(prisma.client, {
      workerId: "worker-1",
      runFence: 1,
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });

    expect(prisma.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ expiresAt: { lt: expect.any(Date) } }, { runId: "run-1" }],
        }),
      }),
    );
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("keeps the screen lease on the run id and fence", () => {
    expect(screenLeaseIdForRun({ runId: "run-1", fence: 8 }, "run-1")).toBe("run-1:8");
    expect(screenLeaseIdForRun(null, "run-1", 0)).toBe("run-1:0");
  });

  it("increments dedicated screen fences and refuses an unowned run", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "bot-1" }])
      .mockResolvedValueOnce([{ id: "computer-1", scope: "dedicated" }])
      .mockResolvedValueOnce([{ id: "run-1" }])
      .mockResolvedValueOnce([{ id: "bot-1" }])
      .mockResolvedValueOnce([{ id: "computer-1", scope: "dedicated" }])
      .mockResolvedValueOnce([{ id: "run-2" }])
      .mockResolvedValueOnce([{ id: "bot-1" }])
      .mockResolvedValueOnce([{ id: "computer-1", scope: "dedicated" }])
      .mockResolvedValueOnce([]);
    const updateManyAndReturn = vi
      .fn()
      .mockResolvedValueOnce([{ fence: 4 }])
      .mockResolvedValueOnce([{ fence: 5 }]);
    const tx = {
      $queryRaw: queryRaw,
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateManyAndReturn,
        create: vi.fn(),
      },
      run: { aggregate: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    } as unknown as PrismaClient;
    const base = {
      computerId: "computer-1",
      botId: "bot-1",
      workerId: "worker-1",
      runFence: 1,
    };

    const first = await acquireDedicatedScreenLeaseFence(prisma, { ...base, runId: "run-1" });
    const second = await acquireDedicatedScreenLeaseFence(prisma, { ...base, runId: "run-2" });
    expect(screenLeaseIdForRun(first, "run-1")).toBe("run-1:4");
    expect(screenLeaseIdForRun(second, "run-2")).toBe("run-2:5");
    expect(updateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(tx.run.aggregate).not.toHaveBeenCalled();

    await expect(
      acquireDedicatedScreenLeaseFence(prisma, { ...base, runId: "run-unowned" }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateManyAndReturn).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "dedicated screen acquisition respects lease expiry (live=%s)",
    async (live) => {
      const now = new Date();
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: "bot-1" }])
          .mockResolvedValueOnce([{ id: "computer-1", scope: "dedicated" }])
          .mockResolvedValueOnce([{ id: "run-resumed-card" }]),
        computerExecutionLease: {
          updateManyAndReturn: vi.fn().mockResolvedValue(live ? [] : [{ fence: 8 }]),
          create: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error("lease exists"), { code: "P2002" })),
        },
        run: { aggregate: vi.fn().mockResolvedValue({ _max: { leaseFence: 2 } }) },
      };
      const prisma = {
        $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
      } as unknown as PrismaClient;
      const acquiring = acquireDedicatedScreenLeaseFence(prisma, {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-resumed-card",
        workerId: "worker-1",
        runFence: 2,
      });
      if (live) await expect(acquiring).rejects.toBeInstanceOf(ComputerBusyError);
      else await expect(acquiring).resolves.toMatchObject({ runId: "run-resumed-card", fence: 8 });
      expect(tx.computerExecutionLease.updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          computerId: "computer-1",
          botId: "bot-1",
          OR: [{ expiresAt: { lte: expect.any(Date) } }, { runId: "run-resumed-card" }],
        },
        data: { runId: "run-resumed-card", expiresAt: expect.any(Date), fence: { increment: 1 } },
        select: { fence: true },
      });
      expect(
        tx.computerExecutionLease.updateManyAndReturn.mock.calls[0]?.[0].data.expiresAt.getTime(),
      ).toBeGreaterThan(now.getTime());
    },
  );

  it("retries a dedicated screen lease after a write conflict but not a busy computer", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "bot-1" }])
        .mockResolvedValueOnce([{ id: "computer-1", scope: "dedicated" }])
        .mockResolvedValueOnce([{ id: "run-1" }])
        .mockResolvedValueOnce([]),
      computerExecutionLease: {
        updateManyAndReturn: vi.fn().mockResolvedValue([{ fence: 3 }]),
        create: vi.fn(),
      },
      run: { aggregate: vi.fn() },
    };
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const $transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx));
    const prisma = { $transaction } as unknown as PrismaClient;
    const input = {
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      workerId: "worker-1",
      runFence: 1,
    };

    await expect(acquireDedicatedScreenLeaseFence(prisma, input)).resolves.toMatchObject({
      fence: 3,
    });
    expect($transaction).toHaveBeenCalledTimes(2);

    await expect(acquireDedicatedScreenLeaseFence(prisma, input)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect($transaction).toHaveBeenCalledTimes(3);
  });

  it("acquires a team lease on a stale suspending computer", async () => {
    const prisma = leasePrisma({ scope: "team" });
    prisma.findUniqueOrThrow.mockResolvedValue({
      scope: "team",
      state: "suspending",
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toEqual({
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
    });
  });

  it("refuses a team lease while suspension is still in progress", async () => {
    const prisma = leasePrisma({ scope: "team" });
    prisma.findUniqueOrThrow.mockResolvedValue({
      scope: "team",
      state: "suspending",
      updatedAt: new Date(),
    });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("rolls back a lease that races with computer suspension", async () => {
    const prisma = leasePrisma({ scope: "team" });
    prisma.findUniqueOrThrow
      .mockResolvedValueOnce({ scope: "team", state: "running" })
      .mockResolvedValue({ scope: "team", state: "suspending" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        workerId: "worker-1",
        runFence: 1,
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
    expect(prisma.updateMany).not.toHaveBeenCalled();
  });
});

function leasePrisma(options: {
  scope: string;
  reclaim?: boolean;
  fence?: number;
  uniqueConflict?: boolean;
}) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const updateManyAndReturn = vi
    .fn()
    .mockResolvedValue(options.reclaim ? [{ fence: options.fence ?? 1 }] : []);
  const create = vi.fn().mockImplementation(async () => {
    if (options.uniqueConflict) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    return { fence: 1 };
  });
  const findUniqueOrThrow = vi.fn().mockResolvedValue({
    scope: options.scope,
    state: "running",
  });
  const queryRaw = vi.fn().mockResolvedValue([{ id: "run-1" }]);
  const client = {
    $queryRaw: queryRaw,
    computer: { findUniqueOrThrow },
    computerExecutionLease: { updateManyAndReturn, create, updateMany, deleteMany },
  };
  return {
    client: {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    } as unknown as PrismaClient,
    queryRaw,
    updateMany,
    updateManyAndReturn,
    create,
    deleteMany,
    findUniqueOrThrow,
  };
}

describe("computer replacement", () => {
  it("exposes update availability by sandbox kind", () => {
    expect(computerSupportsUpdate("e2b")).toBe(true);
    expect(computerSupportsUpdate("desktop")).toBe(false);
    expect(computerSupportsUpdate("wuying")).toBe(false);
    expect(computerSupportsUpdate("none")).toBe(false);
  });

  it("replaces a wedged computer and restores the durable home", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-replace-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-replace-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    await sandbox.writeFile(
      first,
      { path: "notes/keep.txt", content: new TextEncoder().encode("saved") },
      context,
    );
    const revision = await checkpointComputerWorkspace(home, sandbox, "bot-1", first, context);

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      homeRevision: revision,
    };
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce(computerRecord)
      .mockResolvedValueOnce({ ...computerRecord, state: "stopped", providerRef: null })
      .mockResolvedValue({
        ...computerRecord,
        state: "stopped",
        providerRef: null,
      });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow,
        updateMany,
        update,
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
      },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    const exportWorkspace = vi.spyOn(sandbox, "exportWorkspace");
    const destroy = vi.spyOn(sandbox, "destroy");
    try {
      const ref = await replaceComputer(
        {
          prisma,
          sandbox,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(exportWorkspace).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(exportWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        destroy.mock.invocationCallOrder[0]!,
      );
      expect(ref.fresh).toBe(true);
      expect(new TextDecoder().decode(await sandbox.readFile(ref, "notes/keep.txt", context))).toBe(
        "saved",
      );
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    } catch (error) {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
      throw error;
    }
  });

  it("rejects replacement while another team bot holds the computer", async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "running",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "other-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("refuses Recover and Update on a stale suspending computer", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    for (const mode of ["recover", "update"] as const) {
      await expect(
        replaceComputer(
          {
            prisma,
            sandbox: new FakeSandboxProvider(),
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          mode,
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("resets a computer a crashed worker left suspending", async () => {
    // No live lease and the suspend stamp is older than an execution-lease TTL:
    // Reset must reach the claim instead of answering "Computer is busy" for good.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const stale = new Date("2024-01-01T00:00:00.000Z");
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: stale,
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "suspending", updatedAt: stale }),
      }),
    );
  });

  it("refuses Reset on a fresh suspending claim", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: new Date(nowMs),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      await expect(
        replaceComputer(
          {
            prisma,
            sandbox: new FakeSandboxProvider(),
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          "reset",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("refuses Reset on a stale suspending row while a run is still active", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "suspending",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue({ id: "live-run" }) },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("resets a computer a crashed worker left booting", async () => {
    // No live lease from anyone else: the worker that set "booting" is gone, so Reset must
    // reach the claim instead of answering "Computer is busy" for good.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "dedicated",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: "booting" }) }),
    );
  });

  it("refuses a booting computer another bot is still holding", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "team",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: {
        findFirst: vi.fn().mockResolvedValue({ id: "lease-other-bot" }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses Reset on a fresh dedicated booting claim", async () => {
    // Dedicated computers never write an execution-lease row, so foreign-lease checks alone
    // cannot see an in-flight boot. A fresh claim stamp must keep Reset from destroying it.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "dedicated",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date(nowMs),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      await expect(
        replaceComputer(
          {
            prisma,
            sandbox: new FakeSandboxProvider(),
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          "reset",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("refuses Reset on a stale dedicated booting row while a run is still active", async () => {
    // Stamp is old enough to look abandoned, but a live run still owns the provision.
    // Refuse before claiming suspending so we do not bump @updatedAt under the provisioner.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "dedicated",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue({ id: "live-run" }) },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects replacement while the target bot has an active run", async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "same-bot-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement while any bot holds user control", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
          controlBotId: "other-bot",
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement while the same bot holds user control", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
          controlBotId: "bot-1",
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("does not treat stale user control without a lease as busy during reset", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 }) // clearInactiveUserComputerControl
      .mockResolvedValueOnce({ count: 0 }); // suspending claim races
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "fake",
        scope: "dedicated",
        state: "running",
        controlHolder: "user",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        controlLeaseExpiresAt: null,
        controlBotId: "bot-1",
      })
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "fake",
        scope: "dedicated",
        state: "running",
        controlHolder: "none",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        controlLeaseExpiresAt: null,
        controlBotId: null,
      });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow,
        updateMany,
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", controlHolder: "user" }),
        data: expect.objectContaining({ controlHolder: "none" }),
      }),
    );
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
  });

  it("hands an idle takeover back only as part of the reset claim", async () => {
    const setScreenControl = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const destroy = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(idleTakeoverComputer()),
        updateMany,
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    const deps = replaceDeps(prisma, { setScreenControl, destroy });
    await expect(
      replaceComputer(deps, "computer-1", "reset", context, "none", undefined, {
        handBackIdleTakeover: true,
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);

    expect(destroy).not.toHaveBeenCalled();
    // The hand back rolled back, so the person's control and its recording stay.
    expect(deps.events.draftRecordingsOfLease).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          controlHolder: "user",
          controlBotId: "bot-1",
          controlLeaseId: "lease-1",
        }),
        data: expect.objectContaining({
          state: "suspending",
          controlHolder: "none",
          controlLeaseId: null,
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-1",
          controlBotId: "bot-1",
        }),
      }),
    );
  });

  it("does not revoke the screen when the reset claim loses", async () => {
    const setScreenControl = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(idleTakeoverComputer()),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      replaceComputer(
        replaceDeps(prisma, { setScreenControl }),
        "computer-1",
        "reset",
        context,
        "none",
        undefined,
        { handBackIdleTakeover: true },
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);

    expect(setScreenControl).not.toHaveBeenCalled();
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
  });

  it("blocks reset while an expired lease's provider revocation fails", async () => {
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(Date.now() - 60_000),
      controlBotId: null,
      spaceId: "space-1",
      userId: "user-1",
    };
    const findUniqueOrThrow = vi.fn().mockResolvedValue(computer);
    const findUnique = vi.fn().mockResolvedValue(computer);
    const prisma = {
      computer: {
        findUniqueOrThrow,
        findUnique,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const sandbox = Object.assign(new FakeSandboxProvider(), {
      setScreenControl: async () => {
        throw new Error("provider unavailable");
      },
    }) as SandboxProvider;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox,
          home: {} as AgentHomeStore,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toThrow("provider unavailable");
    // Input is denied, but the lease id stays so the expiry job retries the revoke.
    expect(prisma.computer.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "computer-1", controlLeaseId: "lease-1" }),
      data: { controlLeaseExpiresAt: new Date(0) },
    });
  });

  it("rejects replacement when control is claimed before the suspending lock", async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlHolder: "none",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          controlLeaseExpiresAt: null,
          controlBotId: null,
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          OR: expect.arrayContaining([
            { controlHolder: { not: "user" } },
            { controlLeaseId: null },
            { controlLeaseExpiresAt: null },
            { controlLeaseExpiresAt: { lte: expect.any(Date) } },
          ]),
        }),
      }),
    );
  });

  it("rejects replacement of a stopped computer while a run is still active", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", state: "stopped" }),
        data: { state: "suspending", updatedAt: expect.any(Date) },
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "computer-1", state: "suspending", updatedAt: expect.any(Date) },
        data: { state: "stopped" },
      }),
    );
  });

  it("rejects replacement of a suspended computer while a run is still active", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "suspended",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "update",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", state: "suspended" }),
        data: { state: "suspending", updatedAt: expect.any(Date) },
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "computer-1", state: "suspending", updatedAt: expect.any(Date) },
        data: { state: "suspended" },
      }),
    );
  });

  it("claims a stopped computer before teardown so concurrent replacements serialize", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-replace-stopped-claim-"));
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: null,
        kind: "fake",
        scope: "dedicated",
        state: "stopped",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      })
      .mockResolvedValue({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: null,
        kind: "fake",
        scope: "dedicated",
        state: "stopped",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: { findUniqueOrThrow, updateMany, update },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();

    try {
      await replaceComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ id: "computer-1", state: "stopped" }),
          data: { state: "suspending", updatedAt: expect.any(Date) },
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a second claim on a stopped computer that is already suspending", async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
  });

  it("continues recover when checkpoint fails with an ordinary provider error", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-recover-checkpoint-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-recover-checkpoint-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    const exportWorkspace = vi.spyOn(sandbox, "exportWorkspace").mockImplementation(() => {
      throw new Error("ECONNRESET");
    });

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      homeRevision: null,
    };
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce(computerRecord)
      .mockResolvedValue({
        ...computerRecord,
        state: "stopped",
        providerRef: null,
      });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow,
        updateMany,
        update,
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      const ref = await replaceComputer(
        {
          prisma,
          sandbox,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(exportWorkspace).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(exportWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        destroy.mock.invocationCallOrder[0]!,
      );
      expect(ref.fresh).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  it("aborts update when checkpoint fails with an ordinary provider error", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-update-checkpoint-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-update-checkpoint-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    vi.spyOn(sandbox, "exportWorkspace").mockImplementation(() => {
      throw new Error("ECONNRESET");
    });

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      homeRevision: null,
    };
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(computerRecord),
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
        updateMany,
        update: vi.fn(),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      await expect(
        replaceComputer(
          {
            prisma,
            sandbox,
            home,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          "update",
          context,
        ),
      ).rejects.toThrow("ECONNRESET");
      expect(destroy).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { id: "computer-1", maintenanceId: null, updatedAt: expect.any(Date) },
        data: { state: "running" },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});

function idleTakeoverComputer(overrides: Record<string, unknown> = {}) {
  return {
    id: "computer-1",
    homeKey: "bot-1",
    providerRef: "provider-1",
    kind: "fake",
    scope: "dedicated",
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease-1",
    controlLeaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
    controlBotId: "bot-1",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    maintenanceId: null,
    spaceId: "workspace-1",
    userId: "user-1",
    ...overrides,
  };
}

function replaceDeps(
  prisma: PrismaClient,
  sandbox: { setScreenControl?: ReturnType<typeof vi.fn>; destroy?: ReturnType<typeof vi.fn> },
) {
  return {
    prisma,
    sandbox: sandbox as unknown as SandboxProvider,
    home: {} as AgentHomeStore,
    jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
    events: {
      append: vi.fn(),
      draftRecordingsOfLease: vi.fn().mockResolvedValue([]),
    } as unknown as ThreadEvents,
  };
}

describe("computer terminal capability", () => {
  it("allows Novita terminals through the product capability gate", () => {
    expect(computerSupportsTerminal("novita")).toBe(true);
    expect(computerSupportsTerminal("unknown")).toBe(false);
    expect(computerSupportsTerminal("none")).toBe(false);
  });
});

/** The values of each raw run-closing statement, in order. */
function closedRuns(harness: { prisma: PrismaClient }) {
  return vi.mocked(harness.prisma.$executeRaw).mock.calls.map(([, ...values]) => values);
}
