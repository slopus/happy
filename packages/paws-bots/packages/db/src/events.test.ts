import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  BOT_SECRET_VALUE_MAX_LENGTH,
  encodeLoginSecret,
  STEP_SCREENSHOT_MIME_TYPES,
} from "@rakazo/contracts";
import {
  TAKEOVER_COMPUTER_DONE_STATE,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { CrossSpaceCommunicationBlockedError } from "./cross-space-communication.js";
import { followThreadEvents } from "./event-stream.js";
import {
  appendEvent,
  clearThread,
  completedRunBlocks,
  finalizeRun,
  sendUserMessage,
} from "./events.js";
import { endTakeoverWaits } from "./expire-stuck-run.js";
import { partialReplyClientNonce, RunHistoryWriteError } from "./messages.js";
import { installSecurityEventStore } from "./security-events.js";
import type { AnswerRunInput } from "./thread-ask.js";
import {
  AnswerTooLongError,
  answerRunInput,
  answerWaitingRunWithTextInTransaction,
  pauseRunForInput,
} from "./thread-ask.js";
import {
  claimSteering,
  createPendingSteeringRun,
  discardAnsweredSteering,
} from "./thread-steering.js";
import {
  answerTakeoverRequest,
  pauseRunForTakeover,
  releaseUserControl,
  settleReleasedTakeoverCards,
} from "./thread-takeover.js";

class TestFanout implements RealtimeFanout {
  subscriber: ((payload: string) => void) | undefined;
  unsubscribed = false;

  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, payload: string) {
    this.subscriber?.(payload);
  }

  async subscribe(_topic: string, subscriber: (payload: string) => void) {
    this.subscriber = subscriber;
    return async () => {
      this.unsubscribed = true;
      this.subscriber = undefined;
    };
  }

  async close() {}
}

function event(seq: number) {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "run.started",
    payload: {},
    runId: null,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

describe("finalizeRun", () => {
  it("stamps the final steps block with wall-clock run duration", () => {
    const blocks = [
      { kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] },
      { kind: "text" as const, text: "Then I checked it." },
      { kind: "steps" as const, steps: [{ label: "Run tests", count: 1 }] },
    ];

    expect(
      completedRunBlocks(
        blocks,
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T12:01:43.000Z"),
      ),
    ).toEqual([blocks[0], blocks[1], { ...blocks[2], durationMs: 103_000 }]);
    expect(completedRunBlocks(blocks, null, new Date())).toBe(blocks);
  });

  it.each(["completed", "failed"] as const)(
    "retries a transaction conflict and clears the checkpoint on %s without duplicating the terminal event or notification",
    async (outcome) => {
      const conflict = Object.assign(new Error("serialization conflict"), { code: "P2034" });
      const createEvent = vi.fn(async () => ({ threadId: "thread-1", seq: 0 }));
      const tx = {
        externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        $queryRaw: vi.fn(async () => []),
        run: {
          findUnique: vi.fn(async () => ({ status: "running", userId: "user-1" })),
          findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
          findFirst: vi.fn(async () => null),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
        task: { updateMany: vi.fn(async () => ({ count: 1 })) },
        thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
        event: { create: createEvent, deleteMany: vi.fn(async () => ({ count: 0 })) },
        secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        steeringMessage: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          findMany: vi.fn(async () => []),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
        message: { findFirst: vi.fn(async () => null) },
        bot: { update: vi.fn(async () => ({})) },
      };
      const transaction = vi
        .fn()
        .mockRejectedValueOnce(conflict)
        .mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx));
      const publish = vi.fn(async () => undefined);

      await expect(
        finalizeRun(
          { $transaction: transaction } as unknown as PrismaClient,
          {
            spaceId: "space-1",
            threadId: "thread-1",
            botId: "bot-1",
            runId: "run-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            leaseOwner: "worker-1",
            leaseFence: 1,
            ...(outcome === "failed" ? { outcome, error: "failed" } : { outcome, blocks: [] }),
          },
          { publish } as never,
        ),
      ).resolves.toEqual({ continuationRunId: null });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(tx.externalEffect.deleteMany).toHaveBeenCalledWith({
        where: { runId: "run-1", kind: "runtime_checkpoint", status: "runtime_checkpoint" },
      });
      expect(createEvent).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
      // A finished run never resumes to read a waiting secret answer.
      expect(tx.secret.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { userId: "user-1", spaceId: "space-1", kind: "run-secret:run-1" },
            { userId: "user-1", spaceId: "space-1", kind: "run-code:run-1" },
            { userId: "user-1", spaceId: "space-1", kind: "run-code-spent:run-1" },
            { userId: "user-1", spaceId: "space-1", kind: { startsWith: "run-login:run-1:" } },
          ],
        },
      });
    },
  );

  it("saves the reply a failure cut short before the error, as no answer to steering", async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "failed", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1, nextMessageSeq: 5 })) },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      event: {
        create: vi.fn(async ({ data }: { data: { type: string } }) => ({
          ...data,
          threadId: "thread-1",
          seq: 0,
          createdAt: new Date(),
        })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      message: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: "message-partial",
        })),
      },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const partialReply = [{ kind: "text" as const, text: "Part one. Part tw" }];

    await finalizeRun(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "terminated",
      partialReply,
    });

    expect(tx.message.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        role: "bot",
        blocks: partialReply,
        runId: "run-1",
        clientNonce: partialReplyClientNonce("run-1"),
      }),
    });
    expect(tx.event.create.mock.calls.map(([{ data }]) => data.type)).toEqual([
      "thread.message.created",
      "run.failed",
    ]);
    // Steering is settled before the kept reply exists, so the reply cannot count as its answer.
    expect(tx.message.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.create.mock.invocationCallOrder[0]!,
    );
  });

  it("saves no message for a failure without a partial reply", async () => {
    const create = vi.fn();
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "failed", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      message: { findFirst: vi.fn(async () => null), create },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await finalizeRun(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "terminated",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("resumes a held messaging inbound as a messaging run", async () => {
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-1",
            userId: "user-1",
            originTrigger: "messaging",
            message: {
              id: "message-slack",
              seq: 4,
              blocks: [{ kind: "text", text: "Check the inbox" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeRun(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "intro-run",
        taskId: "intro-task",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "failed",
        error: "intro failed",
      }),
    ).resolves.toEqual({ continuationRunId: "run-reply" });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "messaging",
        sourceMessageId: "message-slack",
        status: "queued",
      }),
    });
  });

  it("pins the continuation when every waited message chose the same model", async () => {
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-1",
            userId: "user-1",
            originTrigger: null,
            modelProvider: "openai-compatible",
            modelId: "private-model",
            thinkingLevel: "low",
            message: {
              id: "message-hook",
              seq: 4,
              blocks: [{ kind: "text", text: "Run the routine" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await finalizeRun(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "routine-run",
      taskId: "routine-task",
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "stopped",
    });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "follow_up",
        sourceMessageId: "message-hook",
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
        modelPinned: true,
      }),
    });
  });

  it("resumes held app and direct-line messages first, without taking an earlier group-channel message", async () => {
    const channel = {
      kind: "channel_message" as const,
      provider: "slack",
      channelId: "channel-1",
      fromAddress: "U1",
      fromLabel: "Pat",
      text: "What is the status?",
    };
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-channel",
            userId: "user-1",
            originTrigger: "messaging",
            message: { id: "message-channel", seq: 4, blocks: [channel] },
          },
          {
            id: "steer-dm",
            userId: "user-1",
            originTrigger: "messaging",
            message: {
              id: "message-dm",
              seq: 5,
              blocks: [{ kind: "text", text: "And privately?" }],
            },
          },
          {
            id: "steer-app",
            userId: "user-1",
            originTrigger: null,
            message: {
              id: "message-app",
              seq: 6,
              blocks: [{ kind: "text", text: "From the app" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeRun(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "routine-run",
        taskId: "routine-task",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "failed",
        error: "routine failed",
      }),
    ).resolves.toEqual({ continuationRunId: "run-reply" });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "messaging",
        sourceMessageId: "message-app",
        userId: "user-1",
        status: "queued",
      }),
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steer-dm", "steer-app"] }, runId: null },
      data: { runId: "run-reply", claimedAt: null },
    });
  });
});

describe("thread lock transaction budget", () => {
  // These transactions wait on the thread row lock, which snapshot reads can hold
  // for up to 15s, before writing run state. Prisma's 5s default counts that wait,
  // and expiring fails a user stop, clear or card answer, or a run whose work
  // already finished. Only the timeout is shared: an explicit maxWait would
  // override the client's longer connection wait, so a saturated pool that frees
  // a connection late would fail the checkout instead of waiting it out.
  const budget = { timeout: 20_000 };

  it("clears a thread with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      threadRead: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      thread: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi
          .fn()
          .mockResolvedValueOnce({
            nextMessageSeq: 0,
            historyCompactionGeneration: 0,
            userId: "user-1",
          })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      computerExecutionLease: { updateMany: vi.fn() },
      message: {
        deleteMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{ runId: "run-1" }]),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([{ id: "shot-1", storageKey: "key-1" }]),
        deleteMany: vi.fn(),
      },
      event: { deleteMany: vi.fn(), create: vi.fn().mockResolvedValue(event(1)) },
      bot: { update: vi.fn() },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    const result = await clearThread({ $transaction } as unknown as PrismaClient, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
    });

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
    // The cleared replies' kept screenshots go with them; the caller removes their files.
    expect(tx.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "workspace-1",
          mimeType: { in: STEP_SCREENSHOT_MIME_TYPES },
          runId: { in: ["run-1"] },
        }),
      }),
    );
    expect(tx.artifact.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["shot-1"] } } });
    expect(result.removedStorageKeys).toEqual(["key-1"]);
  });

  it("pauses a run for input with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn() },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      pauseRunForInput({ $transaction } as unknown as PrismaClient, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        blocks: [{ kind: "ask", text: "Which city?" }],
      }),
    ).resolves.toBe(false);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("answers a card with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      answerRunInput({ $transaction } as unknown as PrismaClient, {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBe(false);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("claims steering with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      claimSteering({ $transaction } as unknown as PrismaClient, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      }),
    ).resolves.toEqual([]);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("pauses a run for takeover with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      pauseRunForTakeover({ $transaction } as unknown as PrismaClient, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        reason: "user",
      }),
    ).resolves.toBe(false);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("answers a takeover request with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      answerTakeoverRequest({ $transaction } as unknown as PrismaClient, {
        spaceId: "space-1",
        botId: "bot-1",
        runId: "run-1",
        reason: "done",
      }),
    ).resolves.toBe(false);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("settles released takeover cards with the explicit budget", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await settleReleasedTakeoverCards({ $transaction } as unknown as PrismaClient, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      reason: "done",
    });

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it.each([
    [
      "commits a bot update",
      (prisma: PrismaClient) =>
        commitBotUpdate({
          prisma,
          notify: vi.fn(),
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "Ada" },
          emitBotUpdated: true,
        }),
    ],
    ["ends a takeover wait", (prisma: PrismaClient) => endTakeoverWaits(prisma, ["run-1"])],
  ])("%s with the explicit budget", async (_name, act) => {
    const unreachable = new Error("transaction body not under test");
    const $transaction = vi.fn().mockRejectedValue(unreachable);
    const run = {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "run-1", threadId: "thread-1", updatedAt: new Date(0) }]),
    };

    await expect(act({ $transaction, run } as unknown as PrismaClient)).rejects.toBe(unreachable);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("finalizes a run with the explicit budget", async () => {
    const createEvent = vi.fn(async () => ({ threadId: "thread-1", seq: 0 }));
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", userId: "user-1" })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: createEvent, deleteMany: vi.fn(async () => ({ count: 0 })) },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const $transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));

    await expect(
      finalizeRun({ $transaction } as unknown as PrismaClient, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "completed",
        blocks: [],
      }),
    ).resolves.toEqual({ continuationRunId: null });

    // finalizeRun keeps its own longer-standing options, including the connection wait.
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 20_000,
    });
  });
});

