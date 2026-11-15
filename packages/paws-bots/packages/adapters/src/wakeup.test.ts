import { readFileSync } from "node:fs";
import path from "node:path";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { messagingSendJob, messagingSendJobKey } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABANDONED_SUSPEND_CLAIM_MS } from "./computer-idle.js";
import {
  createDeadJobPruner,
  DEAD_JOB_RETENTION_DAYS,
  InMemoryJobQueue,
  JOB_DRAIN_TIMEOUT_MS,
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

const LAST_ATTEMPT = { number: 1, max: 1 };

describe("InMemoryJobQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("reports failed descendants after draining without exposing payloads or errors", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    target["run.continue"] = async () => {
      await queue.enqueue({ name: "history.compact", payload: { threadId: "fixture-thread" } });
      await queue.enqueue({ name: "history.compact", payload: { threadId: "fixture-thread" } });
    };
    target["history.compact"] = async () => {
      throw new Error("fixture-private-error");
    };
    await queue.start(target);
    await queue.enqueue({ name: "run.continue", payload: { runId: "fixture-run" } });
    await queue.awaitIdle();
    const counts = queue.failureCounts();
    expect(counts).toEqual([{ name: "history.compact", count: 2 }]);
    expect(JSON.stringify(counts)).not.toContain("fixture-private");
    counts[0]!.count = 99;
    expect(queue.failureCounts()[0]!.count).toBe(2);
    await queue.close();
  });

  it("waits for due descendants without closing the queue or running future work", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    target["run.continue"] = vi.fn(async () => {
      await queue.enqueue({ name: "history.compact", payload: { threadId: "thread-1" } });
    });
    await queue.start(target);
    await queue.enqueue({ name: "run.continue", payload: { runId: "run-1" } });
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "future" },
      availableAt: new Date(Date.now() + 1_000),
    });
    await queue.awaitIdle();
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["history.compact"]).toHaveBeenCalledTimes(1);
    expect(target["computer.sleep"]).not.toHaveBeenCalled();
    await queue.enqueue({ name: "run.continue", payload: { runId: "run-2" } });
    await queue.awaitIdle();
    expect(target["run.continue"]).toHaveBeenCalledTimes(2);
    await queue.close();
  });

  it("delivers delayed jobs", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "run-1" },
      availableAt: new Date(Date.now() + 1_000),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(target["run.continue"]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "run-1" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it("replaces and cancels keyed jobs", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "old" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "new" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    expect(target["computer.sleep"]).toHaveBeenCalledWith(
      { computerId: "new" },
      undefined,
      LAST_ATTEMPT,
    );

    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "cancelled" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:2",
    });
    await queue.cancel("computer.sleep:2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it("keeps a transaction's jobs through a cancel its transaction may roll back", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    const tx = { $executeRawUnsafe: vi.fn(async () => 0) };
    await queue.start(target);
    const dueAt = new Date(Date.now() + 1_000);
    await queue.enqueueIn(tx, messagingSendJob("kept", dueAt));
    await queue.cancelIn(tx, messagingSendJobKey("kept"));

    await vi.advanceTimersByTimeAsync(999);
    expect(target["messaging.send"]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Its handler finds the message settled, or sends it if that transaction rolled back.
    expect(target["messaging.send"]).toHaveBeenCalledExactlyOnceWith(
      { outboundId: "kept" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it("leaves a keyed job in place when asked to keep the existing one", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "backed-off" },
      availableAt: new Date(Date.now() + 5_000),
      replaceKey: "run:run-1",
    });
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "pulled-forward" },
      replaceKey: "run:run-1",
      keepExisting: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["run.continue"]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "backed-off" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it("keeps attempts and run_at when the keyed job is still in backoff", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    const runAt = new Date(Date.now() + 5_000);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "backed-off" },
      availableAt: runAt,
      replaceKey: "run:run-1",
      maxAttempts: 3,
    });
    queue.recordFailedAttempt("run:run-1");
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "pulled-forward" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "run:run-1",
      keepExisting: true,
    });
    expect(queue.keyedJob("run:run-1")).toEqual({
      attempts: 1,
      maxAttempts: 3,
      availableAt: runAt,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["run.continue"]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "backed-off" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it("re-enqueues an exhausted keyed job with fresh attempts", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "exhausted" },
      availableAt: new Date(Date.now() + 60_000),
      replaceKey: "run:run-1",
      maxAttempts: 1,
    });
    queue.recordFailedAttempt("run:run-1");
    const revivedAt = new Date(Date.now() + 1_000);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "revived" },
      availableAt: revivedAt,
      replaceKey: "run:run-1",
      keepExisting: true,
    });
    expect(queue.keyedJob("run:run-1")).toEqual({
      attempts: 0,
      maxAttempts: 25,
      availableAt: revivedAt,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "revived" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it("enqueues a keepExisting job when none is queued for that key", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    const runAt = new Date(Date.now() + 1_000);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "fresh" },
      availableAt: runAt,
      replaceKey: "run:missing",
      keepExisting: true,
    });
    expect(queue.keyedJob("run:missing")).toEqual({
      attempts: 0,
      maxAttempts: 25,
      availableAt: runAt,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "fresh" },
      undefined,
      LAST_ATTEMPT,
    );
    await queue.close();
  });

  it.each([
    ["stop", "stop"],
    ["close", "close"],
    ["stop", "close"],
    ["close", "stop"],
  ] as const)("waits for an active handler before %s/%s", async (first, second) => {
    const queue = new InMemoryJobQueue();
    let releaseHandler: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    let nestedEnqueueFailed = false;
    let delayedEnqueueFailed = false;
    let chainedEnqueueFailed = false;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const target = handlers();
    target["computer.sleep"] = vi.fn(async () => {
      try {
        await queue.enqueue({ name: "run.continue", payload: { runId: "chained-run" } });
      } catch {
        chainedEnqueueFailed = true;
      }
    });
    target["run.continue"] = vi.fn(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      try {
        await queue.enqueue({
          name: "computer.sleep",
          payload: { computerId: "computer-1" },
          replaceKey: "keep-during-close",
        });
        await queue.enqueue({
          name: "computer.sleep",
          payload: { computerId: "cancelled-computer" },
          replaceKey: "cancel-during-close",
        });
        await queue.cancel("cancel-during-close");
      } catch {
        nestedEnqueueFailed = true;
      }
      try {
        await queue.enqueue({
          name: "routine.wakeup",
          payload: { routineId: "routine-1", scheduledFor: "2099-01-01T00:00:00.000Z" },
          availableAt: new Date("2099-01-01T00:00:00.000Z"),
        });
      } catch {
        delayedEnqueueFailed = true;
      }
    });
    await queue.start(target);
    await queue.enqueue({ name: "run.continue", payload: { runId: "run-1" } });
    await started;

    const closing = Promise.all([queue[first](), queue[second]()] as const);
    const closeState = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 5)),
    ]);
    releaseHandler();
    await closing;
    expect(closeState).toBe("waiting");
    expect(nestedEnqueueFailed).toBe(false);
    expect(delayedEnqueueFailed).toBe(false);
    expect(chainedEnqueueFailed).toBe(true);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["routine.wakeup"]).not.toHaveBeenCalled();
    await queue.close();
  });

  it("rejects a keyed enqueue that resumes after close", async () => {
    const queue = new InMemoryJobQueue();
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.close();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is closed");
  });

  it("rejects a keyed enqueue that resumes after stop", async () => {
    const queue = new InMemoryJobQueue();
    await queue.start(handlers());
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.stop();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is stopped");
  });

  it("drains an accepted immediate timer during close", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);

    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();

    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });

  it("rejects jobs after stop until the worker restarts", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.stop();

    await expect(
      queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } }),
    ).rejects.toThrow("Background job publisher is stopped");

    await queue.start(target);
    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();
    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });

  it("unwraps correlation envelopes and restores request traces", async () => {
    const { createLogger, createTestSink, installLogger, runWithLogContext } = await import(
      "@rakazo/logging"
    );
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await runWithLogContext(
      { "trace.id": "a".repeat(32), "span.id": "b".repeat(16), "request.id": "req-1" },
      async () => {
        await queue.enqueue({ name: "run.continue", payload: { runId: "run-traced" } });
      },
    );
    await queue.close();
    expect(target["run.continue"]).toHaveBeenCalledWith(
      { runId: "run-traced" },
      undefined,
      LAST_ATTEMPT,
    );
    expect(sink.events.some((event) => event.message === "job.completed")).toBe(true);
    expect(
      sink.events.some(
        (event) => event["trace.id"] === "a".repeat(32) && event["run.id"] === "run-traced",
      ),
    ).toBe(true);
  });

  it("keeps wrapped payloads readable by workers that do not unwrap envelopes", async () => {
    const { wrapJobPayload } = await import("@rakazo/logging");
    const { parseBackgroundJob } = await import("@rakazo/adapter-kit");
    const wrapped = wrapJobPayload(
      { runId: "run-rollback" },
      { jobId: "job-1", traceId: "a".repeat(32) },
    );
    expect(parseBackgroundJob("run.continue", wrapped)).toEqual({
      name: "run.continue",
      payload: { runId: "run-rollback" },
    });
  });
});

