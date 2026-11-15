import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

async function context(
  options: {
    trigger?: string;
    attempts?: number;
    outsideMessage?: boolean;
    steeredIds?: string[];
  } = {},
) {
  const createMany = vi.fn(async () => ({ count: 1 }));
  const append = vi.fn();
  const finalizeRun = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => undefined);
  const updateMany = vi.fn(async (_args: { data?: object }) => ({ count: 1 }));
  const tx = { usageRecord: { createMany } };
  const deps = {
    prisma: {
      attempt: { count: async () => options.attempts ?? 1 },
      message: { findMany: async () => [] },
      run: { updateMany },
      steeringMessage: {
        findMany: async () => (options.steeredIds ?? []).map((messageId) => ({ messageId })),
      },
      thread: {
        findUniqueOrThrow: async () => ({ nextMessageSeq: 0, historyCompactedUpToSeq: null }),
      },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
    events: { append, finalizeRun },
    jobs: { enqueue },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: options.trigger ?? "routine",
    sourceMessageId: "message-1",
    clientNonce: "strategic-initiative:bot-1:1",
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId, botId: run.botId, groupId: null },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    trust: { receivedOutsideMessage: async () => options.outsideMessage ?? false },
    memory: { semantic: { retainConversation: async () => undefined }, scope: "isolated" },
    secrets: [],
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, createMany, append, finalizeRun, enqueue, updateMany };
}

async function* events(...items: AgentRuntimeEvent[]) {
  yield* items;
}

describe("daily check-in routine execution", () => {
  it("records ordinary routine usage even when the reply is silent", async () => {
    const { ctx, createMany, finalizeRun, append } = await context();
    await consumeRunEvents(
      ctx,
      events(
        {
          type: "usage",
          provider: "fixture",
          model: "test",
          inputTokens: 10,
          outputTokens: 2,
          costUsd: 0.01,
        },
        { type: "done", text: "NO_RESPONSE" },
      ),
    );
    await completeRun(ctx);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            runId: "run-1",
            userId: "user-1",
            spaceId: "space-1",
            costUsd: 0.01,
            operationKind: "answer",
          }),
        ],
      }),
    );
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("does not apply scripted files or memory on completion", async () => {
    const { ctx } = await context();
    ctx.script = [
      {
        files: [{ path: "injected.txt", content: "untrusted" }],
        memory: [{ scope: "bot", path: "injected.md", content: "untrusted" }],
      },
    ];
    await completeRun(ctx);
    // The context deliberately has no sandbox or memory writer: reaching either fails.
    expect(ctx.state.terminalCheckpointComplete).toBe(true);
  });

  it("refuses a runtime takeover before starting the computer", async () => {
    const { ctx } = await context();
    await expect(
      consumeRunEvents(ctx, events({ type: "takeover", reason: "injected" })),
    ).rejects.toThrow("Daily check-ins cannot start a computer or helper.");
  });
});

describe("learning a finished turn", () => {
  it("learns a plain turn with its replies", async () => {
    const { ctx, enqueue } = await context({ trigger: "user" });
    await completeRun(ctx);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory.retain-turn", payload: { runId: "run-1" } }),
    );
  });

  it("includes what the person sent while the run worked", async () => {
    const { ctx, enqueue } = await context({ trigger: "user", steeredIds: ["steer-1"] });
    await completeRun(ctx);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "run-1", messageIds: ["steer-1"] } }),
    );
  });

  it("keeps learning from a turn after outside input", async () => {
    const { ctx, enqueue } = await context({ trigger: "user" });
    ctx.state.tainted = true;
    await completeRun(ctx);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: { runId: "run-1" } }));
  });
});