describe("followThreadEvents", () => {
  it("does not lose a notification that arrives while querying", async () => {
    const fanout = new TestFanout();
    const findMany = vi
      .fn()
      .mockImplementationOnce(async () => {
        await fanout.publish("thread:thread-1", "wake");
        return [];
      })
      .mockResolvedValueOnce([event(0)])
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, fanout, abort.signal, 10_000);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledTimes(2);
    abort.abort();
    await stream.return(undefined);
    expect(fanout.unsubscribed).toBe(true);
  });

  it("periodically catches up when a signal is missed", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(0)]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, undefined, abort.signal, 1);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});

function takeoverTx(runUpdates: Array<{ count: number }>) {
  const runUpdate = vi.fn();
  for (const result of runUpdates) runUpdate.mockResolvedValueOnce(result);
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "group-thread" }]),
    run: {
      findFirst: vi.fn().mockResolvedValue({ threadId: "group-thread" }),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      updateMany: runUpdate,
    },
    message: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "message-1",
          blocks: [
            { kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Sign in." },
            { kind: "text", text: "keep" },
          ],
        },
      ]),
      update: vi.fn().mockResolvedValue({ id: "message-1" }),
    },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextEventSeq: 8 })
        .mockResolvedValueOnce({ nextEventSeq: 9 }),
    },
    event: {
      create: vi.fn(
        async ({ data }: { data: { seq: number; type: string; threadId: string } }) => ({
          ...event(data.seq),
          type: data.type,
          threadId: data.threadId,
        }),
      ),
    },
  };
}

describe("answerTakeoverRequest", () => {
  const input = {
    spaceId: "workspace-1",
    botId: "bot-1",
    runId: "run-1",
    reason: "done" as const,
  };

  it("resumes the waiting run, settles its card, and says the request was answered", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = takeoverTx([{ count: 1 }]);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(answerTakeoverRequest(prisma, input, fanout)).resolves.toBe(true);

    expect(tx.run.findFirst).toHaveBeenCalledWith({
      where: { id: "run-1", spaceId: "workspace-1", botId: "bot-1" },
      select: { threadId: true },
    });
    expect(tx.run.updateMany).toHaveBeenCalledOnce();
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "waiting_takeover" },
      data: { status: "queued", checkpoint: "takeover" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          { kind: "computer", state: TAKEOVER_COMPUTER_DONE_STATE, text: "Sign in." },
          { kind: "text", text: "keep" },
        ],
      },
    });
    expect(tx.event.create.mock.calls.map(([call]) => call.data.type)).toEqual([
      "thread.message.updated",
      "computer.takeover.released",
    ]);
    expect(tx.event.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          runId: "run-1",
          payload: { holder: "none", leaseId: null, reason: "done", answered: true },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:group-thread", JSON.stringify({ cursor: 8 }));
  });

  it("answers a request once: a second Done never stamps the resumed run's next request", async () => {
    const tx = takeoverTx([{ count: 0 }, { count: 1 }]);
    // The first answer settled the card; the run is running again.
    tx.message.findMany.mockResolvedValue([
      {
        id: "message-1",
        blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_DONE_STATE, text: "Sign in." }],
      },
    ]);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(answerTakeoverRequest(prisma, input)).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("stamps a skip on a run still preparing its pause without taking its lease", async () => {
    const tx = takeoverTx([{ count: 0 }, { count: 1 }]);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(answerTakeoverRequest(prisma, { ...input, reason: "skipped" })).resolves.toBe(
      true,
    );

    expect(tx.run.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "run-1", status: { in: ["leased", "running"] } },
      data: { checkpoint: "takeover-skipped" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          { kind: "computer", state: TAKEOVER_COMPUTER_SKIPPED_STATE, text: "Sign in." },
          { kind: "text", text: "keep" },
        ],
      },
    });
  });

  it("changes nothing when the run no longer waits", async () => {
    const tx = takeoverTx([{ count: 0 }, { count: 0 }]);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(answerTakeoverRequest(prisma, input)).resolves.toBe(false);

    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("changes nothing for a run of another bot or space", async () => {
    const tx = takeoverTx([]);
    tx.run.findFirst.mockResolvedValue(null);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(answerTakeoverRequest(prisma, input)).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("releaseUserControl", () => {
  function controlTx(cleared: number, recordings: string[] = []) {
    return {
      $queryRaw: vi.fn().mockResolvedValue(recordings.map((id) => ({ id }))),
      $executeRaw: vi.fn().mockResolvedValue(0),
      message: { create: vi.fn(async () => ({ id: "draft-message" })) },
      taughtSkill: {
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          botId: "bot-1",
          goal: "Export the list",
          status: "recording",
          recording: { events: [], snapshots: [], controlLeaseId: "lease-1" },
        })),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => ({
          id: where.id,
          ...data,
        })),
      },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ thread: { id: "thread-1" } }),
        findUnique: vi.fn().mockResolvedValue({ thread: { id: "thread-1" } }),
      },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: cleared }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
  }
  const input = {
    spaceId: "workspace-1",
    computerId: "computer-1",
    botId: "bot-1",
    leaseId: "lease-1",
    reason: "released" as const,
  };

  it("clears only the matching lease and tells the bot's chat", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = controlTx(1);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(releaseUserControl(prisma, input, fanout)).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1", controlLeaseId: "lease-1" },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          threadId: "thread-1",
          botId: "bot-1",
          payload: { holder: "none", leaseId: "lease-1", reason: "released" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("saves the teaching recording made under the lease as a draft, in the same transaction", async () => {
    const tx = controlTx(1, ["skill-1"]);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(releaseUserControl(prisma, input)).resolves.toBe(true);
    // Only recordings bound to this very lease are locked and ended.
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["lease-1"]);
    expect(tx.taughtSkill.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "skill-1" },
        data: expect.objectContaining({ status: "draft" }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "skill.teaching.stopped",
          payload: { skillId: "skill-1", reason: "stopped" },
        }),
      }),
    );
    // Its draft card posts in the same transaction, so no path can leave it unposted.
    expect(tx.message.create).toHaveBeenCalledOnce();
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "skill.draft.created",
          payload: expect.objectContaining({ skillId: "skill-1" }),
        }),
      }),
    );
  });

  it("does nothing when another lease holds the computer now", async () => {
    const tx = controlTx(0);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(releaseUserControl(prisma, input)).resolves.toBe(false);

    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("clears a lease left without a bot and writes no chat event", async () => {
    const tx = controlTx(1);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(releaseUserControl(prisma, { ...input, botId: null })).resolves.toBe(true);

    expect(tx.bot.findFirst).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });
});

