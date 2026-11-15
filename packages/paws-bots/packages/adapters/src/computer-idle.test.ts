import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { FetchError } from "@boatdev/sdk";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  SandboxDamagedError,
  SandboxProviderAccountError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boatError, FakeBoatApi, fakeBoatProvider } from "./boat-sandbox.test-support.js";
import {
  ABANDONED_SUSPEND_CLAIM_MS,
  BACKGROUND_WORK_LAUNCH,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
  CANCEL_PRIMARY_BROWSER_WORK,
  computerIdleSleepEnabled,
  computerMaxActiveMs,
  createIdleComputerSweeper,
  DEFAULT_COMPUTER_MAX_ACTIVE_MS,
  DEFAULT_SANDBOX_IDLE_MS,
  sandboxIdleMs,
  scheduleComputerSleep,
  sleepComputerIfIdle,
  TAKEOVER_IDLE_GRACE_MS,
  touchRunningComputer,
  unbilledComputerMaxActiveMs,
} from "./computer-idle.js";
import { BrowserStillRunningError } from "./computer-screens.js";
import { e2bCreateOptions } from "./e2b-sandbox.js";
import { HomeSaveConflictError } from "./home-object-store.js";

describe("sandbox idle", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it.each(["bytes", "files"] as const)(
    "announces an unsaved home once for %s until the next save",
    async (limit) => {
      const harness = idleHarness({ exportError: new WorkspaceTooLargeError(limit) });
      await sleepComputerIfIdle(harness.deps, harness.computer.id);
      await sleepComputerIfIdle(harness.deps, harness.computer.id);
      expect(harness.prisma.message.create).toHaveBeenCalledOnce();
      expect(harness.prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: "system",
            blocks: [
              {
                kind: "meta",
                text: `${new WorkspaceTooLargeError(limit).message}. It will keep running unsaved. Remove large files or files you no longer need so it can be saved.`,
              },
            ],
          }),
        }),
      );
      expect(harness.events.notify).toHaveBeenCalledOnce();
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.computer.state).toBe("running");
      harness.computer.homeRevisionAt = new Date();
      await sleepComputerIfIdle(harness.deps, harness.computer.id);
      expect(harness.prisma.message.create).toHaveBeenCalledTimes(2);
    },
  );

  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
  });

  it.each(["0", " \t0\n"])("disables idle sleep for %j", async (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();

    expect(computerIdleSleepEnabled()).toBe(false);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.prisma.computer.findUnique).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it.each(["", "invalid", "NaN", "Infinity", "-1", "29999", "00", "0.0"])(
    "keeps idle sleep enabled with the default timeout for %j",
    (value) => {
      vi.stubEnv("SANDBOX_IDLE_MS", value);

      expect(computerIdleSleepEnabled()).toBe(true);
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    },
  );

  it.each(["30000", "900000"])("schedules idle sleep using %s ms", (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(Number(value));
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);

    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + Number(value)) }),
    );
  });

  it("logs and drops a sleep check the job queue rejects", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const harness = idleHarness({ billsWhileRunning: true, runningSince: new Date(0) });
      let enqueued = 0;
      // A vi.fn rejection is observed by the spy itself and could never go unhandled.
      harness.deps.jobs.enqueue = () => {
        enqueued += 1;
        return Promise.reject(new Error("Background job publisher is closed"));
      };

      scheduleComputerSleep(harness.deps.jobs, harness.computer.id);
      await expect(touchRunningComputer(harness.deps, harness.computer)).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(enqueued).toBe(2);
      expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(
        sink.events.filter(
          (event) => event.level === "warn" && event.message === "computer.sleep_schedule_failed",
        ),
      ).toHaveLength(2);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each(["queued", "leased", "running"])(
    "keeps a computer awake while a run is %s",
    async (status) => {
      const harness = idleHarness();
      harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
        where.status.in.includes(status) ? { id: "run" } : null,
      );

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.home.commit).not.toHaveBeenCalled();
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.sandbox.execute).not.toHaveBeenCalled();
      expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, false, true])(
    "suspends a computer whose only active run is waiting_input (billsWhileRunning: %s)",
    async (billsWhileRunning) => {
      const harness = idleHarness({ billsWhileRunning });
      harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
        where.status.in.includes("waiting_input") ? { id: "waiting-for-answer" } : null,
      );

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.home.commit).toHaveBeenCalledOnce();
      expect(harness.sandbox.stop).toHaveBeenCalledOnce();
      expect(harness.computer.state).toBe("suspended");
      expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
      expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("leaves a held computer whose heartbeat finds the sandbox gone to its recovery", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue({ id: "run" });
    harness.sandbox.keepAlive.mockRejectedValueOnce(
      Object.assign(new Error("sandbox removed"), { name: "SandboxNotFoundError" }),
    );

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();

    harness.sandbox.keepAlive.mockRejectedValueOnce(
      new SandboxUnresponsiveError("Boat could not be reached"),
    );
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(2);

    harness.sandbox.keepAlive.mockRejectedValueOnce(new Error("requires PRIVATE networking"));
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "PRIVATE networking",
    );
  });

  it("does not suspend a computer while bot-launched background work is active", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("probes background work with the database computer id, not providerRef", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: harness.computer.providerRef }),
      expect.objectContaining({
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", harness.computer.id],
      }),
      expect.anything(),
    );
    expect(harness.computer.id).not.toBe(harness.computer.providerRef);
  });

  it("fails closed when the provider cannot inspect background work", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 2 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider reports a command failure as exit one", async () => {
    const harness = idleHarness({ backgroundWorkProbeFailed: true });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover past its grace prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("claims past only the lease a run waiting for takeover holds, at its current fence", async () => {
    const harness = idleHarness();
    harness.prisma.computerExecutionLease.findMany.mockResolvedValue([
      { runId: "waiting", fence: 3 },
      { runId: "working", fence: 7 },
    ]);
    harness.prisma.run.findMany.mockImplementation(async ({ where }) =>
      where.id ? [{ id: "waiting" }] : [],
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executionLeases: {
            none: { expiresAt: { gt: expect.any(Date) }, NOT: [{ runId: "waiting", fence: 3 }] },
          },
        }),
      }),
    );
  });

  it("claims the lease boundary before any checkpoint export", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("rechecks background work after checkpointing before it suspends", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(backgroundProbes(harness)).toHaveLength(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("leaves a heartbeat the provider fails after checkpointing to the next idle check", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });
    harness.sandbox.keepAlive.mockRejectedValueOnce(
      new SandboxUnresponsiveError("provider request failed (HTTP 500)"),
    );

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("reports the provider account refusing the heartbeat after checkpointing", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });
    harness.sandbox.keepAlive.mockRejectedValueOnce(new SandboxProviderAccountError());

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBeInstanceOf(
      SandboxProviderAccountError,
    );
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("uses provider-native idle inspection instead of retaining emulator computers", async () => {
    const harness = idleHarness({ providerBackgroundWorkStatus: "idle" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.inspectBackgroundWork).toHaveBeenCalledTimes(2);
    expect(backgroundProbes(harness)).toHaveLength(0);
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("keeps the disk reading when a home too large to save keeps the computer running", async () => {
    const harness = idleHarness({ exportError: new WorkspaceTooLargeError("bytes") });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { diskUsedBytes: 91n * 1024n, diskFreeBytes: 9n * 1024n, state: "running" },
      }),
    );
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sandbox.exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: harness.computer.id,
        state: "suspending",
        providerRef: harness.computer.providerRef,
        updatedAt: expect.any(Date),
      },
      data: {
        diskUsedBytes: 91n * 1024n,
        diskFreeBytes: 9n * 1024n,
        state: "suspended",
        runningSince: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it("clears a stranded legacy execution binding so an idle computer can suspend", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);
    // A pre-lease release left this binding; its run ended and nothing reclaims it.
    harness.computer.executionRunId = "run-ended";
    harness.prisma.run.findUnique.mockResolvedValue({ status: "cancelled" });
    // Like the real database, the suspension claim refuses a computer still bound.
    const claim = harness.prisma.computer.updateMany;
    harness.prisma.computer.updateMany = vi.fn(async (args) => {
      if (
        args.where.executionRunId !== undefined &&
        args.where.executionRunId !== harness.computer.executionRunId
      ) {
        return { count: 0 };
      }
      return claim(args);
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.executionRunId).toBeNull();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "suspended" }) }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
  });

  it("defers sleep with a warning when the sandbox does not answer in time", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const command = vi
      .spyOn(FakeBoatApi.prototype, "command")
      .mockRejectedValue(boatError(502, "sandbox_direct_failed", "Request timeout after 74997ms"));
    const boat = fakeBoatProvider();
    const boatComputer = await boat.provision(
      { botId: "bot", homePath: "/unused" },
      {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    );
    const harness = idleHarness();
    harness.deps.sandbox.exportWorkspace = (_computer, context) =>
      boat.exportWorkspace(boatComputer, context);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(command).toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "computer.sleep_deferred" }),
    );
    expect(sink.events.some((event) => event.level === "error")).toBe(false);
  });

  it("defers sleep when the connection to the provider drops", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.spyOn(FakeBoatApi.prototype, "command").mockRejectedValue(
      new FetchError(
        new TypeError("fetch failed"),
        "The request failed and the interceptors did not return an alternative response",
      ),
    );
    const boat = fakeBoatProvider();
    const boatComputer = await boat.provision(
      { botId: "bot", homePath: "/unused" },
      {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    );
    const harness = idleHarness();
    harness.deps.sandbox.exportWorkspace = (_computer, context) =>
      boat.exportWorkspace(boatComputer, context);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        message: "computer.sleep_deferred",
        reason: "unresponsive",
        error: expect.objectContaining({ name: "SandboxUnresponsiveError" }),
      }),
    );
  });

  it("stops a computer whose system cannot start programs without a checkpoint", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const damaged = new SandboxDamagedError();
    const harness = idleHarness({ probeError: damaged, exportError: damaged });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
    expect(harness.computer.providerRef).not.toBeNull();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.checkpoint_skipped",
        reason: "damaged",
      }),
    );
    expect(sink.events.some((event) => event.level === "error")).toBe(false);
  });

  it("forces the stop of a damaged computer its provider refuses to stop", async () => {
    const boatApi = new FakeBoatApi();
    const boat = fakeBoatProvider(boatApi);
    const boatComputer = await boat.provision(
      { botId: "bot", homePath: "/unused" },
      {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    );
    boatApi.saveSnapshot(boatComputer.id);
    boatApi.damage(boatComputer.id);
    const harness = idleHarness();
    Object.assign(harness.computer, { kind: "boat", providerRef: boatComputer.providerRef });
    harness.deps.sandbox = boat;

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(boatApi.state(boatComputer.id)).toBe("archived");
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.computer).toMatchObject({
      state: "suspended",
      providerRef: boatComputer.providerRef,
    });
  });

  it("never discards unsaved work when stopping a computer it could save", async () => {
    const harness = idleHarness();

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  describe("a computer its provider already stopped", () => {
    const savedAt = new Date("2026-01-01T00:00:00.000Z");

    it("is marked suspended without being started when nothing changed since its save", async () => {
      const harness = idleHarness({ stoppedAtProvider: true, homeRevisionAt: savedAt });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.computer.state).toBe("suspended");
      expect(harness.sandbox.execute).not.toHaveBeenCalled();
      expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.home.commit).not.toHaveBeenCalled();
      expect(harness.computer.providerRef).toBe("computer");
      expect(goneRuns(harness)).toEqual([harness.computer.id]);
      expect(harness.events.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
      );
    });

    it.each([
      ["a run", { runSinceSave: true }],
      ["a takeover", { takeoverSinceSave: true }],
      ["no save time", { homeRevisionAt: null }],
    ] as const)("is started and saved when %s may have changed it", async (_case, change) => {
      const harness = idleHarness({
        stoppedAtProvider: true,
        homeRevisionAt: savedAt,
        ...change,
      });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.home.commit).toHaveBeenCalledOnce();
      expect(harness.sandbox.stop).toHaveBeenCalledOnce();
      expect(harness.computer.state).toBe("suspended");
    });

    it("is left to the run that holds it", async () => {
      const harness = idleHarness({ stoppedAtProvider: true, homeRevisionAt: savedAt });
      harness.prisma.run.findFirst.mockResolvedValue({ id: "active-run" });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.isStopped).not.toHaveBeenCalled();
      expect(harness.computer.state).toBe("running");
    });
  });

  it("keeps a computer only its provider's snapshot can bring back for the next use", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness({ exportError: new SandboxUnavailableError() });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.computer.providerRef).not.toBeNull();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.sleep_deferred",
        reason: "unavailable",
      }),
    );
  });

  it.each([
    ["the provider rate limits the checkpoint", new SandboxRateLimitError(), "rate_limited"],
    [
      "a browser opens again during the checkpoint",
      new BrowserStillRunningError(),
      "browser_running",
    ],
  ])("backs off without failing the job while %s", async (_, exportError, reason) => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness({ exportError });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "computer.sleep" }),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.sleep_deferred",
        reason,
      }),
    );
  });

  it("keeps a computer whose files are too large to save running, with a warning", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness({ exportError: new WorkspaceTooLargeError("bytes") });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.sleep_deferred",
        reason: "too_large",
      }),
    );
    expect(sink.events.some((event) => event.level === "error")).toBe(false);
  });

  it("stops a computer whose files are too large to save when its provider keeps its disk", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness({
      exportError: new WorkspaceTooLargeError("bytes"),
      persistentHome: true,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(harness.computer.state).toBe("suspended");
    expect(harness.computer.homeRevision).toBe("rev-before");
    expect(harness.prisma.message.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: expect.stringMatching(/^computer-unsaved:/) }),
      }),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({ message: "computer.checkpoint_skipped", reason: "too_large" }),
    );
  });

  it("checks again later without an error when another save moved the home first", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness();
    harness.home.commit.mockRejectedValueOnce(new HomeSaveConflictError());

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.sleep_deferred",
        reason: "saved_elsewhere",
      }),
    );
  });

  it("keeps a computer its provider is slow to stop running and checks again later", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const harness = idleHarness();
    harness.sandbox.stop.mockRejectedValueOnce(
      new SandboxUnresponsiveError("Boat sandbox did not reach archived"),
    );

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    expect(harness.computer.state).toBe("running");
    expect(harness.computer.providerRef).not.toBeNull();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "computer.sleep_deferred",
        reason: "unresponsive",
      }),
    );
    expect(sink.events.some((event) => event.level === "error")).toBe(false);
  });

  it("schedules the next idle check when stopping fails", async () => {
    const harness = idleHarness();
    harness.sandbox.stop.mockRejectedValueOnce(new Error("stop refused"));

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "stop refused",
    );
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();

    harness.sandbox.stop.mockRejectedValueOnce(new SandboxRateLimitError());
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();
    expect(harness.computer.state).toBe("running");
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(2);
  });

  it("waits out a rate limit that lasts longer than the idle window before checking again", async () => {
    vi.stubEnv("SANDBOX_IDLE_MS", "30000");
    const harness = idleHarness();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    harness.sandbox.stop.mockRejectedValueOnce(new SandboxRateLimitError({ retryAfterMs: 90_000 }));

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();
    expect(harness.jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableAt: new Date(now + 90_000) }),
    );

    harness.sandbox.stop.mockRejectedValueOnce(new SandboxRateLimitError({ retryAfterMs: 5_000 }));
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableAt: new Date(now + 30_000) }),
    );
  });

  it("takes over a suspend claim abandoned by a sleep job that died", async () => {
    const harness = idleHarness();
    const now = harness.computer.updatedAt.getTime() + ABANDONED_SUSPEND_CLAIM_MS;
    vi.spyOn(Date, "now").mockReturnValue(now - 1);
    harness.computer.state = "suspending";

    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("suspending");

    vi.spyOn(Date, "now").mockReturnValue(now);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
  });

  it("gives running and abandoned suspending computers a pending idle check", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const findMany = vi.fn().mockResolvedValue([{ id: "running" }, { id: "abandoned" }]);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const sweep = createIdleComputerSweeper({
      prisma: { computer: { findMany } } as unknown as PrismaClient,
      jobs: { enqueue } as unknown as JobPublisher,
    });

    await sweep();
    await sweep();

    const abandonedBefore = new Date(now - ABANDONED_SUSPEND_CLAIM_MS);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        providerRef: { not: null },
        kind: { not: "desktop" },
        OR: [{ state: "running" }, { state: "suspending", updatedAt: { lte: abandonedBefore } }],
      },
      select: { id: true },
    });
    for (const id of ["running", "abandoned"]) {
      expect(enqueue).toHaveBeenCalledWith({
        name: "computer.sleep",
        payload: { computerId: id },
        availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS),
        replaceKey: `computer.sleep:${id}`,
        keepExisting: true,
        replaceLockedBefore: abandonedBefore,
      });
    }
    expect(enqueue).toHaveBeenCalledTimes(2);

    vi.stubEnv("SANDBOX_IDLE_MS", "0");
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000);
    await sweep();
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("stops a computer whose sandbox is gone instead of retrying the checkpoint", async () => {
    const gone = Object.assign(new Error("Paused sandbox computer not found"), {
      name: "SandboxNotFoundError",
    });
    const harness = idleHarness({ exportError: gone });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.state).toBe("stopped");
    expect(harness.computer.providerRef).toBeNull();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(goneRuns(harness)).toEqual([harness.computer.id]);
  });

  it("notes when the provider last reported the computer running", async () => {
    const runningSince = new Date(Date.now() - 30 * 60_000);
    const harness = idleHarness({ runningAtProvider: true, runningSince });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledWith({
      where: { computerId: harness.computer.id, startedAt: runningSince, endedAt: null },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it("does not note a computer the provider no longer reports running", async () => {
    const harness = idleHarness({ runningAtProvider: false, runningSince: new Date() });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.computerRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastSeenAt: expect.any(Date) } }),
    );
  });

  it("ends the computer's run when idle shutdown suspends it", async () => {
    const harness = idleHarness();

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.state).toBe("suspended");
    expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledOnce();
    expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ computerId: harness.computer.id, endedAt: null }),
        data: expect.objectContaining({ endReason: "idle" }),
      }),
    );
  });

  it("still suspends when the usage write fails", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
    const harness = idleHarness();
    harness.prisma.computerRun.updateMany.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).resolves.toBeUndefined();

    expect(harness.computer.state).toBe("suspended");
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "error", message: "computer.run_record_failed" }),
    );
  });

  it("leaves the run open when a stop is called off", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.computerRun.updateMany).not.toHaveBeenCalled();
  });

  it("stops a computer whose sandbox is gone before the background-work probe", async () => {
    const gone = Object.assign(new Error("Paused sandbox computer not found"), {
      name: "SandboxNotFoundError",
    });
    const harness = idleHarness({ probeError: gone, exportError: gone });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.computer.state).toBe("stopped");
    expect(harness.computer.providerRef).toBeNull();
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("retains the saved revision when the database transition after stopping fails", async () => {
    const harness = idleHarness();
    const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
    harness.prisma.computer.updateMany.mockImplementation(async (args) => {
      if (args.data.state === "suspended") throw new Error("database unavailable");
      return updateMany(args);
    });
    harness.sandbox.stop.mockImplementationOnce(async () => {
      expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "database unavailable",
    );

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
  });

  it.each(["failure", "lost claim"])(
    "does not stop when recording the revision encounters a %s",
    async (outcome) => {
      const harness = idleHarness();
      const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
      harness.prisma.computer.updateMany.mockImplementation(async (args) => {
        if (args.data.homeRevision) {
          if (outcome === "failure") throw new Error("database unavailable");
          harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
        }
        return updateMany(args);
      });

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      if (outcome === "failure") await expect(sleep).rejects.toThrow("database unavailable");
      else await sleep;

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.computer.homeRevision).toBe("rev-before");
      expect(harness.computer.state).toBe(outcome === "failure" ? "running" : "suspending");
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["checkpoint failure", "stop failure", "stop success"])(
    "preserves a newer lifecycle owner after %s",
    async (stage) => {
      const harness = idleHarness();
      const invalidate = () => {
        harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
      };
      if (stage === "checkpoint failure") {
        harness.home.commit.mockImplementationOnce(async () => {
          invalidate();
          throw new Error("checkpoint interrupted");
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(async () => {
          invalidate();
          if (stage === "stop failure") throw new Error("stop interrupted");
        });
      }

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      // Losing the claim after a clean stop is the new owner's business, not a job failure.
      if (stage === "stop success") await sleep;
      else await expect(sleep).rejects.toThrow();

      expect(harness.computer.state).toBe("suspending");
      expect(harness.events.append).not.toHaveBeenCalled();
    },
  );
});

describe("maximum active lifetime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z").getTime();
  const longAgo = new Date(now - DEFAULT_COMPUTER_MAX_ACTIVE_MS - 1);
  const recently = new Date(now - 60_000);

  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["0", 0],
    ["garbage", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["-1", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["Infinity", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["NaN", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["59999", DEFAULT_COMPUTER_MAX_ACTIVE_MS],
    ["60000", 60_000],
    ["1800000", 30 * 60_000],
  ])("parses COMPUTER_MAX_ACTIVE_MS=%j", (value, expected) => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", value);
    expect(computerMaxActiveMs()).toBe(expected);
  });

  it.each([undefined, false])("does not cap a provider reporting %s", async (billing) => {
    const harness = idleHarness({
      billsWhileRunning: billing,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(2);
    for (const [job] of harness.jobs.enqueue.mock.calls) {
      expect(job.availableAt).toEqual(new Date(now + DEFAULT_SANDBOX_IDLE_MS));
    }
  });

  it("disables the cap on a billing provider with 0", async () => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", "0");
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    for (const [job] of harness.jobs.enqueue.mock.calls) {
      expect(job.availableAt).toEqual(new Date(now + DEFAULT_SANDBOX_IDLE_MS));
    }
  });

  it("honours a custom thirty-minute cap", async () => {
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", "1800000");
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 30 * 60_000),
      backgroundWorkProbeCode: 0,
    });
    await touchRunningComputer(harness.deps, harness.computer);
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now) }),
    );
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endReason: "active_limit" }) }),
    );
  });

  it("keeps a billed computer past the limit while a coding agent works", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: longAgo,
      codingAgent: "codex",
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(backgroundProbes(harness)).toHaveLength(0);
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });

  it("keeps a viewed computer alive within the limit", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: recently });

    await touchRunningComputer(harness.deps, harness.computer);

    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });

  it("stops extending a viewed computer past the limit and checks it now", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });

    await touchRunningComputer(harness.deps, harness.computer);

    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "computer.sleep", availableAt: new Date(now) }),
    );
  });

  it("suspends past the limit even while background work keeps it busy", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: longAgo,
      backgroundWorkProbeCode: 0,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
    expect(harness.computer.runningSince).toBeNull();
  });

  it("still waits for background work within the limit", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: recently,
      backgroundWorkProbeCode: 0,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
  });

  it("suspends past the limit under a run that is only waiting", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.leaseExpiresAt ? null : { id: "waiting-for-approval" },
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("keeps a controlled computer up within the limit and stops it past the limit, ending control", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: new Date(now) });
    Object.assign(harness.computer, {
      controlHolder: "user",
      controlLeaseId: "lease",
      controlLeaseExpiresAt: new Date(now + 60_000),
    });

    // Within the limit each check-in pushes the idle check a full idle window out.
    vi.setSystemTime(now + 60_000);
    Object.assign(harness.computer, { controlLeaseExpiresAt: new Date(now + 120_000) });
    await touchRunningComputer(harness.deps, harness.computer);
    expect(harness.jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableAt: new Date(now + 60_000 + DEFAULT_SANDBOX_IDLE_MS) }),
    );
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();

    // A page that keeps checking in renews control, but not past the lifetime limit.
    const past = now + DEFAULT_COMPUTER_MAX_ACTIVE_MS + 60_000;
    vi.setSystemTime(past);
    Object.assign(harness.computer, { controlLeaseExpiresAt: new Date(past + 60_000) });
    await touchRunningComputer(harness.deps, harness.computer);
    expect(harness.jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableAt: new Date(past) }),
    );
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer).toMatchObject({ state: "suspended", controlHolder: "none" });
  });

  it("rechecks a waiting takeover when its grace ends", async () => {
    const requestedAt = new Date(now - TAKEOVER_IDLE_GRACE_MS + 60_000);
    const harness = idleHarness({ takeoverRequestedAt: requestedAt });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        availableAt: new Date(requestedAt.getTime() + TAKEOVER_IDLE_GRACE_MS),
      }),
    );
  });

  it("suspends a computer once a waiting takeover outlasts its grace", async () => {
    const harness = idleHarness({
      takeoverRequestedAt: new Date(now - TAKEOVER_IDLE_GRACE_MS - 1),
    });
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting-for-user" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["within", recently],
    ["past", longAgo],
  ])(
    "suspends a billed computer %s the lifetime limit inside the takeover grace",
    async (_, runningSince) => {
      const harness = idleHarness({
        billsWhileRunning: true,
        runningSince,
        takeoverRequestedAt: new Date(now - 60_000),
      });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.prisma.event.findFirst).not.toHaveBeenCalled();
      expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    },
  );

  it("holds a waiting takeover under user control without the grace", async () => {
    const harness = idleHarness({
      takeoverRequestedAt: new Date(now - TAKEOVER_IDLE_GRACE_MS - 60_000),
    });
    Object.assign(harness.computer, {
      controlHolder: "user",
      controlLeaseId: "lease",
      controlLeaseExpiresAt: new Date(now + 60_000),
    });
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting-for-user" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.event.findFirst).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });

  it("does not pull the computer out from under a run that is executing", async () => {
    const harness = idleHarness({ billsWhileRunning: true, runningSince: longAgo });
    harness.prisma.run.findFirst.mockResolvedValue({ id: "executing" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["leased", "running"] },
          leaseExpiresAt: { gt: new Date(now) },
        }),
      }),
    );
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
    );
  });

  describe("on providers that do not bill while running", () => {
    const unbilledLimit = 60 * 60_000;
    const pastUnbilled = new Date(now - unbilledLimit - 1);

    it.each([
      [undefined, 0],
      ["0", 0],
      ["garbage", 0],
      ["", 0],
      ["-1", 0],
      ["Infinity", 0],
      ["NaN", 0],
      ["59999", 0],
      ["60000", 60_000],
      ["3600000", 60 * 60_000],
    ])("parses COMPUTER_MAX_ACTIVE_UNBILLED_MS=%j", (value, expected) => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", value);
      expect(unbilledComputerMaxActiveMs()).toBe(expected);
    });

    it.each([undefined, false])(
      "keeps background work holding a computer (%s) when the cap is unset",
      async (billing) => {
        const harness = idleHarness({
          billsWhileRunning: billing,
          runningSince: new Date(now - 30 * 24 * 60 * 60_000),
          backgroundWorkProbeCode: 0,
        });

        await touchRunningComputer(harness.deps, harness.computer);
        await sleepComputerIfIdle(harness.deps, harness.computer.id);

        expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
        expect(harness.sandbox.stop).not.toHaveBeenCalled();
      },
    );

    it("still waits for background work within the cap", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", String(unbilledLimit));
      const harness = idleHarness({
        billsWhileRunning: false,
        runningSince: new Date(now - unbilledLimit + 60_000),
        backgroundWorkProbeCode: 0,
      });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    });

    it.each([undefined, false])(
      "suspends a computer (%s) past the cap even while background work keeps it busy",
      async (billing) => {
        vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", String(unbilledLimit));
        const harness = idleHarness({
          billsWhileRunning: billing,
          runningSince: pastUnbilled,
          backgroundWorkProbeCode: 0,
        });

        await touchRunningComputer(harness.deps, harness.computer);
        expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
        expect(harness.jobs.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ name: "computer.sleep", availableAt: new Date(now) }),
        );

        await sleepComputerIfIdle(harness.deps, harness.computer.id);

        expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
        expect(harness.sandbox.stop).toHaveBeenCalledOnce();
        expect(harness.computer.state).toBe("suspended");
        expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ endReason: "active_limit" }) }),
        );
      },
    );

    it("does not pull the computer out from under a run that is executing past the cap", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", String(unbilledLimit));
      const harness = idleHarness({
        billsWhileRunning: false,
        runningSince: pastUnbilled,
        backgroundWorkProbeCode: 0,
      });
      harness.prisma.run.findFirst.mockResolvedValue({ id: "executing" });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.prisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["leased", "running"] } }),
        }),
      );
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
    });

    it("stops a computer the user is controlling past the cap", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", String(unbilledLimit));
      const harness = idleHarness({ billsWhileRunning: false, runningSince: pastUnbilled });
      Object.assign(harness.computer, {
        controlHolder: "user",
        controlLeaseId: "lease",
        controlLeaseExpiresAt: new Date(now + 60_000),
      });

      await touchRunningComputer(harness.deps, harness.computer);
      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.stop).toHaveBeenCalledOnce();
      expect(harness.computer.controlHolder).toBe("none");
    });

    it("keeps a computer past the cap while a coding agent works", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", String(unbilledLimit));
      const harness = idleHarness({
        billsWhileRunning: false,
        runningSince: pastUnbilled,
        codingAgent: "codex",
      });

      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
      expect(backgroundProbes(harness)).toHaveLength(0);
    });

    it("does not apply to a billing provider", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", "60000");
      const harness = idleHarness({
        billsWhileRunning: true,
        runningSince: new Date(now - DEFAULT_COMPUTER_MAX_ACTIVE_MS + 60_000),
        backgroundWorkProbeCode: 0,
      });

      await touchRunningComputer(harness.deps, harness.computer);
      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.keepAlive).toHaveBeenCalledTimes(2);
      expect(harness.sandbox.stop).not.toHaveBeenCalled();

      vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", "0");
      harness.computer.runningSince = longAgo;
      await sleepComputerIfIdle(harness.deps, harness.computer.id);
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
    });

    it("never caps a native desktop computer", async () => {
      vi.stubEnv("COMPUTER_MAX_ACTIVE_UNBILLED_MS", "60000");
      const harness = idleHarness({
        billsWhileRunning: false,
        runningSince: new Date(now - 30 * 24 * 60 * 60_000),
        backgroundWorkProbeCode: 0,
      });
      harness.computer.kind = "desktop";

      await touchRunningComputer(harness.deps, harness.computer);
      await sleepComputerIfIdle(harness.deps, harness.computer.id);

      expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
      expect(harness.jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ availableAt: new Date(now + DEFAULT_SANDBOX_IDLE_MS) }),
      );
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
    });
  });
});