describe("createDeadJobPruner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("deletes old exhausted jobs in batches about once an hour and logs the count", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    let now = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1_000 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValue({ rowCount: 0 });
    const prune = createDeadJobPruner({ query } as never);

    await prune();
    await prune();

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual([DEAD_JOB_RETENTION_DAYS, 1_000]);
    // Only exhausted, unlocked rows, rechecked by the delete itself, and never retry notices.
    expect(sql).toContain("dead.attempts >= dead.max_attempts and dead.locked_at is null");
    expect(sql).toContain("jobs.attempts >= jobs.max_attempts and jobs.locked_at is null");
    expect(sql).toContain("tasks.identifier <> 'routine.retry'");
    expect(sink.events).toContainEqual(
      expect.objectContaining({ message: "jobs.dead_pruned", "jobs.removed": 1_003 }),
    );

    now += 60 * 60 * 1000;
    await prune();
    expect(query).toHaveBeenCalledTimes(3);
    expect(sink.events.filter((event) => event.message === "jobs.dead_pruned")).toHaveLength(1);
  });
});

describe("JOB_DRAIN_TIMEOUT_MS", () => {
  it("ends before the idle sweep would replace a sleep job that is still draining", () => {
    expect(JOB_DRAIN_TIMEOUT_MS).toBeLessThan(ABANDONED_SUSPEND_CLAIM_MS);
  });

  // Docker kills the worker once its stop_grace_period runs out, which would leave its jobs locked.
  it.each(["docker-compose.yml", "docker-compose.images.yml", "docker-compose.prod.yml"])(
    "ends before %s kills a stopping worker",
    (file) => {
      const compose = readFileSync(
        path.resolve(import.meta.dirname, "../../../infra/compose", file),
        "utf8",
      );
      const worker = compose.slice(compose.indexOf("\n  worker:\n") + 1);
      const block = worker.slice(0, worker.search(/\n {2}[a-z]/));
      const minutes = Number(/\n {4}stop_grace_period: (\d+)m\n/.exec(block)?.[1]);
      expect(minutes * 60_000).toBeGreaterThanOrEqual(JOB_DRAIN_TIMEOUT_MS + 5 * 60_000);
    },
  );
});