describe("settleReleasedTakeoverCards", () => {
  it("writes a pending card once and does not write or notify when nothing is pending", async () => {
    const notify = vi.fn();
    let blocks: Array<{ kind: string; state?: string; text: string }> = [
      { kind: "text", text: "keep" },
      { kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Sign in to continue." },
      { kind: "computer", state: "Ready", text: "other" },
    ];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findMany: vi.fn(async () => [{ id: "message-1", blocks }]),
        update: vi.fn(async ({ data }: { data: { blocks: typeof blocks } }) => {
          blocks = data.blocks;
          return { id: "message-1" };
        }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const input = {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      reason: "takeover-skipped",
    };

    await settleReleasedTakeoverCards(prisma, input, notify);
    await settleReleasedTakeoverCards(prisma, input, notify);

    expect(tx.message.update).toHaveBeenCalledOnce();
    expect(blocks).toEqual([
      { kind: "text", text: "keep" },
      { kind: "computer", state: TAKEOVER_COMPUTER_SKIPPED_STATE, text: "Sign in to continue." },
      { kind: "computer", state: "Ready", text: "other" },
    ]);
    expect(tx.event.create).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("thread-1", 3);
  });
});

describe("pauseRunForInput", () => {
  it("does not release a successor's computer lease after losing worker ownership", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;
    await expect(
      pauseRunForInput(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "stale-worker",
        leaseFence: 1,
        blocks: [{ kind: "ask", text: "Which city?" }],
      }),
    ).resolves.toBe(false);
    expect(tx.computerExecutionLease.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { pending: false, owner: "persisted-owner" },
    { pending: true, owner: "persisted-owner" },
    { pending: false, owner: null },
  ])(
    "pauses atomically with persisted owner $owner (pending=$pending)",
    async ({ pending, owner }) => {
      const fanout = new TestFanout();
      const publish = vi.spyOn(fanout, "publish");
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        run: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "continuation-1" }),
          findUnique: vi.fn().mockResolvedValue({
            status: "running",
            userId: owner,
            createdAt: new Date("2026-08-16T12:00:00.000Z"),
            threadId: "thread-1",
          }),
        },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        task: { create: vi.fn().mockResolvedValue({ id: "task-next" }) },
        steeringMessage: {
          findMany: vi.fn().mockResolvedValue(
            pending
              ? [
                  {
                    id: "steering-1",
                    userId: "user-1",
                    originTrigger: "webhook",
                    message: {
                      id: "webhook-message",
                      seq: 3,
                      blocks: [{ kind: "text", text: "Next work" }],
                    },
                  },
                ]
              : [],
          ),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: {
          update: vi
            .fn()
            .mockResolvedValueOnce({ nextMessageSeq: 4 })
            .mockResolvedValueOnce({ nextEventSeq: 8 })
            .mockResolvedValueOnce({ nextEventSeq: 9 }),
        },
        message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        pauseRunForInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            botId: "bot-1",
            runId: "run-1",
            attemptId: "attempt-1",
            leaseOwner: "worker-1",
            leaseFence: 3,
            ...{ userId: "untrusted-owner" },
            blocks: [{ kind: "ask", text: "Which city?" }],
          },
          fanout,
        ),
      ).resolves.toEqual({ continuationRunId: pending ? "continuation-1" : null });

      expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
        where: { runId: "run-1" },
        data: { expiresAt: new Date(0) },
      });
      if (pending) {
        expect(tx.run.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            status: "queued",
            trigger: "webhook",
            sourceMessageId: "webhook-message",
          }),
        });
        expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ["steering-1"] }, runId: null },
          data: { runId: "continuation-1", claimedAt: null },
        });
      } else expect(tx.run.create).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            botId: "bot-1",
            runId: "run-1",
            role: "bot",
          }),
        }),
      );
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "run-1",
            spaceId: "workspace-1",
            threadId: "thread-1",
            botId: "bot-1",
            status: "running",
            leaseOwner: "worker-1",
            leaseFence: 3,
          },
          data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
        }),
      );
      expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).toEqual([
        "thread.message.created",
        "run.waiting_input",
      ]);
      expect(tx.run.findUnique).toHaveBeenCalledWith({
        where: { id: "run-1" },
        select: { userId: true },
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          runId: "run-1",
          type: "run.waiting_input",
          payload: owner ? { userId: owner } : {},
        }),
      });
      expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
    },
  );

  it("stores offered choice actions on the run checkpoint for resume", async () => {
    const fanout = new TestFanout();
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "use [redacted]" },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
          offeredActions: [
            { id: "choice-1", label: "use sk-live-choice-secret" },
            { id: "choice-2", label: "use plain" },
          ],
        },
        fanout,
      ),
    ).resolves.toEqual({ continuationRunId: null });

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "waiting_input",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: JSON.stringify({
            kind: "choice_ask_v1",
            actions: [
              { id: "choice-1", label: "use sk-live-choice-secret" },
              { id: "choice-2", label: "use plain" },
            ],
          }),
        },
      }),
    );
  });
});

describe("pauseRunForTakeover", () => {
  it("stores the paused run, attempt, and event in one transaction without touching the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: { findFirst: vi.fn(), updateMany: vi.fn() },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          reason: "Sign in",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: {
          status: "waiting_takeover",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: null,
        },
      }),
    );
    expect(tx.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "waiting_takeover" }) }),
    );
    expect(tx.computer.findFirst).not.toHaveBeenCalled();
    expect(tx.computer.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.requested",
          payload: {
            reason: "Sign in",
            takeoverRequested: true,
            retainedControl: true,
          },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });
});

describe("answerRunInput", () => {
  it("answers only the selected pending prompt and publishes its update", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Paris" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "choice-2",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
        data: { status: "queued", checkpoint: null },
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "choice-2",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Paris" },
            ],
          },
        ],
      },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Selected choice choice-2: Paris" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.updated", botId: "bot-2" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 9 }));
  });

  it("keeps a routine's instructions and every earlier answer across choice resumes", async () => {
    // A routine run sees no thread history: its resumed attempt only has the task prompt.
    const answerChoice = async (prompt: string, question: string, answer: string) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: question,
                status: "pending",
                actions: [
                  { id: "choice-1", label: "Two people" },
                  { id: "choice-2", label: "Italian" },
                ],
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({
            botId: "bot-2",
            userId: "user-1",
            trigger: "routine",
            task: { prompt },
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            status: "queued",
            createdAt: new Date("2026-08-16T12:00:00.000Z"),
            threadId: "thread-1",
          }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      await expect(
        answerRunInput(prisma, {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer,
        }),
      ).resolves.toBe(true);
      return (tx.task.updateMany.mock.calls[0]![0] as { data: { prompt: string } }).data.prompt;
    };

    const afterFirst = await answerChoice("Plan tonight's dinner.", "Who is eating?", "choice-1");
    expect(afterFirst).toBe(
      "Plan tonight's dinner.\n\nWho is eating?\nAnswer: Selected choice choice-1: Two people",
    );
    const afterSecond = await answerChoice(afterFirst, "Which cuisine?", "choice-2");
    expect(afterSecond).toBe(
      [
        "Plan tonight's dinner.",
        "Who is eating?\nAnswer: Selected choice choice-1: Two people",
        "Which cuisine?\nAnswer: Selected choice choice-2: Italian",
      ].join("\n\n"),
    );
  });

  it("resumes an answered creation intro or daily check-in as the user's turn", async () => {
    const answerIntro = async (
      answer: string,
      opener: { trigger: string; clientNonce?: string } = { trigger: "created" },
    ) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "What do you want me for?",
                status: "pending",
                actions: [
                  { id: "choice-1", label: "Just testing things out" },
                  { id: "choice-2", label: "Research and one-off tasks" },
                ],
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({
            botId: "bot-2",
            userId: "user-1",
            ...opener,
            task: { prompt: "You were just created." },
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            status: "queued",
            createdAt: new Date("2026-08-16T12:00:00.000Z"),
            threadId: "thread-1",
          }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      await expect(
        answerRunInput(prisma, {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer,
        }),
      ).resolves.toBe(true);
      return tx;
    };

    // The executor gives a "user" run the thread and every tool; the answer is its prompt,
    // which the restored ask_user call receives as its result.
    const chosen = await answerIntro("choice-2");
    expect(chosen.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", trigger: "user", checkpoint: null },
      }),
    );
    expect(chosen.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Selected choice choice-2: Research and one-off tasks" },
    });

    const checkIn = await answerIntro("choice-1", {
      trigger: "routine",
      clientNonce: "strategic-initiative:bot-2:1",
    });
    expect(checkIn.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "user" }) }),
    );

    const typed = await answerIntro("Track our competitors' launches");
    expect(typed.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "user" }) }),
    );
    expect(typed.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Track our competitors' launches" },
    });
  });

  it("records a spoken call answer as a user utterance with the call identity", async () => {
    const fanout = new TestFanout();
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      user: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
        create: vi.fn().mockResolvedValue({ id: "user-answer" }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          startedAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 5 }) },
      event: {
        create: vi.fn(
          async ({ data }: { data: { seq: number; type: string; payload: unknown } }) => ({
            ...event(data.seq),
            type: data.type,
            payload: data.payload,
          }),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Toronto",
          clientNonce: "call:call-1:answer-1",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "thread-1",
        role: "user",
        botId: "bot-2",
        authorUserId: "user-1",
        runId: "run-1",
        clientNonce: "call:call-1:answer-1",
        blocks: [{ kind: "text", text: "Toronto" }],
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({
            messageId: "user-answer",
            role: "user",
            callId: "call-1",
          }),
        }),
      }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Toronto" },
    });
  });

  it.each([undefined, "call:call-1:choice-1"])(
    "resumes with the full offered choice label (call nonce: %s)",
    async (clientNonce) => {
      const fanout = new TestFanout();
      const secret = "sk-live-choice-secret";
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        user: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "Which token?",
                status: "pending",
                actions: [
                  { id: "choice-1", label: `use [redacted]` },
                  { id: "choice-2", label: "use plain" },
                ],
              },
            ],
          }),
          create: vi.fn().mockResolvedValue({ id: "spoken-choice" }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({
            botId: "bot-2",
            userId: "user-1",
            checkpoint: JSON.stringify({
              kind: "choice_ask_v1",
              actions: [
                { id: "choice-1", label: `use ${secret}` },
                { id: "choice-2", label: "use plain" },
              ],
            }),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            status: "queued",
            createdAt: new Date("2026-08-16T12:00:00.000Z"),
            threadId: "thread-1",
          }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: "choice-1",
            clientNonce,
          },
          fanout,
        ),
      ).resolves.toBe(true);

      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-1" } } },
        data: { prompt: `Selected choice choice-1: use ${secret}` },
      });
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "message-1" },
        data: {
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "answered",
              answer: "choice-1",
              actions: [
                { id: "choice-1", label: "use [redacted]" },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
        },
      });
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "queued", checkpoint: null },
        }),
      );
    },
  );

  it("answers a custom free-text reply that is not an offered choice", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Seoul" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 12 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Toronto",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", checkpoint: null },
      }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Toronto" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "Toronto",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Seoul" },
            ],
          },
        ],
      },
    });
  });

  it("treats a typed choice label as selecting that option", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Seoul" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 13 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Seoul",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: "Selected choice choice-2: Seoul" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "choice-2",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Seoul" },
            ],
          },
        ],
      },
    });
  });
});