describe("monthly computer allowance", () => {
  const now = new Date("2026-01-20T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
    vi.stubEnv("COMPUTER_MAX_ACTIVE_MS", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("saves and stops a computer once the month's allowance is spent, and says so once", async () => {
    // $5 at the default $0.20 an hour.
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 60_000),
      backgroundWorkProbeCode: 0,
      computerHours: 25,
    });
    harness.prisma.run.findFirst.mockResolvedValue({ id: "executing" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.$queryRaw).toHaveBeenCalled();
    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
    expect(harness.prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endReason: "allowance" }) }),
    );
    expect(harness.prisma.message.create).toHaveBeenCalledOnce();
    expect(harness.prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "system",
          blocks: [
            {
              kind: "meta",
              text: "No computer hours left. The computer was saved and stopped.",
            },
          ],
        }),
      }),
    );
  });

  it("keeps a busy computer running while allowance is left", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 60_000),
      backgroundWorkProbeCode: 0,
      computerHours: 24,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
  });

  it("stops a computer whose allowance is spent even while a person is in control", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 60_000),
      computerHours: 25,
    });
    Object.assign(harness.computer, {
      controlHolder: "user",
      controlLeaseId: "lease",
      controlLeaseExpiresAt: new Date(now + 60_000),
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer).toMatchObject({ state: "suspended", controlHolder: "none" });
    // Control ends through the shared helper, which drafts a recording made under it.
    expect(harness.deps.events.draftRecordingsOfLease).toHaveBeenCalledWith({
      spaceId: harness.computer.spaceId,
      leaseId: "lease",
    });
  });

  it("stops a computer whose allowance is spent even while a coding agent works", async () => {
    const harness = idleHarness({
      billsWhileRunning: true,
      runningSince: new Date(now - 60_000),
      codingAgent: "codex",
      computerHours: 25,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.state).toBe("suspended");
  });

  it("never limits a computer that does not bill while running", async () => {
    const harness = idleHarness({
      billsWhileRunning: false,
      runningSince: new Date(now - 60_000),
      backgroundWorkProbeCode: 0,
      computerHours: 500,
    });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });
});

