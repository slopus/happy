import type { BackgroundJobHandlers, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { RunExecutionHost } from "./run-execution.js";
import { RunJobPublisher, RunStarter, RunWorkerHost, withRunWorker } from "./run-wakeup.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const rows = new Map<string, { status: string; wakeAt: Date | null; trigger?: string }>();
  const updateMany = vi.fn(async ({ where, data }) => {
    const row = rows.get(where.id);
    if (!row || !where.status.in.includes(row.status) || (where.wakeAt === null && row.wakeAt))
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const findMany = vi.fn(
    async (args: { where: { trigger: { in?: string[]; notIn?: string[] } } }) =>
      [...rows]
        .filter(
          ([, row]) =>
            row.status === "queued" &&
            (!row.wakeAt || row.wakeAt.getTime() <= Date.now()) &&
            (args.where.trigger.in
              ? args.where.trigger.in.includes(row.trigger ?? "user")
              : !args.where.trigger.notIn!.includes(row.trigger ?? "user")),
        )
        .map(([id]) => ({ id, botId: id, bot: { computerId: "computer" } })),
  );
  const leases = vi.fn(
    async () => [] as { computerId: string; botId: string; runId: string; expiresAt: Date }[],
  );
  const queueHealth = vi.fn(async () => [
    { delayedRuns: 0, oldestDueAt: null as Date | null, oldestRunId: null as string | null },
  ]);
  const prisma = {
    run: { updateMany, findMany },
    $queryRaw: queueHealth,
    computerExecutionLease: { findMany: leases },
  } as unknown as PrismaClient;
  const realtime = new InMemoryRealtimeFanout();
  const background = {
    enqueue: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  } as unknown as JobPublisher;
  const starter = new RunStarter(realtime);
  const publisher = new RunJobPublisher(prisma, background, starter);
  const host = new RunWorkerHost(prisma, realtime, starter, { intervalMs: 100 });
  return {
    rows,
    prisma,
    realtime,
    background,
    starter,
    publisher,
    host,
    findMany,
    updateMany,
    leases,
    queueHealth,
  };
}

describe("durable direct run wakeups", () => {
  it("keeps scanning under capacity pressure and considers new chats before timer backlog", async () => {
    const f = fixture();
    f.rows.set("timer", { status: "queued", wakeAt: null, trigger: "routine" });
    const admission = vi.spyOn(RunExecutionHost.prototype, "execute").mockResolvedValue(false);
    const entered: string[] = [];
    try {
      await f.host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          f.rows.get(runId)!.status = "completed";
        },
      } as BackgroundJobHandlers);
      await vi.waitFor(() => expect(admission.mock.calls.length).toBeGreaterThan(1));
      expect(entered).toEqual([]);
      expect(f.rows.get("timer")!.status).toBe("queued");
      f.rows.set("chat", { status: "queued", wakeAt: null });
      admission.mockRestore();
      await f.publisher.enqueue(runContinueJob("chat"));
      await vi.waitFor(() => expect(entered).toEqual(["chat", "timer"]));
    } finally {
      admission.mockRestore();
      await f.host.stop();
    }
  });

  it("does not rescan an exhausted lane while another lane finishes its sweep", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const counts = { interactive: 0, background: 0 };
    f.findMany.mockImplementation(async ({ where }) => {
      const lane = where.trigger.in ? "background" : "interactive";
      const page = counts[lane]++;
      if (page >= (lane === "interactive" ? 1 : 2)) return [];
      return Array.from({ length: 100 }, (_, index) => ({
        id: `${lane}-${page}-${index}`,
        createdAt: new Date(page * 100 + index),
        botId: `${lane}-${index}`,
        bot: { computerId: "computer" },
      }));
    });
    const admission = vi.spyOn(RunExecutionHost.prototype, "execute").mockResolvedValue(false);
    try {
      await f.host.start({} as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(1);
      expect(counts).toEqual({ interactive: 2, background: 3 });
    } finally {
      admission.mockRestore();
      await f.host.stop();
    }
  });

  it.each(["interactive", "background"])(
    "reopens chat discovery after a notification during the %s query without restarting timers",
    async (notifiedLane) => {
      vi.useFakeTimers();
      const f = fixture();
      const scans: string[] = [];
      let chatReady = false;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let backgroundPage = 0;
      let notified = false;
      f.findMany.mockImplementation(async ({ where }) => {
        const lane = where.trigger.in ? "background" : "interactive";
        scans.push(lane);
        const readyAtSnapshot = chatReady;
        if (lane === notifiedLane && !notified) {
          notified = true;
          await blocked;
        }
        if (lane === "background") {
          if (backgroundPage++ > 0) return [];
          return [{ id: "timer", botId: "timer", bot: { computerId: "computer" } }];
        }
        return readyAtSnapshot
          ? [{ id: "chat", botId: "chat", bot: { computerId: "computer" } }]
          : [];
      });
      const host = new RunWorkerHost(f.prisma, f.realtime, f.starter, { batchSize: 1 });
      const entered: string[] = [];
      try {
        await host.start({
          "run.continue": async ({ runId }) => {
            entered.push(runId);
            if (runId === "chat") chatReady = false;
          },
        } as BackgroundJobHandlers);
        await vi.advanceTimersByTimeAsync(1);
        expect(notified).toBe(true);
        chatReady = true;
        // A previous release announces work without naming the run.
        await f.realtime.publish("runs:ready", "");
        release();
        await vi.advanceTimersByTimeAsync(1);
        expect(entered).toEqual(["timer", "chat"]);
        expect(scans.slice(0, 4)).toEqual([
          "interactive",
          "background",
          "interactive",
          "background",
        ]);
        expect(backgroundPage).toBe(2);
      } finally {
        release();
        await host.stop();
      }
    },
  );

  it.each(["routine", "reaction"])(
    "discovers new %s work while an interactive sweep is still advancing",
    async (trigger) => {
      vi.useFakeTimers();
      const f = fixture();
      let interactivePage = 0;
      let backgroundReady = false;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.findMany.mockImplementation(async ({ where }) => {
        if (where.trigger.in) {
          if (!backgroundReady) return [];
          backgroundReady = false;
          // Chat pagination has not reached its final, empty page yet.
          expect(interactivePage).toBe(3);
          return [
            {
              id: trigger,
              botId: trigger,
              createdAt: new Date(0),
              bot: { computerId: "computer" },
            },
          ];
        }
        const page = interactivePage++;
        if (page === 1) await blocked;
        if (page >= 3) return [];
        return [
          {
            id: `chat-${page}`,
            botId: `chat-${page}`,
            createdAt: new Date(page * 1_000),
            bot: { computerId: "computer" },
          },
        ];
      });
      const host = new RunWorkerHost(f.prisma, f.realtime, f.starter, { batchSize: 1 });
      const entered: string[] = [];
      try {
        await host.start({
          "run.continue": async ({ runId }) => {
            entered.push(runId);
          },
        } as BackgroundJobHandlers);
        await vi.advanceTimersByTimeAsync(1);
        expect(interactivePage).toBe(2);
        backgroundReady = true;
        await f.realtime.publish("runs:ready", "");
        release();
        await vi.advanceTimersByTimeAsync(1);
        expect(entered).toEqual(["chat-0", "chat-1", "chat-2", trigger]);
        const thirdChatQuery = f.findMany.mock.calls.filter(
          ([query]) => !query.where.trigger.in,
        )[2]![0];
        expect(thirdChatQuery).toMatchObject({
          where: {
            AND: [
              {
                OR: [
                  { createdAt: { gt: new Date(1_000) } },
                  { createdAt: new Date(1_000), id: { gt: "chat-1" } },
                ],
              },
            ],
          },
        });
      } finally {
        release();
        await host.stop();
      }
    },
  );

  it("reports unstarted runs as an error with process health, and their recovery", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    f.queueHealth.mockResolvedValue([
      { delayedRuns: 2, oldestDueAt: new Date(Date.now() - 60_000), oldestRunId: "stuck" },
    ]);
    try {
      await f.host.start({} as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(1);
      const delayed = sink.events.filter((event) => event.message === "run.queue_delayed");
      expect(delayed).toHaveLength(1);
      expect(delayed[0]).toMatchObject({
        level: "error",
        "queue.delayed_runs": 2,
        "queue.oldest_run_id": "stuck",
        "worker.active_runs": 0,
      });
      expect(delayed[0]!["event_loop.delay_max_ms"]).toEqual(expect.any(Number));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(f.queueHealth).toHaveBeenCalledTimes(1);
      f.queueHealth.mockResolvedValue([{ delayedRuns: 0, oldestDueAt: null, oldestRunId: null }]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sink.events.filter((event) => event.message === "run.queue_recovered")).toHaveLength(
        1,
      );
    } finally {
      await f.host.stop();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("leaves busy runs untouched, dispatches unrelated chats, and recovers when the lease releases", async () => {
    const f = fixture();
    f.rows.set("busy", { status: "queued", wakeAt: null });
    f.rows.set("free", { status: "queued", wakeAt: null });
    f.leases.mockResolvedValue([
      {
        computerId: "computer",
        botId: "busy",
        runId: "holder",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(f.rows.get("free")!.status).toBe("completed"));
      await vi.waitFor(() => expect(f.leases.mock.calls.length).toBeGreaterThan(2));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(f.rows.get("busy")).toEqual({ status: "queued", wakeAt: null });
      expect(f.updateMany).not.toHaveBeenCalled();
      f.leases.mockResolvedValue([]);
      await vi.waitFor(() => expect(f.rows.get("busy")!.status).toBe("completed"));
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await f.host.stop();
    }
  });

  it("allows a run's own held lease and ignores leases on its previous computer", async () => {
    const f = fixture();
    f.rows.set("resume", { status: "queued", wakeAt: null });
    f.rows.set("reassigned", { status: "queued", wakeAt: null });
    f.leases.mockResolvedValue([
      {
        computerId: "computer",
        botId: "resume",
        runId: "resume",
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        computerId: "old-computer",
        botId: "reassigned",
        runId: "holder",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    } finally {
      await f.host.stop();
    }
  });

  it("starts chat without invoking Graphile, deduplicates wakeups, and drains long executions", async () => {
    const f = fixture();
    f.rows.set("chat", { status: "queued", wakeAt: null });
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async ({ runId }, execution) => {
      expect(currentDbContext()?.kind).toBe("system");
      f.rows.get(runId)!.status = "running";
      execution.onRunStarted();
      await done;
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("chat"));
      await f.publisher.enqueue(runContinueJob("chat"));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(f.background.enqueue).not.toHaveBeenCalled();
      let stopped = false;
      const stopping = f.host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
    } finally {
      release();
      await f.host.stop();
    }
  });

  it("repairs a missed notification and preserves a future retry through reconciliation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rows.set("delayed", { status: "queued", wakeAt: null });
    vi.spyOn(f.realtime, "publish").mockRejectedValue(
      new Error("fixture notification unavailable"),
    );
    const due = new Date(Date.now() + 1_000);
    await f.publisher.enqueue({ ...runContinueJob("delayed"), availableAt: due });
    await f.publisher.enqueue({ ...runContinueJob("delayed"), keepExisting: true });
    expect(f.rows.get("delayed")!.wakeAt).toEqual(due);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(900);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await f.host.stop();
    }
  });

  it("leaves schedules and maintenance with the background scheduler", async () => {
    const f = fixture();
    const job = { name: "routine.retry", payload: { runId: "routine" } } as const;
    await f.publisher.enqueue(job);
    expect(f.background.enqueue).toHaveBeenCalledExactlyOnceWith(job);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("does not serialize unrelated claims behind one slow startup", async () => {
    const f = fixture();
    f.rows.set("slow", { status: "queued", wakeAt: null });
    f.rows.set("fast", { status: "queued", wakeAt: null });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    const handler = async ({ runId }: { runId: string }) => {
      if (runId === "slow") await pending;
      entered.push(runId);
      f.rows.get(runId)!.status = "completed";
    };
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(entered).toEqual(["fast"]));
      release();
      await vi.waitFor(() => expect(entered).toEqual(["fast", "slow"]));
    } finally {
      release();
      await f.host.stop();
    }
  });

  it("can restart after notification subscription fails", async () => {
    const f = fixture();
    vi.spyOn(f.realtime, "subscribe").mockRejectedValueOnce(new Error("fixture subscribe failure"));
    const target = { "run.continue": vi.fn() } as unknown as BackgroundJobHandlers;
    await expect(f.host.start(target)).rejects.toThrow("fixture subscribe failure");
    try {
      await f.host.start(target);
      await vi.waitFor(() => expect(f.findMany).toHaveBeenCalled());
    } finally {
      await f.host.stop();
    }
  });

  it("keeps direct dispatch running while background startup waits for database capacity", async () => {
    const runs = { start: vi.fn(), stop: vi.fn() } as unknown as RunWorkerHost;
    const background = {
      start: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("fixture scheduler unavailable"), { code: "53300" }),
        ),
      stop: vi.fn(),
    };
    await expect(
      withRunWorker(runs, background).start({} as BackgroundJobHandlers),
    ).rejects.toThrow("fixture scheduler unavailable");
    expect(runs.start).toHaveBeenCalledOnce();
    expect(runs.stop).not.toHaveBeenCalled();
  });
  it("drains direct runs before propagating a fatal scheduler startup failure", async () => {
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = { start: vi.fn(), stop: vi.fn(() => drain) } as unknown as RunWorkerHost;
    const background = {
      start: vi.fn().mockRejectedValue(new Error("fatal fixture startup")),
      stop: vi.fn(),
    };
    let rejected = false;
    const starting = withRunWorker(runs, background)
      .start({} as BackgroundJobHandlers)
      .catch(() => {
        rejected = true;
      });
    await vi.waitFor(() => expect(runs.stop).toHaveBeenCalledOnce());
    expect(rejected).toBe(false);
    release();
    await starting;
    expect(rejected).toBe(true);
  });

  it("waits for an in-flight scheduler start before finishing shutdown", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = { start: vi.fn(), stop: vi.fn() } as unknown as RunWorkerHost;
    const background = { start: vi.fn(() => pending), stop: vi.fn() };
    const host = withRunWorker(runs, background);
    const starting = host.start({} as BackgroundJobHandlers);
    await vi.waitFor(() => expect(background.start).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(runs.stop).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    release();
    await starting;
    await stopping;
    expect(stopped).toBe(true);
    expect(background.stop).toHaveBeenCalledTimes(2);
  });

  it("starts a run in the process that makes it due, with no scan or notification", async () => {
    const f = fixture();
    f.rows.set("chat", { status: "queued", wakeAt: null });
    const publish = vi.spyOn(f.realtime, "publish");
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      f.starter.attach({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("chat"));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect(f.findMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(f.background.enqueue).not.toHaveBeenCalled();
    } finally {
      await f.starter.stop();
    }
  });

  it("never holds one run's start behind another run, however slow", async () => {
    const f = fixture();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    try {
      f.starter.attach({
        "run.continue": async ({ runId }: { runId: string }) => {
          entered.push(runId);
          if (runId === "stuck") await stuck;
        },
      } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("stuck"));
      for (let index = 0; index < 20; index += 1) {
        await f.publisher.enqueue(runContinueJob(`chat-${index}`));
      }
      await vi.waitFor(() => expect(entered).toHaveLength(21));
    } finally {
      release();
      await f.starter.stop();
    }
  });

  it("starts a delayed run on time without a scan", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rows.set("retry", { status: "queued", wakeAt: null });
    const handler = vi.fn();
    try {
      f.starter.attach({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue({
        ...runContinueJob("retry"),
        availableAt: new Date(Date.now() + 1_000),
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(f.findMany).not.toHaveBeenCalled();
    } finally {
      await f.starter.stop();
    }
  });

  it("hands a run to a running worker when its own process is stopping", async () => {
    const f = fixture();
    f.rows.set("handed", { status: "queued", wakeAt: null });
    const stopping = new AbortController();
    stopping.abort();
    const leaving = new RunStarter(f.realtime, { signal: stopping.signal });
    const leavingHandler = vi.fn();
    leaving.attach({ "run.continue": leavingHandler } as unknown as BackgroundJobHandlers);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await new RunJobPublisher(f.prisma, f.background, leaving).enqueue(runContinueJob("handed"));
      await vi.waitFor(() =>
        expect(handler).toHaveBeenCalledWith({ runId: "handed" }, expect.anything()),
      );
      expect(leavingHandler).not.toHaveBeenCalled();
    } finally {
      await leaving.stop();
      await f.host.stop();
    }
  });

  it("does not hand a taken run back and forth when this process cannot run it", async () => {
    const f = fixture();
    const publish = vi.spyOn(f.realtime, "publish");
    const admission = vi.spyOn(RunExecutionHost.prototype, "execute").mockResolvedValue(false);
    try {
      await f.host.start({ "run.continue": vi.fn() } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("full"));
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      admission.mockRestore();
      await f.host.stop();
    }
  });

  it("starts a run again when it is made due while this process is still finishing it", async () => {
    const f = fixture();
    let release!: () => void;
    const finishing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) await finishing;
    });
    try {
      f.starter.attach({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("answered"));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      await f.publisher.enqueue(runContinueJob("answered"));
      await f.publisher.enqueue(runContinueJob("answered"));
      release();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await f.starter.stop();
    }
  });
});