describe("answerWaitingRunWithTextInTransaction", () => {
  it.each(["latest", "older", "reaction", "reply", "unrelated-reply"])(
    "composer answers only the latest question unless an older question is explicitly targeted (case=%s)",
    async (scenario) => {
      const latest = scenario !== "older" && scenario !== "reply";
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "message-1",
              blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
            },
          ]),
          findFirst: vi.fn(async ({ where }: { where: { id?: string; seq?: { lt: number } } }) =>
            scenario === "reaction" && !where.id && !where.seq
              ? {
                  id: "reaction-1",
                  seq: 3,
                  role: "user",
                  replyToMessageId: "message-1",
                  blocks: [{ kind: "text", text: "❤️" }],
                }
              : {
                  id: where.id || latest ? "message-1" : "newer-message",
                  blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
                },
          ),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };

      const answerInput = {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "Paris",
      };
      const result = await answerWaitingRunWithTextInTransaction(tx as never, {
        ...answerInput,
        ...(scenario === "reply"
          ? { replyToMessageId: "message-1" }
          : scenario === "unrelated-reply"
            ? { replyToMessageId: "unrelated-message" }
            : {}),
      });
      if (latest || scenario === "reply") {
        expect(result).toMatchObject({ threadId: "thread-1" });
      } else {
        expect(result).toBeNull();
        expect(tx.run.updateMany).not.toHaveBeenCalled();
        const prisma = {
          $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
        } as unknown as PrismaClient;
        await expect(
          answerRunInput(prisma, { ...answerInput, messageId: "message-1" }),
        ).resolves.toBe(true);
        expect(tx.message.findFirst).toHaveBeenCalledWith({
          where: { id: "message-1", threadId: "thread-1", runId: "run-1", role: "bot" },
        });
      }
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-1" } } },
        data: { prompt: "Paris" },
      });
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "queued" },
        }),
      );
    },
  );

  it("leaves approval and secret cards on the dedicated answer path", async () => {
    const tx = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                approvalEffectId: "effect-1",
                text: "Review before writing",
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        ]),
      },
      run: { findFirst: vi.fn(), updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
    };

    await expect(
      answerWaitingRunWithTextInTransaction(tx as never, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBeNull();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("answerRunInput approvals", () => {
  it("approves consequential actions without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "effect-1", kind: "connector_write", status: "intended" }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const audit = { securityEvent: { create: vi.fn(async () => ({})) } };
    installSecurityEventStore(audit as never);

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "allow",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    installSecurityEventStore(undefined);
    expect(audit.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "approval.decided",
        userId: "user-1",
        spaceId: "workspace-1",
        metadata: { decision: "allow", effectKind: "connector_write", runId: "run-1" },
      }),
    });

    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith({
      where: {
        id: "effect-1",
        spaceId: "workspace-1",
        runId: "run-1",
        status: "intended",
      },
    });
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
  });

  it("leaves an approval to the run's own user in a shared space", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn(),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn(), update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-2",
          answer: "allow",
        },
        new TestFanout(),
      ),
    ).resolves.toBe(false);
    expect(tx.externalEffect.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("leaves an Ask first sign-in to the run's own user in a group thread", async () => {
    const effect = {
      id: "effect-1",
      kind: "browser_act",
      status: "intended",
      request: {
        actions: [{ kind: "fill_secret", ref: "e1", secret: "work", field: "Password" }],
        loginApproval: {
          kind: "login",
          login: "work",
          site: "https://example.test",
          title: "Work login",
          fields: ["Password"],
          savedAt: "2026-11-01T00:00:00.000Z",
        },
      },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Sign in to example.test with Work login?",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn(),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "run-owner" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(effect), update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    // Another member of the group, for either answer: only the owner's runs use their vault.
    for (const answer of ["allow", "deny"]) {
      await expect(
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "group-member",
            answer,
          },
          new TestFanout(),
        ),
      ).resolves.toBe(false);
    }
    expect(tx.externalEffect.update).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["destination.write", {}, "tool", "destination.write", false],
    ["web_fetch", { url: "https://docs.example.com/a?b=c" }, "site", "example.com", true],
    [
      "paid_request",
      { url: "https://api.example.com/quote", method: "GET" },
      "site",
      "example.com",
      false,
    ],
    // secret_request also carries a url, but its card allows the tool, not a site.
    [
      "secret_request",
      { name: "API", url: "https://api.example.com/x" },
      "tool",
      "secret_request",
      false,
    ],
    [
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] },
      "tool",
      "GMAIL_SEND_EMAIL",
      false,
    ],
  ])(
    "approves %s and upserts always-allow without overwriting the task prompt",
    async (kind, request, matchKind, matchValue, spaceOverridesConfirmations) => {
      const fanout = new TestFanout();
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                approvalEffectId: "effect-1",
                text: "Review before writing",
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "always", label: "Always allow" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({ userId: "user-1", status: "queued" }),
        },
        task: { updateMany: vi.fn() },
        externalEffect: {
          findFirst: vi.fn().mockResolvedValue({
            id: "effect-1",
            status: "intended",
            kind,
            request,
            batchActions: kind === "COMPOSIO_MULTI_EXECUTE_TOOL" ? ["GMAIL_SEND_EMAIL"] : null,
          }),
          update: vi.fn().mockResolvedValue({ id: "effect-1" }),
        },
        spaceSettingOverride: {
          findUnique: vi
            .fn()
            .mockResolvedValue(spaceOverridesConfirmations ? { setting: "confirmations" } : null),
        },
        actionApprovalRule: {
          findMany: vi.fn().mockResolvedValue([
            { id: "rule-0", matchValue: matchValue.toUpperCase() },
            { id: "rule-other", matchValue: `${matchValue}.other` },
          ]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: "rule-1" }),
        },
        userActionApprovalRule: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "account-rule-0", matchValue: matchValue.toUpperCase() }]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: "rule-1" }),
        },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: "always",
          },
          fanout,
        ),
      ).resolves.toBe(true);

      expect(tx.task.updateMany).not.toHaveBeenCalled();
      expect(tx.externalEffect.update).toHaveBeenCalledWith({
        where: { id: "effect-1" },
        data: { status: "approved" },
      });
      expect(tx.spaceSettingOverride.findUnique).toHaveBeenCalledWith({
        where: {
          spaceId_userId_setting: {
            spaceId: "workspace-1",
            userId: "user-1",
            setting: "confirmations",
          },
        },
        select: { setting: true },
      });
      const rule = { effect: "always_allow", matchKind, matchValue };
      if (spaceOverridesConfirmations) {
        const row = { spaceId: "workspace-1", createdByUserId: "user-1", ...rule };
        // The opposite rule on the same match goes, ignoring case.
        expect(tx.actionApprovalRule.deleteMany).toHaveBeenCalledWith({
          where: { id: { in: ["rule-0"] } },
        });
        expect(tx.actionApprovalRule.upsert).toHaveBeenCalledWith({
          where: { spaceId_createdByUserId_effect_matchKind_matchValue: row },
          create: row,
          update: {},
        });
        expect(tx.userActionApprovalRule.upsert).not.toHaveBeenCalled();
      } else {
        const row = { userId: "user-1", ...rule };
        expect(tx.userActionApprovalRule.deleteMany).toHaveBeenCalledWith({
          where: { id: { in: ["account-rule-0"] } },
        });
        expect(tx.userActionApprovalRule.upsert).toHaveBeenCalledWith({
          where: { userId_effect_matchKind_matchValue: row },
          create: row,
          update: {},
        });
        expect(tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [
      "a batch",
      ["GMAIL_ARCHIVE_THREAD", "GMAIL_SEND_EMAIL"],
      ["GMAIL_ARCHIVE_THREAD", "GMAIL_SEND_EMAIL"],
    ],
    ["a batch with an entry naming no action", [], []],
    [
      "a batch from before its actions were recorded",
      null,
      ["mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"],
    ],
  ])("always allows each action of %s, never the batch tool", async (_, batchActions, saved) => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before GMAIL_SEND_EMAIL",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ userId: "user-1", status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          status: "intended",
          kind: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
          request: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] },
          batchActions,
        }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userActionApprovalRule: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue({ id: "rule-1" }),
      },
      actionApprovalRule: { upsert: vi.fn() },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "always",
        },
        new TestFanout(),
      ),
    ).resolves.toBe(true);

    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
    expect(
      tx.userActionApprovalRule.upsert.mock.calls.map(([call]) => call.create.matchValue),
    ).toEqual(saved);
  });

  it("does not let another workspace member create an always-allow rule for the run owner", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "run-owner" }),
        findUnique: vi.fn().mockResolvedValue({ userId: "run-owner" }),
        updateMany: vi.fn(),
      },
      externalEffect: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "effect-1", status: "intended", kind: "destination.write" }),
      },
      actionApprovalRule: { upsert: vi.fn() },
      userActionApprovalRule: { upsert: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "other-member",
        answer: "always",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
    expect(tx.userActionApprovalRule.upsert).not.toHaveBeenCalled();
  });

  it("does not resume another member's question as that member", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "run-owner" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "other-member",
        answer: "Paris",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("does not queue a run when an approval card has no matching effect", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "missing-effect",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does not queue a run for an action that the approval card did not offer", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "always",
      }),
    ).resolves.toBe(false);
    expect(tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a secret answer over the value limit without storing it", async () => {
    const store = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Code", input: "secret", status: "pending" }],
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "x".repeat(BOT_SECRET_VALUE_MAX_LENGTH + 1),
        },
        new TestFanout(),
        { store },
      ),
    ).rejects.toThrow(AnswerTooLongError);
    expect(store).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("loads the space's content keys before opening the transaction", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const all = vi.fn(async () => {
      order.push("keys");
      return [];
    });
    const prisma = {
      $contentEncryption: () => ({ ring: { all } }),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
        order.push("transaction");
        return callback(tx);
      }),
    } as unknown as PrismaClient;

    await answerRunInput(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-1",
      answeredByUserId: "user-1",
      answer: "yes",
    });

    expect(all).toHaveBeenCalledWith("workspace-1");
    expect(order).toEqual(["keys", "transaction"]);
  });

  it("rejects input when the run is no longer waiting", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
      message: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const store = vi.fn();

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "fake-key",
        },
        undefined,
        { store },
      ),
    ).resolves.toBe(false);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run-1",
          spaceId: "workspace-1",
          threadId: "thread-1",
          status: "waiting_input",
        },
      }),
    );
    expect(tx.message.findFirst).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an already answered prompt without queuing the run", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "Rome",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
  ])("stores secret asks without writing plaintext to the task prompt (%j)", async (credential) => {
    const fanout = new TestFanout();
    const store = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              purpose: "api_key",
              ...(credential ? { credential } : {}),
              status: "pending",
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "123456",
        },
        fanout,
        { store },
      ),
    ).resolves.toBe(true);

    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        plaintext: "123456",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "workspace-1",
        credential,
      }),
    );
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(tx.event.create.mock.calls)).not.toContain("123456");
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        spaceId: "workspace-1",
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(credential ? { result: { credentialSaved: credential } } : {}),
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            purpose: "api_key",
            ...(credential ? { credential } : {}),
            status: "answered",
            answer: "",
          },
        ],
      },
    });
  });

  it.each([
    ["saves a login card answered as is", "login", undefined, true, true],
    ["keeps a login answered with Save to Vault off for the run", "login", false, true, false],
    ["turns down not saving an API key", "bearer", false, false, undefined],
    ["turns down another member's login for this run only", "member", false, false, undefined],
  ] as const)("%s", async (_name, kind, remember, accepted, remembered) => {
    const type = kind === "member" ? "login" : kind;
    const credential =
      type === "login"
        ? { name: "site_login", origin: "https://login.example.test", auth: { type: "login" } }
        : { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } };
    const store = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Sign in",
              input: "secret",
              purpose: "password",
              credential,
              status: "pending",
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: kind === "member" ? "user-2" : "user-1",
          ...(type === "login"
            ? {
                answer: "",
                fields: [
                  { label: "Username", value: "fake-user@example.test", hidden: false },
                  { label: "Password", value: "fake-password-1", hidden: true },
                ],
              }
            : { answer: "fake-password-1" }),
          ...(remember === false ? { remember } : {}),
        },
        new TestFanout(),
        { store },
      ),
    ).resolves.toBe(accepted);
    if (!accepted) {
      expect(store).not.toHaveBeenCalled();
      return;
    }
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({ credential, remember: remembered }),
    );
    // The answered card keeps the choice, so it reads "Sent" rather than "Saved" after a reload.
    const [block] = (tx.message.update.mock.calls[0]![0] as { data: { blocks: unknown[] } }).data
      .blocks as Record<string, unknown>[];
    expect(block!.remembered).toBe(remembered ? undefined : false);
  });

  it("does not let another workspace member save a credential as the run owner", async () => {
    const store = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "owner" }),
        updateMany: vi.fn(),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "API key",
              input: "secret",
              status: "pending",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          ],
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    expect(
      await answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "other-member",
          answer: "fake-key",
        },
        new TestFanout(),
        { store },
      ),
    ).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  describe("answering a one-time code card", () => {
    const oneTimeCode = { origin: "https://login.example.test" };

    function codeCard() {
      const store = vi.fn().mockResolvedValue(undefined);
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "Enter the code",
                input: "secret",
                purpose: "otp",
                oneTimeCode,
                status: "pending",
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        task: { updateMany: vi.fn() },
        externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const answer = (answer: string, answeredByUserId = "user-1") =>
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId,
            answer,
          },
          new TestFanout(),
          { store },
        );
      return { store, tx, answer };
    }

    it("stores the code as the page takes it, and keeps it out of the card and the events", async () => {
      const { store, tx, answer } = codeCard();
      await expect(answer(" 123 456 ")).resolves.toBe(true);
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({ plaintext: "123456", remember: true, userId: "user-1" }),
      );
      expect(store.mock.calls[0]![0].credential).toBeUndefined();
      expect(tx.task.updateMany).not.toHaveBeenCalled();
      const written = JSON.stringify([tx.message.update.mock.calls, tx.event.create.mock.calls]);
      expect(written).not.toContain("123456");
      const [block] = (tx.message.update.mock.calls[0]![0] as { data: { blocks: unknown[] } }).data
        .blocks as Record<string, unknown>[];
      expect(block).toMatchObject({ status: "answered", answer: "", oneTimeCode });
    });

    it("lets only the run's user answer", async () => {
      const { store, tx, answer } = codeCard();
      await expect(answer("123456", "other-member")).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it.each(["", "   ", "ok", "123", "x".repeat(13), "12.34"])(
      "keeps nothing that is not a code: %j",
      async (text) => {
        const { store, tx, answer } = codeCard();
        await expect(answer(text)).resolves.toBe(false);
        expect(store).not.toHaveBeenCalled();
        expect(tx.run.updateMany).not.toHaveBeenCalled();
      },
    );
  });

  describe("dismissing a secret request", () => {
    const login = {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    };

    function setup(options: {
      block?: Record<string, unknown>;
      ownerId?: string;
      trigger?: string;
      effect?: { id: string } | null;
    }) {
      const block = options.block ?? {
        kind: "ask",
        text: "Example sign-in",
        input: "secret",
        purpose: "password",
        credential: login,
        status: "pending",
      };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({ id: "message-1", blocks: [block] }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({
            botId: "bot-1",
            userId: options.ownerId ?? "user-1",
            trigger: options.trigger ?? "message",
            task: { prompt: "Sign in to the example site" },
          }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        externalEffect: {
          findFirst: vi
            .fn()
            .mockResolvedValue(options.effect === undefined ? { id: "effect-1" } : options.effect),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const writer = { store: vi.fn(), withPrepared: vi.fn() };
      const dismiss = (input: Record<string, unknown> = {}) =>
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: "",
            dismiss: true,
            ...input,
          },
          new TestFanout(),
          writer,
        );
      return { tx, writer, dismiss, block };
    }

    it.each([
      ["a login card", undefined],
      [
        "a connector code card",
        { kind: "ask", text: "Enter the code", input: "secret", purpose: "otp", status: "pending" },
      ],
    ])("resumes the run with the dismissal and stores nothing for %s", async (_name, block) => {
      const h = setup({ block });

      await expect(h.dismiss()).resolves.toBe(true);

      expect(h.writer.withPrepared).not.toHaveBeenCalled();
      expect(h.writer.store).not.toHaveBeenCalled();
      expect(h.tx.run.updateMany).toHaveBeenCalledWith({
        where: {
          id: "run-1",
          spaceId: "workspace-1",
          threadId: "thread-1",
          status: "waiting_input",
        },
        data: { status: "queued" },
      });
      const request = {
        runId: "run-1",
        spaceId: "workspace-1",
        kind: "request_secret",
        status: "intended",
      };
      expect(h.tx.externalEffect.updateMany).toHaveBeenCalledWith({
        where: request,
        data: { status: "completed", result: { ok: false, dismissed: true } },
      });
      expect(h.tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-1" } } },
        data: { prompt: "The user dismissed this request." },
      });
      expect(h.tx.message.update).toHaveBeenCalledWith({
        where: { id: "message-1" },
        data: { blocks: [{ ...h.block, status: "answered", answer: "", dismissed: true }] },
      });
    });

    it("keeps a background run's instructions in the resumed prompt", async () => {
      const h = setup({ trigger: "routine" });
      await expect(h.dismiss()).resolves.toBe(true);
      expect(h.tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-1" } } },
        data: {
          prompt:
            "Sign in to the example site\n\nExample sign-in\nAnswer: The user dismissed this request.",
        },
      });
    });

    it.each([
      ["another member of the space", { ownerId: "owner" }, {}],
      [
        "another member, for a connector code",
        {
          ownerId: "owner",
          block: { kind: "ask", text: "Enter the code", input: "secret", status: "pending" },
        },
        {},
      ],
      [
        "a question card",
        {
          block: { kind: "ask", text: "Which city?", status: "pending" },
        },
        {},
      ],
      [
        "an approval card",
        {
          block: {
            kind: "ask",
            text: "Review before writing",
            input: "secret",
            approvalEffectId: "effect-1",
            status: "pending",
            actions: [{ id: "allow", label: "Allow once" }],
          },
        },
        {},
      ],
      [
        "an answered card",
        {
          block: {
            kind: "ask",
            text: "Example sign-in",
            input: "secret",
            credential: login,
            status: "answered",
            answer: "",
          },
        },
        {},
      ],
      ["a card without a pending request", { effect: null }, {}],
      ["a dismissal that carries a value", {}, { answer: "example-password" }],
      ["a dismissal that carries a username", {}, { username: "ada" }],
    ])("rejects a dismissal from %s", async (_name, options, input) => {
      const h = setup(options);

      await expect(h.dismiss(input)).resolves.toBe(false);

      expect(h.tx.run.updateMany).not.toHaveBeenCalled();
      expect(h.tx.externalEffect.updateMany).not.toHaveBeenCalled();
      expect(h.tx.message.update).not.toHaveBeenCalled();
      expect(h.writer.store).not.toHaveBeenCalled();
    });
  });

  describe("login cards", () => {
    const login = {
      name: "site_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    };
    function loginFixture(credential: object = login, loginFields?: string[]) {
      const store = vi.fn().mockResolvedValue(undefined);
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "Sign in",
                input: "secret",
                purpose: "password",
                credential,
                ...(loginFields ? { loginFields } : {}),
                status: "pending",
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        task: { updateMany: vi.fn() },
        externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const answerWith = (input: Partial<AnswerRunInput>) =>
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: "",
            ...input,
          },
          new TestFanout(),
          { store },
        );
      // How an app that predates login fields answers.
      const answer = (username?: string, password = "fake-password-1") =>
        answerWith({ answer: password, ...(username !== undefined ? { username } : {}) });
      return { store, tx, answer, answerWith };
    }

    const bankFields = [
      { label: "ID number", value: "fake-id-123", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: true },
    ];

    it("stores the requested fields as the person marked them and records none", async () => {
      const { store, tx, answerWith } = loginFixture(login, ["ID number", "Phone number"]);
      await expect(answerWith({ fields: bankFields })).resolves.toBe(true);
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: login,
          plaintext: encodeLoginSecret({ fields: bankFields }),
        }),
      );
      const recorded = JSON.stringify([tx.event.create.mock.calls, tx.message.update.mock.calls]);
      expect(recorded).not.toContain("fake-id-123");
      expect(recorded).not.toContain("+1 555 0100");
    });

    it.each([
      ["a missing field", [bankFields[0]!]],
      ["an extra field", [...bankFields, { label: "PIN", value: "1234", hidden: true }]],
      ["a renamed field", [bankFields[0]!, { ...bankFields[1]!, label: "Mobile" }]],
      ["fields out of order", [bankFields[1]!, bankFields[0]!]],
      ["an empty field", [bankFields[0]!, { ...bankFields[1]!, value: "" }]],
    ])("rejects an answer with %s", async (_name, fields) => {
      const { store, tx, answerWith } = loginFixture(login, ["ID number", "Phone number"]);
      await expect(answerWith({ fields })).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a username and password on a card that asked for other fields", async () => {
      const { store, answer } = loginFixture(login, ["ID number", "Phone number"]);
      await expect(answer("fake-id-123", "+1 555 0100")).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
    });

    it("rejects fields with a value in answer too", async () => {
      const { store, answerWith } = loginFixture(login, ["ID number", "Phone number"]);
      await expect(answerWith({ fields: bankFields, answer: "+1 555 0100" })).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
    });

    it("stores an older app's username and password as a visible and a hidden field", async () => {
      const { store, tx, answer } = loginFixture();
      await expect(answer("  fake-user@example.test ")).resolves.toBe(true);
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: login,
          plaintext: encodeLoginSecret({
            fields: [
              { label: "Username", value: "fake-user@example.test", hidden: false },
              { label: "Password", value: "fake-password-1", hidden: true },
            ],
          }),
        }),
      );
      const recorded = JSON.stringify([tx.event.create.mock.calls, tx.message.update.mock.calls]);
      expect(recorded).not.toContain("fake-user@example.test");
      expect(recorded).not.toContain("fake-password-1");
    });

    it.each(["", "   "])("requires a username (%j)", async (username) => {
      const { store, tx, answer } = loginFixture();
      await expect(answer(username)).resolves.toBe(false);
      await expect(answer()).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an oversized password before queueing, not with an internal error", async () => {
      const { store, tx, answer } = loginFixture();
      await expect(answer("fake-user", "x".repeat(4097))).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a username or fields on a card that is not a login", async () => {
      const { store, answer, answerWith } = loginFixture({ ...login, auth: { type: "bearer" } });
      await expect(answer("fake-user")).resolves.toBe(false);
      await expect(answerWith({ answer: "fake-token", fields: bankFields })).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
    });
  });

  it("rejects secret asks when no run secret writer is configured", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              status: "pending",
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "123456",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("queue admission beside pending cards", () => {
  it.each(["user", "webhook", "messaging", "follow_up"] as const)(
    "admits a %s wake beside waiting_input",
    async (trigger) => {
      const tx = {
        $queryRaw: vi.fn(async () => []),
        space: { findUnique: vi.fn() },
        thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 4 }) },
        message: {
          create: vi.fn().mockResolvedValue({ id: "message-new", seq: 2 }),
          update: vi.fn(),
        },
        run: {
          findMany: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) =>
            where.status.in.includes("waiting_input")
              ? [{ id: "paused", taskId: "task-old", trigger: "user" }]
              : [],
          ),
          create: vi.fn().mockResolvedValue({ id: "run-new" }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-new" }) },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ threadId: "thread-1", seq: 3 }) },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      } as unknown as PrismaClient;
      await expect(
        sendUserMessage(prisma, {
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "New work" }],
          prompt: "New work",
          trigger,
        }),
      ).resolves.toMatchObject({ runId: "run-new", taskId: "task-new" });
      expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    },
  );

  it("answers waiting app and direct-line messages before earlier webhook deliveries and group texts", async () => {
    const row = (id: string, seq: number, originTrigger: string | null, blocks: unknown[]) => ({
      id,
      userId: "user-1",
      originTrigger,
      message: { id: `message-${id}`, blocks, seq },
    });
    const group = {
      kind: "channel_message",
      provider: "sendblue",
      channelId: "channel-1",
      fromAddress: "+15550000001",
      fromLabel: "Sam",
      text: "hi all",
    };
    const tx = {
      run: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "continuation" }),
      },
      steeringMessage: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            row("webhook", 1, "webhook", [{ kind: "text", text: "order shipped" }]),
            row("group", 2, "messaging", [group]),
            row("owner", 3, null, [{ kind: "text", text: "Status?" }]),
            row("owner-text", 4, "messaging", [{ kind: "text", text: "And the rest?" }]),
          ]),
        updateMany: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-new" }) },
    };
    await createPendingSteeringRun(tx as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["owner", "owner-text"] }, runId: null },
      data: { runId: "continuation", claimedAt: null },
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceMessageId: "message-owner-text" }),
    });

    // With no app or direct-line message waiting, the oldest origin goes first as before.
    tx.steeringMessage.findMany.mockResolvedValue([
      row("webhook", 1, "webhook", [{ kind: "text", text: "order shipped" }]),
      row("group", 2, "messaging", [group]),
    ]);
    await createPendingSteeringRun(tx as never, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ["webhook"] }, runId: null },
      data: { runId: "continuation", claimedAt: null },
    });
  });

  it("creates a pending steering continuation without attaching it to a paused run", async () => {
    const tx = {
      run: {
        findFirst: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) =>
          where.status.in.includes("waiting_input") ? { id: "paused" } : null,
        ),
        create: vi.fn().mockResolvedValue({ id: "continuation" }),
      },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "steering-1",
            userId: "user-1",
            originTrigger: null,
            message: { id: "new-message", blocks: [{ kind: "text", text: "Continue" }], seq: 3 },
          },
        ]),
        updateMany: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-new" }) },
    };
    await expect(
      createPendingSteeringRun(tx as never, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
      }),
    ).resolves.toBe("continuation");
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steering-1"] }, runId: null },
      data: { runId: "continuation", claimedAt: null },
    });
  });
});

