import { getHeapStatistics } from "node:v8";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import {
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  messagingReplyJob,
  teamChatAmbientJob,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DatabaseOutage, databaseCapacityBackoffMs } from "@rakazo/db";
import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@rakazo/logging";
import type * as GraphileWorker from "graphile-worker";
import type { JobHelpers, Runner } from "graphile-worker";
import { makeWorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("node:v8", () => ({
  getHeapStatistics: vi.fn(() => ({
    used_heap_size: 0,
    external_memory: 0,
    heap_size_limit: 1024 ** 3,
  })),
}));

vi.mock("graphile-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof GraphileWorker>()),
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils: vi.fn(),
}));

import { RunExecutionHost } from "./run-execution.js";
import {
  createReservedGraphileJobWorkerHost,
  createRoutineRetryNoticeReconciler,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "memory.retain-turn": vi.fn(async () => undefined),
    "memory.purge-history": vi.fn(async () => undefined),
    "messaging.send": vi.fn(async () => undefined),
    "messaging.reply": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.progress": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "team_chat.engage": vi.fn(async () => undefined),
    "team_chat.ambient": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "media.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockRunner() {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => {
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    rejectLife: (error: unknown) => life.reject(error),
  };
}

/** What Graphile hands a task besides its payload: here, a first try of the default 25. */
const helpers = { job: { id: "1", attempts: 1, max_attempts: 25 } } as unknown as JobHelpers;

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("databaseCapacityBackoffMs", () => {
  it("matches the worker startup backoff curve", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobPublisher.enqueue", () => {
  it.each([
    ["user", "run.interactive"],
    ["follow_up", "run.interactive"],
    ["messaging", "run.interactive"],
    ["created", "run.interactive"],
    ["routine", "run.continue"],
    ["bot_message", "run.continue"],
    ["tickets", "run.continue"],
    ["webhook", "run.continue"],
    ["cloud_agent", "run.continue"],
  ])("routes %s from the persisted trigger to %s", async (trigger, task) => {
    const addJob = vi.fn(async () => undefined);
    vi.mocked(makeWorkerUtils).mockResolvedValue({ addJob, release: vi.fn() } as never);
    const findUnique = vi.fn(async () => ({ trigger }));
    const prisma = { run: { findUnique } } as unknown as Pick<PrismaClient, "run">;
    const publisher = new GraphileJobPublisher({} as Pool, prisma);
    try {
      await publisher.enqueue({ name: "run.continue", payload: { runId: "fixture-run" } });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: "fixture-run" },
        select: { trigger: true },
      });
      expect(addJob).toHaveBeenCalledWith(task, expect.anything(), expect.anything());
    } finally {
      await publisher.close();
    }
  });
  function publisherWith(addJob: ReturnType<typeof vi.fn>) {
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob,
      release: vi.fn(async () => undefined),
    } as never);
    return new GraphileJobPublisher({} as Pool);
  }

  it("forwards the job's maxAttempts cap to graphile", async () => {
    const addJob = vi.fn(async () => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(historyCompactJob("thread-1"));
    expect(addJob).toHaveBeenCalledWith(
      "history.compact",
      expect.anything(),
      expect.objectContaining({ maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS }),
    );
    await publisher.close();
  });

  it("leaves the queue default when the job sets no cap", async () => {
    const addJob = vi.fn(async (..._args: unknown[]) => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(messagingReplyJob("run-1"));
    const options = addJob.mock.calls[0]?.[2] as { maxAttempts?: number } | undefined;
    expect(options?.maxAttempts).toBeUndefined();
    await publisher.close();
  });

  it("forwards the job's queue so one conversation's jobs run one at a time", async () => {
    const addJob = vi.fn(async (..._args: unknown[]) => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(teamChatAmbientJob("conversation-1", new Date()));
    await publisher.enqueue(historyCompactJob("thread-1"));
    expect(
      addJob.mock.calls.map(([, , spec]) => (spec as { queueName?: string }).queueName),
    ).toEqual(["team_chat.ambient:conversation-1", undefined]);
    await publisher.close();
  });

  type KeyedJob = { attempts: number; maxAttempts: number; runAt: Date; lockedAt?: Date };

  // graphile-worker add_job: unsafe_dedupe on conflict bumps revision only.
  // replace sets attempts = 0 and run_at = excluded.run_at, or detaches a locked
  // job and inserts a new one.
  function graphileJobs(jobs: Map<string, KeyedJob>) {
    const query = vi.fn(async (_sql: string, params?: readonly unknown[]) => {
      const job = jobs.get(String(params?.[0]));
      return {
        rows: job
          ? [
              {
                attempts: job.attempts,
                max_attempts: job.maxAttempts,
                locked_at: job.lockedAt ?? null,
              },
            ]
          : [],
      };
    });
    const addJob = vi.fn(
      async (
        _name: string,
        _payload: unknown,
        spec: { runAt?: Date; jobKey?: string; maxAttempts?: number; jobKeyMode?: string },
      ) => {
        const key = spec.jobKey;
        if (!key) return;
        const existing = jobs.get(key);
        if (spec.jobKeyMode === "unsafe_dedupe" && existing) return;
        jobs.set(key, {
          attempts: 0,
          maxAttempts: spec.maxAttempts ?? 25,
          runAt: spec.runAt ?? new Date(),
        });
      },
    );
    const withPgClient = vi.fn(
      async (callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );
    return { query, addJob, withPgClient };
  }

  function publisherOver(jobs: Map<string, KeyedJob>) {
    const graphile = graphileJobs(jobs);
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob: graphile.addJob,
      withPgClient: graphile.withPgClient,
      release: vi.fn(async () => undefined),
    } as never);
    return { publisher: new GraphileJobPublisher({} as Pool), ...graphile };
  }

  it("keeps attempts and run_at while a keyed job still has attempts left", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const jobs = new Map([["run:run-1", { attempts: 2, maxAttempts: 25, runAt }]]);
    const { publisher, addJob, query } = publisherOver(jobs);
    const pulledForward = new Date("2030-01-01T00:00:01.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "pulled-forward" },
      replaceKey: "run:run-1",
      availableAt: pulledForward,
      keepExisting: true,
    });
    expect(query).toHaveBeenCalledWith(
      "select attempts, max_attempts, locked_at from graphile_worker._private_jobs where key = $1",
      ["run:run-1"],
    );
    expect(addJob).toHaveBeenCalledWith(
      "run.continue",
      expect.anything(),
      expect.objectContaining({
        jobKey: "run:run-1",
        jobKeyMode: "unsafe_dedupe",
        runAt: pulledForward,
      }),
    );
    expect(jobs.get("run:run-1")).toEqual({ attempts: 2, maxAttempts: 25, runAt });
    await publisher.close();
  });

  it("replaces an exhausted job so it is re-enqueued with fresh attempts", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const jobs = new Map([["run:run-1", { attempts: 3, maxAttempts: 3, runAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    const revivedAt = new Date("2030-01-02T00:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "revived" },
      replaceKey: "run:run-1",
      availableAt: revivedAt,
      keepExisting: true,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:run-1")).toEqual({ attempts: 0, maxAttempts: 25, runAt: revivedAt });
    await publisher.close();
  });

  it("keeps a job locked after replaceLockedBefore", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const lockedAt = new Date("2030-01-01T00:00:01.000Z");
    const jobs = new Map([["run:run-1", { attempts: 1, maxAttempts: 25, runAt, lockedAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "retry-pending" },
      replaceKey: "run:run-1",
      availableAt: new Date("2030-01-01T00:00:02.000Z"),
      keepExisting: true,
      replaceLockedBefore: new Date("2030-01-01T00:00:00.000Z"),
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBe("unsafe_dedupe");
    expect(jobs.get("run:run-1")).toEqual({ attempts: 1, maxAttempts: 25, runAt, lockedAt });
    await publisher.close();
  });

  it("replaces a locked job so a worker that died mid-job cannot hold the key", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const lockedAt = new Date("2030-01-01T00:00:01.000Z");
    const jobs = new Map([["run:run-1", { attempts: 1, maxAttempts: 25, runAt, lockedAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    const reclaimedAt = new Date("2030-01-01T04:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "reclaimed" },
      replaceKey: "run:run-1",
      availableAt: reclaimedAt,
      keepExisting: true,
      replaceLockedBefore: lockedAt,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:run-1")).toEqual({ attempts: 0, maxAttempts: 25, runAt: reclaimedAt });
    await publisher.close();
  });

  it("enqueues a keepExisting job when no row has that key", async () => {
    const jobs = new Map<string, KeyedJob>();
    const { publisher, addJob } = publisherOver(jobs);
    const runAt = new Date("2030-01-03T00:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "fresh" },
      replaceKey: "run:missing",
      availableAt: runAt,
      keepExisting: true,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:missing")).toEqual({ attempts: 0, maxAttempts: 25, runAt });
    await publisher.close();
  });
});

describe("reserved Graphile workloads", () => {
  afterEach(() => run.mockReset());

  it("reserves disjoint task lists and stops every runner", async () => {
    const runners = [mockRunner(), mockRunner(), mockRunner()];
    for (const { runner } of runners) run.mockResolvedValueOnce(runner);
    const host = createReservedGraphileJobWorkerHost({} as Pool, { concurrency: 4 });
    await host.start(handlers());
    const configurations = run.mock.calls.map(([options]) => options);
    expect(configurations.map(({ concurrency }) => concurrency)).toEqual([4, 1, 100]);
    // The worker's own shutdown hands back runs first; Graphile must not kill the process.
    expect(configurations.map(({ noHandleSignals }) => noHandleSignals)).toEqual([
      true,
      true,
      true,
    ]);
    // Batched job writes are what Graphile's shutdown waits for before the worker exits.
    const batched = { completeJobBatchDelay: 0, failJobBatchDelay: 0 };
    expect(configurations.map(({ preset }) => preset)).toEqual([
      { worker: batched },
      { worker: batched },
      { worker: { ...batched, localQueue: { size: 10 } } },
    ]);
    expect(Object.keys(configurations[0].taskList)).toEqual(["run.interactive"]);
    expect(Object.keys(configurations[1].taskList)).toEqual(["run.continue"]);
    expect(Object.keys(configurations[2].taskList)).not.toContain("run.continue");
    expect(Object.keys(configurations[2].taskList)).not.toContain("run.interactive");
    expect(Object.keys(configurations[2].taskList)).toContain("computer.sleep");
    await host.stop();
    for (const { runner } of runners) expect(runner.stop).toHaveBeenCalled();
  });

  it("stops runners already started if another workload cannot start", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockRejectedValueOnce(tooMany);
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    await expect(host.start(handlers())).rejects.toBe(tooMany);
    expect(first.runner.stop).toHaveBeenCalled();
  });

  it("does not start another workload after shutdown interrupts startup", async () => {
    const first = mockRunner();
    let release!: (runner: Runner) => void;
    run.mockReturnValueOnce(
      new Promise<Runner>((resolve) => {
        release = resolve;
      }),
    );
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    const starting = host.start(handlers());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await host.stop();
    release(first.runner);
    await starting;
    expect(run).toHaveBeenCalledOnce();
    expect(first.runner.stop).toHaveBeenCalledOnce();
  });

  it("dispatches legacy chat jobs after stopping and restarting", async () => {
    for (let i = 0; i < 6; i++) run.mockResolvedValueOnce(mockRunner().runner);
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    const target = handlers();
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        await host.start(target);
        const background = run.mock.calls[cycle * 3 + 1]?.[0].taskList;
        await background["run.continue"](wrapJobPayload({ runId: "legacy-chat" }), helpers);
        await host.stop();
      }
      expect(target["run.continue"]).toHaveBeenCalledTimes(2);
      expect(target["run.continue"]).toHaveBeenLastCalledWith(
        { runId: "legacy-chat" },
        { onRunStarted: expect.any(Function) },
        { number: 1, max: 25 },
      );
    } finally {
      await host.stop();
    }
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  beforeEach(() => {
    vi.mocked(getHeapStatistics).mockReturnValue({
      used_heap_size: 0,
      external_memory: 0,
      heap_size_limit: 1024 ** 3,
    } as ReturnType<typeof getHeapStatistics>);
    vi.spyOn(process, "availableMemory").mockReturnValue(8 * 1024 ** 3);
    // Keep the host's real cgroup file cache out of admission.
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  });
  afterEach(() => {
    run.mockReset();
    vi.mocked(process.availableMemory).mockRestore();
    vi.mocked(process.constrainedMemory).mockRestore();
    vi.useRealTimers();
  });

  it("stops waiting for a handed-off run that outlives the drain deadline", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1, drainTimeoutMs: 20 });
    const hung = deferred();
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await hung.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"]({ runId: "hung-run" }, helpers);
      await host.stop();
    } finally {
      hung.resolve();
    }
  });

  it("releases dispatch slots after durable handoff and drains executions at shutdown", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 4 });
    const release = deferred();
    const target = handlers();
    let started = 0;
    target["run.continue"] = async (_payload, execution) => {
      started++;
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await Promise.all(
        Array.from({ length: 5 }, (_, index) => dispatch({ runId: `run-${index}` }, helpers)),
      );
      expect(started).toBe(5);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for memory headroom without imposing a resident run count", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1 });
    const releases = [deferred(), deferred(), deferred()];
    const entered: string[] = [];
    const target = handlers();
    target["run.continue"] = async ({ runId }, execution) => {
      entered.push(runId);
      execution!.onRunStarted();
      await releases[Number(runId)]!.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await dispatch({ runId: "0" }, helpers);
      await dispatch({ runId: "1" }, helpers);
      vi.mocked(process.availableMemory).mockReturnValue(40 * 1024 ** 2);
      const third = dispatch({ runId: "2" }, helpers);
      expect(entered).toEqual(["0", "1"]);
      vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
      releases[0]!.resolve();
      await third;
      expect(entered).toEqual(["0", "1", "2"]);
    } finally {
      for (const release of releases) release.resolve();
      await host.stop();
    }
  });

  it("admits many waiting runs without counting external buffers against V8 heap headroom", async () => {
    const host = new RunExecutionHost();
    const release = deferred();
    let entered = 0;
    const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
      entered++;
      onRunStarted();
      await release.promise;
    };
    vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
    vi.mocked(getHeapStatistics).mockReturnValue({
      used_heap_size: 16 * 1024 ** 2,
      external_memory: 2 * 1024 ** 3,
      heap_size_limit: 128 * 1024 ** 2,
    } as ReturnType<typeof getHeapStatistics>);
    try {
      for (let index = 0; index < 100; index++) {
        expect(await host.execute(execute, { waitForCapacity: false })).toBe(true);
      }
      expect(entered).toBe(100);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it.each(["physical", "heap", "heap_and_physical"])(
    "logs %s pressure once and measures recovery without logging every poll",
    async (reason) => {
      vi.useFakeTimers();
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const host = new RunExecutionHost();
      const release = deferred();
      let entered = 0;
      const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
        entered++;
        onRunStarted();
        await release.promise;
      };
      try {
        await host.execute(execute);
        vi.mocked(process.availableMemory).mockReturnValue(
          reason.includes("physical") ? 40 * 1024 ** 2 : 8 * 1024 ** 3,
        );
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: reason.includes("heap") ? 984 * 1024 ** 2 : 0,
          external_memory: 2 * 1024 ** 3,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        const second = host.execute(execute);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(entered).toBe(1);
        expect(sink.events).toEqual([
          expect.objectContaining({
            message: "run.admission_wait",
            "admission.reason": reason,
            "worker.active_runs": 1,
            "memory.available_bytes": reason.includes("physical") ? 40 * 1024 ** 2 : 8 * 1024 ** 3,
            "memory.heap_available_bytes": reason.includes("heap") ? 40 * 1024 ** 2 : 1024 ** 3,
            "memory.reserve_bytes": 40 * 1024 ** 2,
          }),
        ]);
        vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: 0,
          external_memory: 2 * 1024 ** 3,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        await vi.advanceTimersByTimeAsync(1_000);
        await second;
        expect(entered).toBe(2);
        expect(sink.events).toHaveLength(2);
        expect(sink.events[1]).toMatchObject({
          message: "run.admission_resumed",
          "admission.reason": reason,
          "run.admission_wait_ms": 3_000,
          "memory.available_bytes": 64 * 1024 ** 2,
        });
      } finally {
        release.resolve();
        await host.stop();
        installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      }
    },
  );

  it.each(["physical", "heap"])(
    "declines nonwaiting candidates under %s pressure without pinning dispatch or repeating logs",
    async (reason) => {
      vi.useFakeTimers();
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const host = new RunExecutionHost();
      const release = deferred();
      const resident = async ({ onRunStarted }: { onRunStarted: () => void }) => {
        onRunStarted();
        await release.promise;
      };
      const candidate = vi.fn(resident);
      try {
        expect(await host.execute(resident)).toBe(true);
        vi.mocked(process.availableMemory).mockReturnValue(
          reason === "physical" ? 1 : 8 * 1024 ** 3,
        );
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: reason === "heap" ? 984 * 1024 ** 2 : 0,
          external_memory: 0,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        for (let index = 0; index < 8; index++) {
          expect(await host.execute(candidate, { waitForCapacity: false })).toBe(false);
        }
        expect(candidate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]).toMatchObject({
          message: "run.admission_wait",
          "admission.reason": reason,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        vi.mocked(process.availableMemory).mockReturnValue(8 * 1024 ** 3);
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: 0,
          external_memory: 0,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        expect(await host.execute(candidate, { waitForCapacity: false })).toBe(true);
        expect(candidate).toHaveBeenCalledOnce();
        expect(sink.events).toHaveLength(2);
        expect(sink.events[1]).toMatchObject({
          message: "run.admission_resumed",
          "run.admission_wait_ms": 5_000,
        });
        vi.mocked(process.availableMemory).mockReturnValue(1);
        expect(await host.execute(candidate, { waitForCapacity: false })).toBe(false);
        expect(sink.events).toHaveLength(3);
        expect(sink.events[2]).toMatchObject({ message: "run.admission_wait" });
      } finally {
        release.resolve();
        await host.stop();
        installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      }
    },
  );

  it("rejects physical-memory admission waiters and drains resident runs at shutdown", async () => {
    const host = new RunExecutionHost();
    const release = deferred();
    let entered = 0;
    const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
      entered++;
      onRunStarted();
      await release.promise;
    };
    try {
      await host.execute(execute);
      vi.mocked(process.availableMemory).mockReturnValue(1);
      const second = host.execute(execute);
      const rejected = expect(second).rejects.toThrow("Worker is stopping");
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await rejected;
      expect(entered).toBe(1);
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("rejects setup failures through the original queue delivery", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool);
    const error = new Error("fixture setup failure");
    const target = handlers();
    target["run.continue"] = async () => {
      throw error;
    };
    try {
      await host.start(target);
      await expect(
        run.mock.calls[0]![0].taskList["run.continue"]({ runId: "setup-failure" }, helpers),
      ).rejects.toBe(error);
    } finally {
      await host.stop();
    }
  });

  it("rechecks memory freed by GC while resident agents remain active", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1 });
    const release = deferred();
    let entered = 0;
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      entered++;
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await dispatch({ runId: "first" }, helpers);
      vi.mocked(process.availableMemory).mockReturnValue(40 * 1024 ** 2);
      const second = dispatch({ runId: "second" }, helpers);
      expect(entered).toBe(1);
      vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
      await vi.advanceTimersByTimeAsync(1_000);
      await second;
      expect(entered).toBe(2);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("observes a failure after handoff, reports it once and drains tracking", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool);
    const lateFailure = deferred();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await lateFailure.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"]({ runId: "late-failure" }, helpers);
      lateFailure.reject(new Error("fixture execution failure"));
      await host.stop();
      expect(sink.events.filter((event) => event.level === "error")).toEqual([
        expect.objectContaining({
          message: "job.completed",
          "run.id": "late-failure",
          "job.outcome": "error",
        }),
      ]);
    } finally {
      lateFailure.resolve();
      await host.stop();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it.each([
    ["out of connections", tooMany],
    [
      "read-only during a failover",
      Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
        code: "25006",
      }),
    ],
    [
      "refusing connections",
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
    ],
    ["dropping its connection", new Error("Connection terminated unexpectedly")],
  ])("backs off then restarts when the runner stops with the database %s", async (_, error) => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      outage: new DatabaseOutage(),
    });

    await host.start(handlers());
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(error);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("backs off then restarts when job writes stop the runner on a pool checkout timeout", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(new Error("timeout exceeded when trying to connect"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("retries launch with escalating backoff when restart start hits 53300", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    run
      .mockResolvedValueOnce(first.runner)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValueOnce(recovered.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(sleeps).toEqual([200, 400]);

    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalled();
  });

  it("does not restart when the runner fails for a reason other than the database", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });
    await host.start(handlers());
    const superviseTask = (host as unknown as { superviseTask: Promise<void> }).superviseTask;

    first.rejectLife(new Error("runner exploded"));
    await expect(superviseTask).rejects.toThrow("runner exploded");
    expect(run).toHaveBeenCalledTimes(1);

    await host.stop();
  });

  it("logs when history compaction fails permanently", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });

    try {
      await host.start(handlers());
      const on = first.runner.events.on as ReturnType<typeof vi.fn>;
      const failed = on.mock.calls.find((call) => call[0] === "job:failed")?.[1] as
        | ((event: {
            job: {
              task_identifier: string;
              payload: unknown;
              attempts: number;
              max_attempts: number;
            };
            error: unknown;
          }) => void)
        | undefined;
      expect(failed).toBeTypeOf("function");
      failed?.({
        job: {
          task_identifier: "history.compact",
          payload: wrapJobPayload({ threadId: "thread-9" }),
          attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
          max_attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
        },
        error: new Error("The operation was aborted due to timeout"),
      });
      failed?.({
        job: {
          task_identifier: "run.continue",
          payload: wrapJobPayload({ runId: "run-1" }),
          attempts: 25,
          max_attempts: 25,
        },
        error: new Error("handler failed"),
      });
    } finally {
      await host.stop();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }

    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        message: "history.compact failed permanently",
        "thread.id": "thread-9",
        "history.compact.reason": "attempts_exhausted",
        "history.compact.retryable": false,
        "job.attempts": HISTORY_COMPACT_MAX_ATTEMPTS,
        "job.max_attempts": HISTORY_COMPACT_MAX_ATTEMPTS,
        error: expect.objectContaining({ message: "The operation was aborted due to timeout" }),
      }),
    ]);
  });

  it("wakes a pending restart delay when stop is called", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sleepStarted = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleepStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.rejectLife(tooMany);
    await sleepStarted.promise;

    await host.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("createRoutineRetryNoticeReconciler", () => {
  function pendingNotices(payloads: unknown[] = [wrapJobPayload({ runId: "run-1" })]) {
    const pending = payloads.map((payload, index) => ({
      id: String(index + 1),
      revision: 2,
      payload,
    }));
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("select")) {
        return {
          rows: pending
            .filter((job) => BigInt(job.id) > BigInt(String(params?.[0])))
            .slice(0, Number(params?.[1])),
        };
      }
      const index = pending.findIndex(
        (job) => job.id === params?.[0] && job.revision === params?.[1],
      );
      if (index >= 0) pending.splice(index, 1);
      return { rows: [] };
    });
    return { pending, query, pool: { query } as unknown as Pool };
  }

  it("retains a failed callback for recovery by a later reconciliation", async () => {
    const { pending, query, pool } = pendingNotices();
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(pending).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);

    // A new pass has no dependence on an event or in-memory retry state.
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify.mock.calls).toEqual([["run-1"], ["run-1"]]);
    expect(pending).toHaveLength(0);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("revision = $2"), ["1", 2]);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("continues other notices after a failed delivery and skips malformed payloads", async () => {
    const { pool, pending } = pendingNotices([
      { runId: "run-1" },
      wrapJobPayload({ runId: "run-2" }),
      null,
      {},
      { runId: 1 },
      { runId: "" },
    ]);
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockResolvedValue(undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify.mock.calls).toEqual([["run-1"], ["run-2"]]);
    expect(pending.map((job) => job.id)).toEqual(["1", "3", "4", "5", "6"]);
  });

  it("retains the request if acknowledging delivery fails", async () => {
    const { pool, query, pending } = pendingNotices();
    query
      .mockImplementationOnce(async () => ({ rows: [...pending] }))
      .mockRejectedValueOnce(new Error("delete failed"));
    const notify = vi.fn(async () => undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(pending).toHaveLength(1);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);
  });

  it("bounds each pass and advances beyond failures before retrying them", async () => {
    const { pool } = pendingNotices(
      Array.from({ length: 21 }, (_, index) => ({ runId: `run-${index + 1}` })),
    );
    const notify = vi.fn(async () => {
      throw new Error("destination unavailable");
    });
    const reconcile = createRoutineRetryNoticeReconciler(pool, notify);
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(20);
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(21);
    expect(notify).toHaveBeenLastCalledWith("run-21");
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(41);
  });

  it("sends concurrently with a bounded number of active deliveries", async () => {
    const { pool } = pendingNotices(
      Array.from({ length: 20 }, (_, index) => ({ runId: `run-${index}` })),
    );
    const release = deferred();
    let active = 0;
    let peak = 0;
    const notify = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    });
    const delivering = createRoutineRetryNoticeReconciler(pool, notify)();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(4));
    release.resolve();
    await delivering;
    expect(notify).toHaveBeenCalledTimes(20);
    expect(peak).toBe(4);
  });

  it("keeps concurrently replaced work when acknowledging a notice", async () => {
    const { pool, pending } = pendingNotices();
    await createRoutineRetryNoticeReconciler(pool, async () => {
      pending[0] = { id: "1", revision: 3, payload: { runId: "new-run" } };
    })();
    expect(pending).toEqual([{ id: "1", revision: 3, payload: { runId: "new-run" } }]);
  });
});
