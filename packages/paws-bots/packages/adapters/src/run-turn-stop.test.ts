import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { consumeRunEvents } from "./run-turn.js";

const requeued = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./run-lifecycle.js", async (actual) => ({
  ...(await actual<typeof import("./run-lifecycle.js")>()),
  requeueComputerRun: requeued,
}));

// Stop marks the run cancelled in the database, possibly from another server.
async function context(row: { status: string }) {
  const findUnique = vi.fn(async () => ({
    ...row,
    leaseOwner: "worker-1",
    leaseFence: 1,
    checkpoint: null as string | null,
  }));
  const deps = {
    prisma: {
      message: { findMany: async () => [] },
      run: { updateMany: async () => ({ count: 1 }), findUnique },
      thread: {
        findUniqueOrThrow: async () => ({
          nextMessageSeq: 0,
          historyCompactedUpToSeq: null,
        }),
      },
    },
    events: { append: vi.fn(), finalizeRun: vi.fn() },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: "message",
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: 0 },
      computerUse: {},
      toolCallStreak: {},
      toolResults: new Map(),
      overLimitActionCalls: 0,
    },
    abortController: new AbortController(),
    computer: {
      lazy: { throwIfFailed: () => {} },
      checkpoint: { flush: vi.fn() },
    },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    secrets: [],
    scripted: true,
  } as unknown as RunContext;
  return { ctx, findUnique };
}

/** A call that streams nothing until it finishes, or until the run's signal aborts it. */
function quietCall(ctx: RunContext, ms: number) {
  return new Promise<"finished" | "aborted">((resolve) => {
    const timer = setTimeout(() => resolve("finished"), ms);
    ctx.abortController.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve("aborted");
    });
  });
}

describe("consumeRunEvents and Stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a quiet model call within two seconds of Stop", async () => {
    const row = { status: "running" };
    const { ctx } = await context(row);
    let outcome: string | undefined;
    let stoppedAt = 0;
    let endedAfterMs = 0;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      row.status = "cancelled";
      stoppedAt = Date.now();
      outcome = await quietCall(ctx, 60_000);
      endedAfterMs = Date.now() - stoppedAt;
      yield { type: "text", text: "late reply" };
      yield { type: "done", text: "late reply" };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toBe("aborted");
    expect(endedAfterMs).toBeLessThanOrEqual(2_000);
    await expect(consumed).resolves.toBe(true);
    expect(ctx.state.reply.assembled).toBe("");
  });

  it("aborts a long tool and takes no tool call after Stop", async () => {
    const row = { status: "running" };
    const { ctx } = await context(row);
    const appended = ctx.deps.events.append as ReturnType<typeof vi.fn>;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      // The runtime runs a tool between events; nothing streams while it works.
      yield { type: "text", text: "Checking." };
      row.status = "cancelled";
      await quietCall(ctx, 60_000);
      yield {
        type: "tool",
        name: "next_tool",
        args: {},
        executionId: "call-2",
      };
      yield { type: "done", text: "" };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.abortController.signal.aborted).toBe(true);
    await expect(consumed).resolves.toBe(true);
    expect(JSON.stringify(appended.mock.calls)).not.toContain("next_tool");
  });

  it("leaves a quiet call alone while the run is still running, and stops checking after", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    let outcome: string | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      outcome = await quietCall(ctx, 5_000);
      yield { type: "text", text: "Done." };
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(consumed).resolves.toBe(false);
    expect(outcome).toBe("finished");
    expect(ctx.abortController.signal.aborted).toBe(false);
    // At most one read a second, shared with the per-event check.
    const reads = findUnique.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findUnique.mock.calls.length).toBe(reads);
  });

  it("stops checking when the runtime fails", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      throw new Error("model failed");
    }
    const consumed = consumeRunEvents(ctx, runtime());
    const settled = expect(consumed).rejects.toThrow("model failed");
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    const reads = findUnique.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findUnique.mock.calls.length).toBe(reads);
  });
  it("ignores a lease read that resolves after the run ended", async () => {
    const row = { status: "running" };
    const { ctx, findUnique } = await context(row);
    let finishRead: (() => void) | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      // The timer's read is now in flight; it answers only after the run has finished.
      findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = () =>
              resolve({
                status: "cancelled",
                leaseOwner: "worker-1",
                leaseFence: 1,
                checkpoint: null,
              });
          }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finishRead).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(consumed).resolves.toBe(false);
    // The final screen release runs on this signal after the turn; a late read must not cancel it.
    finishRead?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
  it("ignores a late lease read that finds a released takeover hold", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    (ctx.computer as { heldForTakeover?: boolean }).heldForTakeover = true;
    requeued.mockClear();
    let finishRead: (() => void) | undefined;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = () =>
              resolve({
                status: "running",
                leaseOwner: "worker-1",
                leaseFence: 1,
                checkpoint: "takeover",
              });
          }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finishRead).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(consumed).resolves.toBe(false);
    finishRead?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(requeued).not.toHaveBeenCalled();
    expect(ctx.state.lease.valid).toBe(true);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
  it("does not abort when a takeover requeue finishes after the turn ended", async () => {
    const { ctx, findUnique } = await context({ status: "running" });
    (ctx.computer as { heldForTakeover?: boolean }).heldForTakeover = true;
    let finishRequeue: (() => void) | undefined;
    requeued.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequeue = resolve;
        }),
    );
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "thinking", active: true };
      await quietCall(ctx, 1_500);
      // The read answers while the turn is live; the requeue it starts outlives the turn.
      findUnique.mockResolvedValueOnce({
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: 1,
        checkpoint: "takeover",
      });
      await quietCall(ctx, 1_000);
      expect(finishRequeue).toBeDefined();
      yield { type: "done", text: "Done." };
    }
    const consumed = consumeRunEvents(ctx, runtime());
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(consumed).resolves.toBe(false);
    finishRequeue?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
});