describe("sendUserMessage", () => {
  it("creates the message, run, and event in one transaction and publishes once", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    let committed = false;
    const analytics = {
      capture: vi.fn(() => expect(committed).toBe(true)),
      flush: async () => undefined,
    };
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4, createdAt }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1" }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
        const result = await callback(tx);
        committed = true;
        return result;
      }),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "hello" }],
          prompt: "hello",
          trigger: "user",
          clientNonce: "nonce-1",
          linkMessageToRun: true,
        },
        fanout,
        analytics,
      ),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: "task-1", runId: "run-1" });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          clientNonce: "send:message-1",
          sourceMessageId: "message-1",
        }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", runId: "run-1" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
    expect(analytics.capture).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      { name: "message_sent", trigger: "user" },
      { id: "message-1", at: createdAt },
    );
    expect(JSON.stringify(analytics.capture.mock.calls)).not.toContain("hello");
    vi.mocked(prisma.message.findUnique).mockResolvedValue({
      id: "message-1",
      seq: 4,
      createdAt,
    } as never);
    await sendUserMessage(
      prisma,
      {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "user",
        clientNonce: "nonce-1",
        linkMessageToRun: true,
      },
      fanout,
      analytics,
    );
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not count a user message when its transaction rolls back", async () => {
    const failure = new Error("transaction rollback");
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockRejectedValue(failure),
    } as unknown as PrismaClient;
    const analytics = { capture: vi.fn(), flush: async () => undefined };
    await expect(
      sendUserMessage(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "private content" }],
          prompt: "private content",
          trigger: "user",
          clientNonce: "nonce-1",
        },
        undefined,
        analytics,
      ),
    ).rejects.toBe(failure);
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it("pins an agreed inbound model onto the run it creates", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "ping" }],
      prompt: "ping",
      trigger: "webhook",
      modelPin: {
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "webhook",
          modelProvider: "openai-compatible",
          modelId: "private-model",
          thinkingLevel: "low",
          modelPinned: true,
        }),
      }),
    );
  });

  it("persists steering instead of starting a parallel run when the bot is busy", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-0", taskId: "task-0", trigger: "user", userId: "user-1" },
          ]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "follow_up",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-0" });

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-0" },
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: "run-0" },
    });
  });

  it.each([
    { waiting: "routine", trigger: "messaging", group: false },
    { waiting: "routine", trigger: "messaging", group: true },
    { waiting: "bot_message", trigger: "user", group: false },
    { waiting: "user", trigger: "webhook", group: false },
    { waiting: "user", trigger: "messaging", group: false },
    { waiting: "user", trigger: "messaging", group: true },
  ] as const)(
    "handles a message arriving at a $waiting takeover request ($trigger, group: $group)",
    async ({ waiting, trigger, group }) => {
      const tx = {
        $queryRaw: vi.fn(async () => []),
        space: { findUnique: vi.fn() },
        thread: {
          update: vi
            .fn()
            .mockResolvedValueOnce({ nextMessageSeq: 5 })
            .mockResolvedValueOnce({ nextEventSeq: 9 }),
        },
        message: {
          create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
          update: vi.fn(),
        },
        steeringMessage: { create: vi.fn() },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        run: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "run-takeover",
              taskId: "task-takeover",
              trigger: waiting,
              status: "waiting_takeover",
            },
          ]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1" }),
        },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      const sent = await sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [
          group
            ? {
                kind: "channel_message",
                provider: "sendblue",
                channelId: "channel-1",
                fromAddress: "+15550000001",
                fromLabel: "Sam",
                text: "ping",
              }
            : { kind: "text", text: "ping" },
        ],
        prompt: "ping",
        trigger,
      });

      if (waiting === "user" && group) {
        // Only the owner can end the owner's app task: a group text waits for it to finish.
        expect(sent.runId).toBe("run-takeover");
        expect(tx.run.create).not.toHaveBeenCalled();
        expect(tx.steeringMessage.create).toHaveBeenCalledWith({
          data: {
            messageId: "message-1",
            botId: "bot-1",
            userId: "user-1",
            runId: null,
            originTrigger: "messaging",
          },
        });
        return;
      }
      expect(sent.runId).toBe("run-1");
      expect(tx.run.create).toHaveBeenCalledTimes(1);
      expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    },
  );

  it("keeps an agreed inbound model on steering while a routine run is busy", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-routine", taskId: "task-routine", trigger: "routine" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "ping" }],
      prompt: "ping",
      trigger: "webhook",
      modelPin: {
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: null,
        originTrigger: "webhook",
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });
  });

  it("keeps an inbound message pending while the creation intro is active", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "intro-run", taskId: "intro-task", trigger: "created" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "Check the inbox" }],
        prompt: "Check the inbox",
        trigger: "user",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "intro-run" });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: null },
    });
  });

  it("keeps a messaging inbound's origin on the hold behind the creation intro", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "intro-run", taskId: "intro-task", trigger: "created" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "Check the inbox" }],
        prompt: "Check the inbox",
        trigger: "messaging",
        clientNonce: "messaging:slack:handle-1",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "intro-run" });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: null,
        originTrigger: "messaging",
      },
    });
  });

  it.each(["routine", "bot_message", "follow_up"])(
    "keeps the message pending when the busy run is a %s turn",
    async (trigger) => {
      const tx = {
        $queryRaw: vi.fn(async () => []),
        space: { findUnique: vi.fn() },
        thread: {
          update: vi
            .fn()
            .mockResolvedValueOnce({ nextMessageSeq: 5 })
            .mockResolvedValueOnce({ nextEventSeq: 9 }),
        },
        message: {
          create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        steeringMessage: { create: vi.fn() },
        task: { create: vi.fn() },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "run-routine", taskId: "task-routine", trigger }]),
          findUnique: vi.fn().mockResolvedValue({ status: "running" }),
          create: vi.fn(),
        },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        sendUserMessage(prisma, {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "hello" }],
          prompt: "hello",
          trigger: "messaging",
        }),
      ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-routine" });

      expect(tx.run.create).not.toHaveBeenCalled();
      // No run on the steering row: the routine never claims it; its continuation does.
      // The inbound stays messaging so that continuation is mirrored back to the app.
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: {
          messageId: "message-1",
          botId: "bot-1",
          userId: "user-1",
          runId: null,
          originTrigger: "messaging",
        },
      });
    },
  );

  it("keeps another member's message pending instead of steering the busy run", async () => {
    const tx = {
      space: { findUnique: vi.fn() },
      $queryRaw: vi.fn(async () => []),
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-0", taskId: "task-0", trigger: "user", userId: "user-1" },
          ]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-2",
      blocks: [{ kind: "text", text: "hello" }],
      prompt: "hello",
      trigger: "follow_up",
    });

    // The continuation that starts when the busy run ends acts as this sender.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-2", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("steers the conversational run when a parallel webhook turn is also active", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-webhook", taskId: "task-webhook", trigger: "webhook", userId: "user-1" },
          { id: "run-text", taskId: "task-text", trigger: "messaging", userId: "user-1" },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "messaging",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-text" });

    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-text",
        // Kept so an unclaimed release continues as messaging, never as an owner follow-up.
        originTrigger: "messaging",
      },
    });
  });
  it.each([
    {
      name: "prefers messaging over an app run",
      parallel: true,
      incoming: undefined,
      source: undefined,
      held: false,
    },
    {
      name: "holds group text during a direct run",
      parallel: false,
      incoming: "group-1",
      source: undefined,
      held: true,
    },
    {
      name: "holds direct text during a group run",
      parallel: false,
      incoming: undefined,
      source: "group-1",
      held: true,
    },
    {
      name: "holds text from a different group",
      parallel: false,
      incoming: "group-2",
      source: "group-1",
      held: true,
    },
    {
      name: "steers the same group",
      parallel: false,
      incoming: "group-1",
      source: "group-1",
      held: false,
    },
    {
      name: "steers the same direct chat",
      parallel: false,
      incoming: undefined,
      source: undefined,
      held: false,
    },
  ])("$name", async ({ parallel, incoming, source, held }) => {
    const blocks = (channelId: string | undefined) =>
      channelId
        ? [
            {
              kind: "channel_message" as const,
              provider: "test",
              channelId,
              fromAddress: "sender",
              fromLabel: "Sender",
              text: "hello",
            },
          ]
        : [{ kind: "text" as const, text: "hello" }];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn() },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValue([
          ...(parallel
            ? [{ id: "run-app", taskId: "task-app", trigger: "user", userId: "user-1" }]
            : []),
          {
            id: "run-text",
            taskId: "task-text",
            trigger: "messaging",
            userId: "user-1",
            sourceMessage: { blocks: blocks(source) },
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: blocks(incoming),
        prompt: "hello",
        trigger: "messaging",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-text" });

    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ sourceMessage: { select: { blocks: true } } }),
      }),
    );
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: held ? null : "run-text",
        // Kept so an unclaimed release continues as messaging, never as an owner follow-up.
        originTrigger: "messaging",
      },
    });
  });
});