describe("background work launch and probe", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const markers = new Set<string>();

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    for (const marker of markers) {
      rmSync(marker, { force: true, recursive: true });
    }
    markers.clear();
  });

  function probeBackgroundWork(markerId: string, setup = ""): Promise<number> {
    const child = spawn(
      "bash",
      ["-c", `${setup}\n${BACKGROUND_WORK_PROBE}`, "rakazo-background-probe", markerId],
      { stdio: "ignore", detached: true },
    );
    children.push(child);
    return processExit(child);
  }

  it.skipIf(process.platform === "win32")(
    "detects active work only for the literal launch marker id, including glob characters",
    async () => {
      const databaseId = `computer-db-[literal]*?-${randomUUID()}`;
      const providerRef = `provider-${randomUUID()}`;
      const launchId = "active";
      markers.add(`/tmp/rakazo-background-${databaseId}-run-1-${launchId}`);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          databaseId,
          "run-1",
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(databaseId)).toBe(0);
      // ComputerRef.id is providerRef today; probing that path must not see the DB-id marker.
      expect(await probeBackgroundWork(providerRef)).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32").each([true, false])(
    "sweeps every stale marker with held background work: %s",
    async (held) => {
      const markerId = `computer-sweep-${randomUUID()}`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-a-held`;
      const staleMarkers = [
        `/tmp/rakazo-background-${markerId}-run-1-b-stale`,
        `/tmp/rakazo-background-${markerId}-run-2-c-stale`,
      ];
      for (const marker of [activeMarker, ...staleMarkers]) markers.add(marker);

      if (held) {
        const active = spawn(
          "bash",
          [
            "-c",
            BACKGROUND_WORK_LAUNCH,
            "rakazo-background-launch",
            markerId,
            "run-1",
            "a-held",
            "exec sleep 30",
          ],
          { stdio: "ignore", detached: true },
        );
        children.push(active);
        await expect.poll(() => existsSync(activeMarker)).toBe(true);
      }
      for (const marker of staleMarkers) writeFileSync(marker, "");

      expect(await probeBackgroundWork(markerId)).toBe(held ? 0 : 1);
      for (const marker of staleMarkers) expect(existsSync(marker)).toBe(false);
      expect(existsSync(activeMarker)).toBe(held);
      expect(await probeBackgroundWork(markerId)).toBe(held ? 0 : 1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a completed marker without blocking a later launch",
    async () => {
      const markerId = `computer-relaunch-${randomUUID()}`;
      const completedMarker = `/tmp/rakazo-background-${markerId}-run-1-completed`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-active`;
      markers.add(completedMarker);
      markers.add(activeMarker);
      const completed = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "completed",
          "true",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(completed);

      expect(await processExit(completed)).toBe(0);
      expect(await probeBackgroundWork(markerId)).toBe(1);
      expect(existsSync(completedMarker)).toBe(false);

      const active = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(active);
      await expect.poll(() => probeBackgroundWork(markerId)).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run the command when its marker cannot be opened",
    async () => {
      const markerId = `computer-marker-error-${randomUUID()}`;
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      mkdirSync(marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing marker symlink",
    async () => {
      const markerId = `computer-marker-symlink-${randomUUID()}`;
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      symlinkSync(commandRan, marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancel tears down background shell work for that run",
    async () => {
      const computerId = `computer-cancel-${randomUUID()}`;
      const runId = "run-cancel-1";
      const launchId = "active";
      const marker = `/tmp/rakazo-background-${computerId}-${runId}-${launchId}`;
      markers.add(marker);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          runId,
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(computerId)).toBe(0);

      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId],
        { stdio: "ignore", detached: true },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      expect(await probeBackgroundWork(computerId)).toBe(1);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "cancels every holder of a deleted marker on a duplicated FD without touching another run",
    async () => {
      const computerId = `computer-deleted-${randomUUID()}`;
      const marker = `/tmp/rakazo-background-${computerId}-cancel-active`;
      const otherMarker = `/tmp/rakazo-background-${computerId}-other-active`;
      const ready = `/tmp/rakazo-background-ready-${randomUUID()}`;
      for (const file of [marker, otherMarker, ready]) markers.add(file);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          "cancel",
          "active",
          `exec 8>&9; exec 9>&-; rm -- '${marker}'; sleep 30 & printf %s "$!" >'${ready}'; wait`,
        ],
        { stdio: "ignore", detached: true },
      );
      const unrelated = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          "other",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launched, unrelated);
      await expect.poll(() => existsSync(ready) && existsSync(otherMarker)).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(await probeBackgroundWork(`${computerId}-cancel`)).toBe(0);
      const holderPid = readFileSync(ready, "utf8");
      expect(existsSync(`/proc/${holderPid}/fd/8`)).toBe(true);
      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, "cancel"],
        { stdio: "ignore", detached: true },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      await expect.poll(() => existsSync(`/proc/${holderPid}/fd/8`)).toBe(false);
      expect(await probeBackgroundWork(`${computerId}-cancel`)).toBe(1);
      expect(unrelated.kill(0)).toBe(true);
      expect(existsSync(otherMarker)).toBe(true);
      expect(await probeBackgroundWork(computerId)).toBe(0);
    },
  );

  it.skipIf(process.platform !== "linux").each([
    { status: 1, partial: false },
    { status: 127, partial: false },
    { status: 1, partial: true },
  ])(
    "keeps markers and returns unknown when the filesystem scan fails with %j",
    async ({ status, partial }) => {
      const computerId = `computer-unknown-${randomUUID()}`;
      const marker = `/tmp/rakazo-background-${computerId}-run-active`;
      markers.add(marker);
      writeFileSync(marker, "");
      const unrelated = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      children.push(unrelated);
      const output = partial ? `printf '%s\\n' '${unrelated.pid}';` : "";
      const setup = `python3() { ${output} return ${status}; }`;
      expect(await probeBackgroundWork(computerId, setup)).toBe(2);
      expect(existsSync(marker)).toBe(true);
      const cancel = spawn(
        "bash",
        ["-c", `${setup}\n${CANCEL_COMPUTER_RUN_WORK}`, "cancel", computerId, "run"],
        { stdio: "ignore", detached: true },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(unrelated.kill(0)).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux").each([
    { operation: "readlink", errno: 2, status: 1 },
    { operation: "readlink", errno: 3, status: 1 },
    { operation: "readlink", errno: 13, status: 1 },
    { operation: "readlink", errno: 1, status: 1 },
    { operation: "readlink", errno: 5, status: 2 },
    { operation: "scandir", errno: 13, status: 2 },
  ])("handles filesystem errors without widening scan authority %j", async (failure) => {
    const computerId = `computer-errno-${randomUUID()}`;
    const marker = `/tmp/rakazo-background-${computerId}-run-active`;
    markers.add(marker);
    writeFileSync(marker, "");
    const script = [
      "import os, sys",
      "sys.argv = sys.argv[1:]",
      "def fail(*args, **kwargs):",
      `    raise OSError(${failure.errno}, "injected filesystem failure")`,
      `os.${failure.operation} = fail`,
      "exec(sys.stdin.read())",
    ].join("\n");
    const setup = `python3() { command python3 -c '${script}' "$@"; }`;
    expect(await probeBackgroundWork(computerId, setup)).toBe(failure.status);
    expect(existsSync(marker)).toBe(failure.status === 2);
  });
});

