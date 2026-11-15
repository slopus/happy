import { runContinueJob } from "@rakazo/adapter-kit";
import { settleRunSubagents } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome, startBackgroundHelper } from "./background-helpers.js";
import type { RunContext } from "./run-context.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  assertRunCanWriteHistory: vi.fn(async () => undefined),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "card" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

const START = {
  name: "scout",
  task: "compare the venues",
  instructions: "",
  modelProvider: "",
  modelId: "",
  executionId: "call-1",
  effectKey: "effect-1",
};

function harness(overrides: { trigger?: string; threadBotId?: string | null } = {}) {
  const createRun = vi.fn(async (_args: unknown) => ({ id: "helper-run" }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { create: vi.fn(async () => ({ id: "helper-thread" })) },
    task: { create: vi.fn(async () => ({ id: "helper-task" })) },
    run: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: createRun,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: overrides.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot" },
    thread: {
      id: "chat",
      botId: overrides.threadBotId === undefined ? "bot" : overrides.threadBotId,
    },
  } as unknown as RunContext;
  return { ctx, prisma, createRun, enqueue };
}

describe("starting a background helper", () => {
  it("starts one from the owner's own chat and queues its run", async () => {
    const h = harness();
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "helper-thread",
        trigger: "helper",
        sourceMessageId: "card",
        status: "queued",
      }),
      select: { id: true },
    });
    expect(h.createRun.mock.calls[0]?.[0]).not.toHaveProperty("data.modelPinned");
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
    // It takes the chat's lock, which a snapshot read can hold for a while.
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("keeps its card running when the turn that started it ends", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, START);
    const [, input] = vi.mocked(createThreadMessageInTransaction).mock.lastCall!;
    const [, event] = vi.mocked(appendEventInTransaction).mock.lastCall!;
    // The turn's run.completed settles that turn's helper cards on every live client.
    const card = { id: "card", runId: input.runId, blocks: input.blocks };
    expect(settleRunSubagents([card], h.ctx.runId)).toEqual([card]);
    expect(event.runId).toBeUndefined();
  });

  it.each([
    ["a group or connected team chat", { threadBotId: null }],
    ["a linked Telegram or SMS chat", { trigger: "messaging" }],
    ["a routine", { trigger: "routine" }],
    ["another bot's request", { trigger: "bot_message" }],
    ["a helper's result coming back", { trigger: "helper_result" }],
  ])("refuses to start one from %s", async (_label, overrides) => {
    const h = harness(overrides);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("only from the user's own app chat"),
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pins the model it was asked for, and needs both halves of it", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, { ...START, modelProvider: "openai", modelId: "gpt-x" });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "openai",
        modelId: "gpt-x",
        modelPinned: true,
      }),
      select: { id: true },
    });
    const half = harness();
    await expect(
      startBackgroundHelper(half.ctx, { ...START, modelProvider: "openai" }),
    ).resolves.toEqual({ error: "model_provider and model_id must both be set" });
    expect(half.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("returning a helper's outcome", () => {
  it("waits for the chat's lock with the thread-lock budget", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const run = { id: "helper-run", spaceId: "space", botId: "bot", userId: "user" };
    await returnHelperOutcome(
      { prisma, events: { notify: vi.fn() } } as never,
      { ...run, sourceMessageId: "card" },
      { status: "completed", text: "done" },
    );
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });
});

describe("passing a helper's result back in a shared space", () => {
  // The bot was made by "creator"; "member" shares the space and started the helper.
  function shared(overrides: { member?: boolean; archived?: boolean } = {}) {
    const createRun = vi.fn(async (_args: unknown) => ({ id: "wake" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { updateMany: vi.fn(async () => ({ count: 1 })), create: createRun },
      message: {
        findFirst: vi.fn(async () => ({
          id: "card",
          threadId: "chat",
          blocks: [
            { kind: "subagent", agentId: "call-1", name: "scout", task: "t", status: "running" },
          ],
        })),
        update: vi.fn(async () => ({})),
      },
      spaceMember: {
        findUnique: vi.fn(async () => (overrides.member === false ? null : { id: "membership" })),
      },
      bot: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          overrides.archived ||
          (where.userId !== undefined && where.userId !== "creator") ||
          where.archivedAt !== null
            ? null
            : { id: "bot" },
        ),
      },
      task: { create: vi.fn(async () => ({ id: "wake-task" })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const enqueue = vi.fn(async () => undefined);
    const run = {
      id: "helper-run",
      spaceId: "space",
      botId: "bot",
      userId: "member",
      sourceMessageId: "card",
    };
    const returned = returnHelperOutcome(
      { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } } as never,
      run,
      { status: "completed", text: "found three venues" },
    );
    return { returned, createRun, enqueue };
  }

  it("brings it back for a member who did not make the bot, as their own turn", async () => {
    const h = shared();
    await h.returned;
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "chat",
        userId: "member",
        trigger: "helper_result",
        clientNonce: "helper-result:helper-run",
      }),
      select: { id: true },
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("wake"));
  });

  it.each([
    ["the member has left the space", { member: false }],
    ["the bot is archived", { archived: true }],
  ])("only settles the card when %s", async (_label, overrides) => {
    const h = shared(overrides);
    await h.returned;
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