describe("claimSteering", () => {
  const group = (fromAddress: string) => ({
    kind: "channel_message",
    provider: "telegram",
    channelId: "channel-1",
    fromAddress,
    fromLabel: "Someone",
    text: "Hello",
  });
  it.each([
    ["a webhook", "webhook", "user-1", [{ kind: "text", text: "Hello" }], "webhook"],
    ["the run's person in their connected chat", "messaging", "user-1", [], "user"],
    ["someone else's connected chat", "messaging", "user-2", [], "messaging"],
    ["the run's person in a group", "messaging", "user-1", [group("+15550001")], "user"],
    ["someone else in a group", "messaging", "user-1", [group("+15550002")], "messaging"],
  ] as const)(
    "marks a message from %s by its sender",
    async (_, originTrigger, userId, blocks, origin) => {
      const tx = {
        $queryRaw: vi.fn(),
        run: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: "run-1", spaceId: "space-1", userId: "user-1" }),
          findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: null }),
        },
        thread: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ nextMessageSeq: 7 }),
          update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }),
        },
        event: { create: vi.fn() },
        messagingIdentity: {
          findMany: vi.fn().mockResolvedValue([{ provider: "telegram", address: "+15550001" }]),
        },
        steeringMessage: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "steer-1",
              messageId: "message-1",
              userId,
              originTrigger,
              message: { seq: 5, blocks },
            },
          ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const [claimed] = await claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      });
      expect(claimed?.origin).toBe(origin);
    },
  );

  it("claims pending messages for the fenced run in message order", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-1", spaceId: "space-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: null }),
      },
      thread: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextMessageSeq: 7 }),
        update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }),
      },
      event: { create: vi.fn() },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "steer-1",
            messageId: "message-1",
            userId: "user-1",
            originTrigger: null,
            message: {
              seq: 5,
              blocks: [
                { kind: "text", text: "First" },
                {
                  kind: "image",
                  artifactId: "artifact-1",
                  name: "chart.png",
                  mimeType: "image/png",
                },
              ],
            },
          },
          {
            id: "steer-2",
            messageId: "message-2",
            userId: "user-2",
            originTrigger: null,
            message: { seq: 6, blocks: [{ kind: "text", text: "Second" }] },
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      }),
    ).resolves.toEqual([
      {
        id: "steer-1",
        messageId: "message-1",
        text: "First\n[image: chart.png]",
        blocks: [
          { kind: "text", text: "First" },
          {
            kind: "image",
            artifactId: "artifact-1",
            name: "chart.png",
            mimeType: "image/png",
          },
        ],
        origin: "user",
      },
      {
        id: "steer-2",
        messageId: "message-2",
        text: "Second",
        blocks: [{ kind: "text", text: "Second" }],
        origin: "member",
      },
    ]);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseOwner: "worker-1", leaseFence: 2 }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.steering.claimed",
        payload: { steeringIds: ["steer-1", "steer-2"], nextMessageSeq: 7 },
      }),
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steer-1", "steer-2"] }, claimedAt: null },
      data: { runId: "run-1", claimedAt: expect.any(Date) },
    });
  });

  it("does not claim steering into a tool-free creation intro", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: { findFirst: vi.fn().mockResolvedValue({ id: "intro-run", trigger: "created" }) },
      steeringMessage: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "intro-run",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      }),
    ).resolves.toEqual([]);
    expect(tx.steeringMessage.findMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
  });

  it.each(["routine", "bot_message"])(
    "leaves pending user messages alone while a %s turn is running",
    async (trigger) => {
      const tx = {
        $queryRaw: vi.fn(),
        run: { findFirst: vi.fn().mockResolvedValue({ id: "run-routine", trigger }) },
        steeringMessage: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn(),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        claimSteering(prisma, {
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-routine",
          leaseOwner: "worker-1",
          leaseFence: 1,
          seenIds: [],
        }),
      ).resolves.toEqual([]);
      // Only steering addressed to this run; unassigned (pending) rows wait for the continuation.
      expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: [{ runId: "run-routine" }] }),
        }),
      );
    },
  );

  it.each(["user", "follow_up", "messaging"])(
    "keeps held webhook deliveries out of a %s turn",
    async (trigger) => {
      const tx = {
        $queryRaw: vi.fn(),
        run: {
          findFirst: vi.fn(async () => ({
            id: "run-1",
            trigger,
            sourceMessage: { blocks: [{ kind: "channel_message", channelId: "channel-1" }] },
          })),
        },
        steeringMessage: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
      };
      const prisma = {
        $transaction: async (action: (client: typeof tx) => unknown) => action(tx),
      } as unknown as PrismaClient;
      await claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      });
      expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { runId: null, originTrigger: trigger === "messaging" ? "messaging" : null },
              { runId: "run-1" },
            ],
          }),
        }),
      );
    },
  );

  it("leaves channel and in-app pending rows for a direct-message run", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi.fn().mockResolvedValue({
          id: "run-dm",
          trigger: "messaging",
          sourceMessage: { blocks: [{ kind: "text", text: "And privately?" }] },
        }),
      },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await claimSteering(prisma, {
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-dm",
      leaseOwner: "worker-1",
      leaseFence: 1,
      seenIds: [],
    });

    expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ runId: null, originTrigger: "messaging" }, { runId: "run-dm" }],
          message: {
            threadId: "thread-1",
            NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } },
          },
        }),
      }),
    );
  });

  it("retries a claim whose transaction could not get a connection in time", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const $transaction = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Transaction API error: Unable to start a transaction in the given time."),
      )
      .mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const prisma = { $transaction } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      }),
    ).resolves.toEqual([]);
    expect($transaction).toHaveBeenCalledTimes(2);
  });
});