describe("CANCEL_PRIMARY_BROWSER_WORK", () => {
  it("targets the primary profile and matches browser argv0 only", () => {
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(".browser-profiles/chromium");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("chromium-screen-");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain('argv0=""; IFS= read -r -d "" argv0');
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/chromium|*/chromium-*|chromium|chromium-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/firefox|*/firefox-*|firefox|firefox-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[c]hromium*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[f]irefox*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[g]oogle-chrome*");
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });
});

function idleHarness(
  options: {
    backgroundWorkProbeCode?: number;
    backgroundWorkProbeCodes?: number[];
    backgroundWorkProbeFailed?: boolean;
    codingAgent?: string;
    exportError?: Error;
    persistentHome?: boolean;
    probeError?: Error;
    providerBackgroundWorkStatus?: "active" | "idle" | "unknown";
    runningSince?: Date | null;
    billsWhileRunning?: boolean;
    takeoverRequestedAt?: Date;
    stoppedAtProvider?: boolean;
    homeRevisionAt?: Date | null;
    runSinceSave?: boolean;
    takeoverSinceSave?: boolean;
    runningAtProvider?: boolean;
    /** Hours an own-key organization's computers ran this month; unset leaves billing off. */
    computerHours?: number;
  } = {},
) {
  const backgroundWorkProbeCodes = [...(options.backgroundWorkProbeCodes ?? [])];
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    homeRevision: "rev-before",
    providerRef: "computer",
    kind: "e2b",
    state: "running",
    spaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlUserId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionRunId: null as string | null,
    executionBotId: null,
    runningSince: options.runningSince ?? null,
    homeRevisionAt: options.homeRevisionAt ?? null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const notices = new Map<string, { id: string }>();
  const prisma = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
    $queryRaw: vi.fn(async () => [{ kind: "e2b", hours: options.computerHours ?? 0 }]),
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ modelCreditsEnabled: options.computerHours !== undefined })),
    },
    organization: {
      findUnique: vi.fn(async () => ({ modelCredits: { mode: "byok" }, billing: null })),
    },
    space: { findUnique: vi.fn(async () => ({ organizationId: "organization" })) },
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1, nextEventSeq: 1 }) },
    message: {
      findUnique: vi.fn(
        async ({ where }) => notices.get(where.threadId_clientNonce.clientNonce) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        const message = { id: "notice" };
        notices.set(data.clientNonce, message);
        return message;
      }),
    },
    computer: {
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
      findUnique: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          return { count: 0 };
        Object.assign(computer, args.data);
        return { count: 1 };
      }),
    },
    run: {
      // Only the check for changes since the last save asks for runs updated after a time.
      findFirst: vi.fn(async ({ where }) =>
        options.runSinceSave && where.updatedAt ? { id: "later-run" } : null,
      ),
      findUnique: vi.fn(async () => null as { status: string } | null),
      findMany: vi
        .fn()
        .mockResolvedValue(options.takeoverRequestedAt ? [{ id: "waiting-for-user" }] : []),
    },
    event: {
      create: vi.fn().mockResolvedValue({ seq: 1 }),
      findFirst: vi.fn(async ({ where }) => {
        if (where.type === "computer.takeover.granted") {
          return options.takeoverSinceSave ? { id: "later-takeover" } : null;
        }
        return options.takeoverRequestedAt && options.takeoverRequestedAt > where.createdAt.gt
          ? { createdAt: options.takeoverRequestedAt }
          : null;
      }),
    },
    computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    computerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
    },
  };
  const sandbox = {
    describe: () => ({ capabilities: { persistentHome: options.persistentHome ?? false } }),
    billsWhileRunning:
      options.billsWhileRunning === undefined ? undefined : vi.fn(() => options.billsWhileRunning),
    execute: vi.fn(async function* (_computer: unknown, request: { argv: string[] }) {
      if (options.probeError) throw options.probeError;
      if (request.argv[0] === "df") {
        yield {
          type: "stdout",
          data: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100 91 9 91% /home\n",
        } as const;
        yield { type: "exit", code: 0 } as const;
        return;
      }
      if (request.argv[3] === "rakazo-coding-agent-probe") {
        if (options.codingAgent)
          yield { type: "stdout", data: `${options.codingAgent}\n` } as const;
        yield { type: "exit", code: options.codingAgent ? 0 : 1 } as const;
        return;
      }
      const code = backgroundWorkProbeCodes.shift() ?? options.backgroundWorkProbeCode ?? 1;
      if (code === 1 && !options.backgroundWorkProbeFailed) {
        yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
      }
      yield { type: "exit", code } as const;
    }),
    keepAlive: vi.fn().mockResolvedValue(undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...(options.stoppedAtProvider ? { isStopped: vi.fn().mockResolvedValue(true) } : {}),
    ...(options.runningAtProvider === undefined
      ? {}
      : { isRunning: vi.fn().mockResolvedValue(options.runningAtProvider) }),
    ...(options.providerBackgroundWorkStatus
      ? {
          inspectBackgroundWork: vi.fn().mockResolvedValue(options.providerBackgroundWorkStatus),
        }
      : {}),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = {
    append: vi.fn().mockResolvedValue({}),
    notify: vi.fn().mockResolvedValue(undefined),
    draftRecordingsOfLease: vi.fn().mockResolvedValue([]),
  };
  return {
    computer,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}

function backgroundProbes(harness: ReturnType<typeof idleHarness>) {
  return harness.sandbox.execute.mock.calls.filter(
    ([, request]) => request.argv[3] === "rakazo-background-probe",
  );
}

function processExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** The computers whose open run each raw `gone` end closed, in order. */
function goneRuns(harness: { prisma: { $executeRaw: ReturnType<typeof vi.fn> } }) {
  return harness.prisma.$executeRaw.mock.calls
    .filter(([, , reason]) => reason === "gone")
    .map(([, , , computerId]) => computerId);
}