describe("clearThread", () => {
  it("reports a committed clear even when the legacy binding sweep fails", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      threadRead: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      thread: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 3, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-1", taskId: "task-1", userId: "user-1", spaceId: "workspace-1" },
          ]),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
      artifact: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ ...event(0), type: "thread.cleared" }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      computer: { updateMany: vi.fn().mockRejectedValue(new Error("connection lost")) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(
        prisma,
        { spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" },
        new TestFanout(),
      ),
    ).resolves.toMatchObject({ event: { type: "thread.cleared" }, cancelledRunIds: ["run-1"] });
    expect(prisma.computer.updateMany).toHaveBeenCalled();
  });

  it("releases the computer execution lease without dropping the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      threadRead: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      thread: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 42, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-1", taskId: "task-1", userId: "user-1", spaceId: "workspace-1" },
          ]),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
      artifact: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(prisma, { spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" }, fanout),
    ).resolves.toMatchObject({
      event: { type: "thread.cleared" },
      cancelledRunIds: ["run-1"],
    });
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    // The legacy execution binding is cleared after the transaction commits, so the
    // transaction never reaches for the computer row under the thread-row lock.
    expect(tx.computer.updateMany).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    // Every deleted message counts as compacted, so compaction cannot summarize cleared history.
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: 41,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 0 }));
    // A cleared chat never resumes its run to read a waiting secret answer.
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: { startsWith: "run-login:run-1:" } },
        ],
      },
    });
    // The thread row locks before the runs are cancelled, matching the takeover
    // release order (computer, thread, run), so neither path waits on a row the
    // other holds while reaching for the thread.
    expect(tx.thread.update.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.run.updateManyAndReturn.mock.invocationCallOrder[0]!,
    );
  });

  it("scopes group clear lease cleanup to cancelled run ids", async () => {
    const fanout = new TestFanout();
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      threadRead: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 3, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "group-run-1", taskId: "task-1" },
          { id: "group-run-2", taskId: "task-2" },
        ]),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
      artifact: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      chatGroup: { update: vi.fn() },
    };
    const prisma = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-group",
          botId: "bot-1",
          groupId: "group-1",
        },
        fanout,
      ),
    ).resolves.toMatchObject({ cancelledRunIds: ["group-run-1", "group-run-2"] });

    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-group",
          spaceId: "workspace-1",
        }),
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["group-run-1", "group-run-2"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["group-run-1", "group-run-2"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(tx.computerExecutionLease.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ botId: expect.anything() }) }),
    );
  });
});

describe("appendEvent", () => {
  const inserted = (seq: number, runId: string | null = "run-1") => ({
    id: `event-${seq}`,
    seq,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
    runId,
    firstResponse: false,
  });
  const statementValues = (queryRaw: ReturnType<typeof vi.fn>) =>
    JSON.stringify(queryRaw.mock.calls[0]!.slice(1));

  it("exports only committed run metadata and a coarse error kind, never error text", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const run = {
      userId: "user-1",
      trigger: "user",
      error: '401: {"error":{"message":"Invalid API key for private@example.test"}}',
      createdAt: at,
      startedAt: at,
      completedAt: at,
    };
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(run) },
      $queryRaw: vi.fn().mockResolvedValue([inserted(4)]),
    } as unknown as PrismaClient;
    const analytics = { capture: vi.fn(), flush: async () => undefined };
    const input = {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "run.failed" as const,
      runId: "run-1",
      payload: { error: run.error },
    };
    await appendEvent(prisma, input, undefined, analytics);
    await vi.waitFor(() => expect(analytics.capture).toHaveBeenCalledTimes(1));
    expect(analytics.capture).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      { name: "run_failed", trigger: "user", errorKind: "auth" },
      { id: "run-1", at },
    );
    expect(JSON.stringify(analytics.capture.mock.calls)).not.toContain("private@example.test");
    vi.mocked(prisma.run.findUnique).mockRejectedValueOnce(new Error("db unavailable"));
    await expect(
      appendEvent(prisma, { ...input, payload: {} }, undefined, analytics),
    ).resolves.toEqual(expect.objectContaining({ type: "run.failed", seq: 4 }));
    expect(analytics.capture).toHaveBeenCalledTimes(1);
  });

  it("publishes the committed seq and returns the plaintext payload", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([inserted(7)]),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { delta: "fresh", streaming: true },
        },
        fanout,
      ),
    ).resolves.toMatchObject({
      id: "event-7",
      seq: 7,
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "fresh", streaming: true },
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      "thread:thread-1",
      JSON.stringify({ cursor: 7 }),
    );
  });

  it("publishes nothing when the run can no longer write history", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { text: "stale" },
        },
        fanout,
      ),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports a missing thread as an error when no run is involved", async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;

    await expect(
      appendEvent(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "computer.command",
        payload: { text: "late output" },
      }),
    ).rejects.toThrow("Thread not found");
  });

  it("does not persist a split-emoji high surrogate that would crash JSON insert", async () => {
    const queryRaw = vi.fn().mockResolvedValue([inserted(3, "run-3")]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;

    // Orphaned UTF-16 high surrogate (e.g. 😀 split across stream chunks as \uD83D alone).
    await expect(
      appendEvent(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "thread.progress",
        runId: "run-3",
        payload: { delta: "hello \uD83D", streaming: true },
      }),
    ).resolves.toMatchObject({ payload: { delta: "hello \uFFFD", streaming: true } });
    const values = statementValues(queryRaw);
    expect(values).toContain(
      JSON.stringify(JSON.stringify({ delta: "hello \uFFFD", streaming: true })),
    );
    expect(values).not.toMatch(/\\ud83d/i);
  });

  it("rejects run.cancelled without a run before touching the thread", async () => {
    const queryRaw = vi.fn();
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;

    await expect(
      appendEvent(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "run.cancelled",
        payload: {},
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("held instruction answers", () => {
  function fixture() {
    const request = {
      instructions: "Draft only",
      reason: "Learned preference",
      previousInstructions: "Original",
    };
    const block = {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Update instructions?",
      status: "pending",
      instructionUpdate: {
        botId: "bot-1",
        before: "Original",
        after: "Draft only",
        reason: "Learned preference",
      },
      actions: [
        { id: "allow", label: "Apply" },
        { id: "deny", label: "Dismiss" },
      ],
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findFirst: vi.fn(async () => ({ botId: "bot-1", userId: "owner" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ status: "queued" })),
      },
      message: {
        findFirst: vi.fn(async () => ({ id: "message-1", blocks: [block] })),
        update: vi.fn(async () => ({ id: "message-1" })),
      },
      externalEffect: {
        findFirst: vi.fn(async () => ({
          id: "effect-1",
          kind: "update_bot",
          request,
        })),
        findUniqueOrThrow: vi.fn(async () => ({ request })),
        update: vi.fn(),
      },
      task: { updateMany: vi.fn() },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 10 })) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = { $transaction: async (action: (client: typeof tx) => unknown) => action(tx) };
    const answer = (value: string, userId = "owner") =>
      answerRunInput(
        prisma as never,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: userId,
          answer: value,
        },
        new TestFanout(),
      );
    return { tx, answer };
  }
  it("stores edited text as the approved request without replacing the user's task", async () => {
    const f = fixture();
    expect(await f.answer(JSON.stringify({ instructions: "Never send" }))).toBe(true);
    expect(f.tx.externalEffect.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          request: {
            instructions: "Never send",
            reason: "Learned preference",
            previousInstructions: "Original",
          },
          idempotencyKey: expect.any(String),
        }),
      }),
    );
    expect(f.tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          blocks: [
            expect.objectContaining({
              instructionUpdate: expect.objectContaining({ after: "Never send" }),
              detail: "- Original\n+ Never send",
            }),
          ],
        },
      }),
    );
  });
  it("rejects edits from another user, invalid payloads, and generic always-allow", async () => {
    const f = fixture();
    for (const value of [
      '{"instructions":42}',
      '{"instructions":"new","botId":"other"}',
      JSON.stringify({ instructions: "x".repeat(20001) }),
      "always",
    ])
      expect(await f.answer(value)).toBe(false);
    expect(await f.answer('{"instructions":"new"}', "other-user")).toBe(false);
    expect(f.tx.externalEffect.update).not.toHaveBeenCalled();
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
  });
  it("dismisses the change", async () => {
    const f = fixture();
    expect(await f.answer("deny")).toBe(true);
    expect(f.tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "denied" },
    });
  });
});

describe("discardAnsweredSteering", () => {
  function client(reply: { seq: number } | null, payloads: unknown[] = []) {
    return {
      message: { findFirst: vi.fn().mockResolvedValue(reply) },
      event: { findMany: vi.fn().mockResolvedValue(payloads.map((payload) => ({ payload }))) },
      steeringMessage: { deleteMany: vi.fn() },
    };
  }

  it("requires a text reply and a durable claim watermark", async () => {
    const tx = client(null);
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: expect.arrayContaining([
            { blocks: { array_contains: [{ kind: "ask" }] } },
            { blocks: { array_contains: [{ kind: "steps" }] } },
          ]),
        }),
      }),
    );
    expect(tx.event.findMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
    tx.message.findFirst.mockResolvedValue({ seq: 8 });
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("only discards claims ordered before a reply, including the next sequence", async () => {
    const tx = client({ seq: 8 }, [
      { steeringIds: ["answered"], nextMessageSeq: 8 },
      { steeringIds: ["later"], nextMessageSeq: 9 },
      { steeringIds: ["legacy"] },
      null,
    ]);
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        claimedAt: { not: null },
        id: { in: ["answered"] },
      },
    });
  });
});

it("checks cross-space peer permission inside the message transaction before creating a run", async () => {
  const tx = {
    space: { findUnique: vi.fn() },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 1 })) },
    message: { create: vi.fn(async () => ({ id: "message-1", seq: 0 })) },
    task: { create: vi.fn() },
    run: { create: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(async () => [
      { id: "sender", spaceId: "a", crossSpaceCommunication: true, archivedAt: null },
      { id: "target", spaceId: "b", crossSpaceCommunication: false, archivedAt: null },
    ]),
  };
  const prisma = {
    message: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  await expect(
    sendUserMessage(prisma, {
      spaceId: "b",
      threadId: "thread",
      botId: "target",
      userId: "owner",
      blocks: [{ kind: "text", text: "peer reply" }],
      prompt: "peer reply",
      trigger: "messaging",
      crossSpaceSenderBotId: "sender",
    }),
  ).rejects.toBeInstanceOf(CrossSpaceCommunicationBlockedError);
  expect(tx.task.create).not.toHaveBeenCalled();
  expect(tx.run.create).not.toHaveBeenCalled();
});
