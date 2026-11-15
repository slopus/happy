import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { callClientNonce } from "@rakazo/core";
import type * as MessageQuoteModule from "@rakazo/core/message-quote";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reactToThreadMessage } from "./thread-reactions.js";
import { threadSnapshot } from "./thread-snapshot.js";
import { stopThreadRuns } from "./thread-stop.js";
import type { ThreadTarget } from "./thread-target.js";
import {
  cancelSupersededQueuedRuns,
  latestWaitingRun,
  replyParentBotId,
  sendTargetBotIds,
  sendThreadMessage,
  threadHead,
} from "./thread-target.js";

// Passthrough mock: every hint derives for real except the sentinel that
// exercises the "derivation must never cost the send" path.
vi.mock("@rakazo/core/message-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageQuoteModule>();
  return {
    ...actual,
    deriveMessageQuote: (
      blocks: MessageBlock[],
      hint: string,
      format: "markdown" | "plain-text",
    ) => {
      if (hint === "explode derivation") throw new Error("derivation blew up");
      return actual.deriveMessageQuote(blocks, hint, format);
    },
  };
});

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-old", taskId: "task-old" }])
          .mockResolvedValueOnce([{ id: "run-old", userId: "user-1", spaceId: "space-1" }]),
        updateMany: vi.fn(),
      },
      message: { findMany: vi.fn(async () => []) },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-old"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
    // A superseded run may hold an answered one-time value that it will now never read.
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "space-1", kind: "run-secret:run-old" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code:run-old" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code-spent:run-old" },
          { userId: "user-1", spaceId: "space-1", kind: { startsWith: "run-login:run-old:" } },
        ],
      },
    });
  });
});

describe("reaction messages", () => {
  it("appends repeated reactions as quiet replies and deduplicates retries", async () => {
    const messages = new Map<string, { id: string }>();
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: "parent" }),
        findUnique: vi.fn(
          async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
            messages.get(where.threadId_clientNonce.clientNonce) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: { clientNonce: string } }) => {
          const message = { id: `reaction-${messages.size}`, ...data };
          messages.set(data.clientNonce, message);
          return message;
        }),
      },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `event-${eventSeq}`,
          createdAt: new Date(),
          ...data,
        })),
      },
      task: { create: vi.fn() },
      run: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn() };
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;
    for (const [clientNonce, reaction] of [
      ["first", "❤️"],
      ["second", "👍"],
      ["third", "❤️"],
      ["third", "❤️"],
    ] as const) {
      await reactToThreadMessage({ prisma, jobs: jobs as never }, actor, target, {
        messageId: "parent",
        reaction,
        clientNonce,
        mayStartTurn: true,
      });
    }
    expect(tx.message.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.message.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "parent",
        clientNonce: "third",
      }),
    });
    expect(tx.event.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: {
          messageId: "reaction-2",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "parent",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true, seq: true, role: true, botId: true, runId: true },
    });
    tx.message.findFirst.mockResolvedValueOnce(null);
    await expect(
      reactToThreadMessage({ prisma, jobs: jobs as never }, actor, target, {
        messageId: "elsewhere",
        reaction: "❤️",
        clientNonce: "fourth",
        mayStartTurn: true,
      }),
    ).rejects.toThrow();
    expect(tx.message.create).toHaveBeenCalledTimes(3);
  });
});

describe("reaction turns", () => {
  const ask = {
    id: "parent",
    blocks: [{ kind: "ask", text: "Shall I book it?", status: "pending" }],
  };

  function fixture(options: {
    reaction?: "👍" | "👎" | "❤️";
    parent?: { role: string; botId: string | null; runId: string | null };
    newer?: Array<{
      role: string;
      blocks: MessageBlock[];
      replyToMessageId: string | null;
    }>;
    activeRuns?: Array<{
      id: string;
      taskId: string;
      status: string;
      userId?: string;
    }>;
    mayStartTurn?: boolean;
    recentReaction?: boolean;
    groupMembers?: string[];
    askBlocks?: MessageBlock[];
    withoutRelease?: boolean;
  }) {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      steeringMessage: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 9 } : { nextEventSeq: 4 },
        ),
      },
      message: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: "parent",
            seq: 7,
            ...(options.parent ?? { role: "bot", botId: "bot-1", runId: "run-done" }),
          })
          .mockImplementation(async ({ where }: { where: { id?: string } }) => ({
            ...(!where.id && options.newer?.length ? { id: "intervening-reaction" } : ask),
            blocks: options.askBlocks ?? ask.blocks,
            threadId: "thread-1",
            runId: "run-waiting",
            role: "bot",
          })),
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi
          .fn()
          .mockResolvedValueOnce(options.newer ?? [])
          .mockResolvedValue([{ ...ask, blocks: options.askBlocks ?? ask.blocks }]),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "reaction-1",
          ...data,
        })),
        update: vi.fn(),
      },
      chatGroup: {
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          members: (options.groupMembers ?? []).map((id) => ({
            bot: { id, name: id, color: null },
          })),
        }),
      },
      run: {
        findMany: vi.fn(async ({ where }: { where: { status?: string } }) =>
          where.status === "queued" ? [] : (options.activeRuns ?? []),
        ),
        findFirst: vi.fn(async (args?: { where?: { trigger?: string } }) =>
          args?.where?.trigger === "reaction"
            ? options.recentReaction
              ? { id: "recent" }
              : null
            : { botId: "bot-1", userId: "user-1" },
        ),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({
          id: "run-new",
          taskId: "task-new",
          status: "queued",
          userId: "user-1",
        }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-new" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          seq: 4,
          threadId: "thread-1",
          ...data,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const releaseTakeover = vi.fn().mockResolvedValue(undefined);
    const react = () =>
      reactToThreadMessage(
        { prisma, jobs: { enqueue } as never },
        { spaceId: "space-1", userId: "user-1" } as Actor,
        (options.groupMembers
          ? {
              kind: "group",
              groupId: "group-1",
              memberBotIds: ["bot-1", "bot-2"],
              threadId: "thread-1",
            }
          : { kind: "bot", botId: "bot-1", threadId: "thread-1" }) as ThreadTarget,
        {
          messageId: "parent",
          reaction: options.reaction ?? "👍",
          clientNonce: "nonce-1",
          mayStartTurn: options.mayStartTurn ?? true,
        },
        options.withoutRelease ? undefined : releaseTakeover,
      );
    return { tx, prisma, enqueue, react, releaseTakeover };
  }

  it("treats a thumbs up on a pending takeover as done and hands control back", async () => {
    const { tx, prisma, enqueue, react, releaseTakeover } = fixture({
      parent: { role: "bot", botId: "bot-1", runId: "run-takeover" },
      activeRuns: [
        {
          id: "run-takeover",
          taskId: "task-1",
          status: "waiting_takeover",
          userId: "user-1",
        },
      ],
    });
    await expect(react()).resolves.toEqual({ eventSeq: 3, runIds: ["run-takeover"] });
    // The reaction holds the thread row lock like a send; it runs on the same budget.
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "reaction-1", botId: "bot-1", userId: "user-1", runId: "run-takeover" },
    });
    expect(releaseTakeover).toHaveBeenCalledWith("run-takeover");
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("leaves a pending takeover alone when control cannot be handed back", async () => {
    const { tx, enqueue, react } = fixture({
      withoutRelease: true,
      parent: { role: "bot", botId: "bot-1", runId: "run-takeover" },
      activeRuns: [
        {
          id: "run-takeover",
          taskId: "task-1",
          status: "waiting_takeover",
          userId: "user-1",
        },
      ],
    });
    await react();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("retries the takeover handoff when the same reaction is replayed", async () => {
    const { tx, react, releaseTakeover } = fixture({});
    tx.message.findUnique.mockResolvedValueOnce({ id: "reaction-1" });
    tx.steeringMessage.findFirst.mockResolvedValueOnce({
      run: {
        id: "run-takeover",
        taskId: "task-1",
        status: "waiting_takeover",
        userId: "user-1",
      },
    });
    await expect(react()).resolves.toEqual({ eventSeq: null, runIds: ["run-takeover"] });
    expect(releaseTakeover).toHaveBeenCalledWith("run-takeover");
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it.each(["👎", "❤️"] as const)("leaves a pending takeover alone on %s", async (reaction) => {
    const { tx, enqueue, react, releaseTakeover } = fixture({
      reaction,
      parent: { role: "bot", botId: "bot-1", runId: "run-takeover" },
      activeRuns: [
        {
          id: "run-takeover",
          taskId: "task-1",
          status: "waiting_takeover",
          userId: "user-1",
        },
      ],
    });
    await react();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(releaseTakeover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("starts the bot's turn when its latest message gets a thumbs up", async () => {
    const { tx, enqueue, react } = fixture({
      newer: [
        {
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "parent",
        },
      ],
    });
    await expect(react()).resolves.toEqual({ eventSeq: 3, runIds: ["run-new"] });
    expect(tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-1", prompt: "👍", status: "queued" }),
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "reaction",
        sourceMessageId: "reaction-1",
        status: "queued",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-new",
        payload: expect.objectContaining({ runIds: ["run-new"] }),
      }),
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("lets other emoji wake an idle bot", async () => {
    const { tx, react } = fixture({ reaction: "❤️" });
    await react();
    expect(tx.run.create).toHaveBeenCalledOnce();
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: "reaction",
          status: { not: "cancelled" },
          createdAt: { gte: expect.any(Date) },
        }),
      }),
    );
  });

  it("checks a 30-second cooldown for this bot and thread", async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { tx, react } = fixture({ recentReaction: true });
      await expect(react()).resolves.toEqual({ eventSeq: 3, runIds: [] });
      expect(tx.run.findFirst).toHaveBeenCalledWith({
        where: {
          threadId: "thread-1",
          botId: "bot-1",
          trigger: "reaction",
          status: { not: "cancelled" },
          createdAt: { gte: new Date(now - 30_000) },
        },
        select: { id: true },
      });
      expect(tx.message.create).toHaveBeenCalledOnce();
      expect(tx.run.create).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    {
      kind: "ask" as const,
      text: "Approve?",
      status: "pending" as const,
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    },
    { kind: "ask" as const, text: "Secret?", status: "pending" as const, input: "secret" as const },
  ])("leaves protected asks on their cards", async (askBlock) => {
    const { tx, enqueue, react } = fixture({
      parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
      activeRuns: [
        {
          id: "run-waiting",
          taskId: "task-1",
          status: "waiting_input",
          userId: "user-1",
        },
      ],
      askBlocks: [askBlock],
    });
    await react();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails quiet when the newer-message scan is capped", async () => {
    const newer = Array.from({ length: 50 }, () => ({
      role: "user",
      blocks: [{ kind: "text" as const, text: "❤️" }],
      replyToMessageId: "parent",
    }));
    const { tx, react } = fixture({
      newer: [...newer, { role: "bot", blocks: [], replyToMessageId: null }],
    });
    await react();
    expect(tx.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it.each([
    ["👍", "yes"],
    ["👎", "no"],
  ] as const)("resolves %s to an offered Yes/No choice", async (reaction, label) => {
    const { tx, react } = fixture({
      reaction,
      parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
      activeRuns: [
        {
          id: "run-waiting",
          taskId: "task-1",
          status: "waiting_input",
          userId: "user-1",
        },
      ],
      askBlocks: [
        {
          kind: "ask",
          text: "Proceed?",
          status: "pending",
          actions: [
            { id: "accept", label: "Yes" },
            { id: "reject", label: "No" },
          ],
        },
      ],
    });
    await react();
    expect(tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { prompt: `Selected choice ${label === "yes" ? "accept: Yes" : "reject: No"}` },
      }),
    );
  });

  it("answers the bot's pending ask with a thumbs down", async () => {
    const { tx, enqueue, react } = fixture({
      reaction: "👎",
      parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
      activeRuns: [
        {
          id: "run-waiting",
          taskId: "task-1",
          status: "waiting_input",
          userId: "user-1",
        },
      ],
    });
    await react();
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-waiting" } } },
      data: { prompt: "no" },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it.each(["👍", "👎"] as const)(
    "answers its explicit question with %s after another reaction",
    async (reaction) => {
      const { tx, react, enqueue } = fixture({
        reaction,
        parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
        activeRuns: [
          {
            id: "run-waiting",
            taskId: "task-1",
            status: "waiting_input",
            userId: "user-1",
          },
        ],
        newer: [
          { role: "user", blocks: [{ kind: "text", text: "❤️" }], replyToMessageId: "parent" },
        ],
      });
      await expect(react()).resolves.toMatchObject({ runIds: ["run-waiting"] });
      expect(tx.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "parent" },
          data: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                kind: "ask",
                status: "answered",
                answer: reaction === "👍" ? "yes" : "no",
              }),
            ]),
          }),
        }),
      );
      expect(enqueue).toHaveBeenCalled();
    },
  );

  it("answers a pending ask even inside the reaction cooldown", async () => {
    const { tx, enqueue, react } = fixture({
      reaction: "👍",
      recentReaction: true,
      parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
      activeRuns: [
        {
          id: "run-waiting",
          taskId: "task-1",
          status: "waiting_input",
          userId: "user-1",
        },
      ],
    });
    await react();
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-waiting" } } },
      data: { prompt: "yes" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it.each([
    ["a recent reaction turn", { recentReaction: true }],
    ["a departed group bot", { groupMembers: ["bot-2", "bot-3"] }],
    [
      "a non-thumb on a pending ask",
      {
        reaction: "❤️" as const,
        parent: { role: "bot", botId: "bot-1", runId: "run-waiting" },
        activeRuns: [
          {
            id: "run-waiting",
            taskId: "task-1",
            status: "waiting_input",
            userId: "user-1",
          },
        ],
      },
    ],
    ["an older message", { newer: [{ role: "bot", blocks: [], replyToMessageId: null }] }],
    ["the user's own message", { parent: { role: "user", botId: null, runId: null } }],
    [
      "a busy bot",
      {
        activeRuns: [
          {
            id: "run-busy",
            taskId: "task-busy",
            status: "running",
            userId: "user-1",
          },
        ],
      },
    ],
    [
      "another run's ask",
      {
        activeRuns: [
          {
            id: "run-waiting",
            taskId: "task-1",
            status: "waiting_input",
            userId: "user-1",
          },
        ],
      },
    ],
    ["a thread that cannot start a run", { mayStartTurn: false }],
  ])("handles reaction admission for %s", async (_case, options) => {
    const { tx, enqueue, react } = fixture(options);
    await react();
    expect(tx.message.create).toHaveBeenCalledOnce();
    const startsWork = _case === "a non-thumb on a pending ask" || _case === "another run's ask";
    expect(tx.run.create).toHaveBeenCalledTimes(startsWork ? 1 : 0);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(startsWork ? 1 : 0);
  });
});

describe("threadSnapshot", () => {
  it("returns all private pending runs alongside new work and its live progress", async () => {
    const runs = [
      { id: "paused-a", status: "waiting_input" },
      { id: "paused-b", status: "waiting_input" },
      { id: "new-work", status: "running" },
    ].map((run) => ({
      ...run,
      botId: "bot-1",
      threadId: "thread-1",
      taskId: `task-${run.id}`,
      trigger: "user",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      startedAt: null,
      completedAt: null,
    }));
    const findManyEvents = vi.fn().mockResolvedValue([]);
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findFirst: vi.fn().mockResolvedValue({ seq: 8 }), findMany: findManyEvents },
      run: { findFirst: botRunFindFirst(runs), findMany: groupRunFindMany({ active: runs }) },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    } as unknown as PrismaClient;
    const snapshot = await threadSnapshot({ prisma }, {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget);
    expect(snapshot.run).toMatchObject({ id: "new-work", status: "running" });
    expect(snapshot.activeRuns?.map((run) => run.id)).toEqual(["paused-a", "paused-b", "new-work"]);
    expect(findManyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runId: { in: ["paused-a", "paused-b", "new-work"] } }),
      }),
    );
  });

  it.each(["user", "bot_message"])(
    "reloads live messages only for an active user run (%s)",
    async (trigger) => {
      const run = {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        status: "running",
        trigger,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
      };
      const findManyEvents = vi.fn().mockResolvedValue([
        {
          id: "event-1",
          threadId: "thread-1",
          botId: "bot-1",
          seq: 4,
          type: "agent.tool.called",
          runId: "run-1",
          payload: { name: "SLACK_FIND_CHANNELS" },
          createdAt: new Date("2026-08-23T00:00:00.000Z"),
        },
      ]);
      const tx = {
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: { findMany: vi.fn().mockResolvedValue([]) },
        event: {
          findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
          findMany: findManyEvents,
        },
        run: {
          findFirst: botRunFindFirst([run]),
          findMany: groupRunFindMany({
            active: [run].filter((r) => r.status !== "failed" && r.status !== "completed"),
          }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;

      const snapshot = await threadSnapshot({ prisma }, target);

      expect(tx.$queryRaw).toHaveBeenCalledOnce();
      if (trigger === "bot_message") {
        expect(snapshot.run).toMatchObject({ id: run.id, status: "running" });
        expect(snapshot.activeRuns).toEqual([expect.objectContaining({ id: run.id })]);
        expect(snapshot.messages).toEqual([]);
        expect(findManyEvents).not.toHaveBeenCalled();
        return;
      }
      expect(findManyEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: {
              in: [
                "thread.progress",
                "thread.subagent",
                "run.waiting_input",
                "computer.takeover.requested",
                "agent.tool.called",
                "agent.tool.completed",
              ],
            },
          }),
        }),
      );
      expect(snapshot.messages).toEqual([
        expect.objectContaining({
          id: "progress:run-1",
          botId: "bot-1",
          blocks: [
            {
              kind: "steps",
              steps: [{ label: "Slack find channels", count: 1 }],
            },
          ],
        }),
      ]);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 15_000,
        maxWait: 5_000,
      });
    },
  );

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([run]);
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          trigger: { notIn: ["tickets"] },
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it.each([
    { status: "waiting_input", trigger: "user" },
    { status: "waiting_input", trigger: "bot_message" },
    { status: "queued", trigger: "bot_message" },
  ])("prefers running $trigger work over newer $status work", async ({ status, trigger }) => {
    const waitingPeer = {
      id: "run-peer-waiting",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status,
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const olderUser = {
      id: "run-user",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-user",
      status: "running",
      trigger,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: {
          $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
            callback({
              spaceMember: { count: vi.fn().mockResolvedValue(1) },
              $executeRaw: vi.fn(async () => 0),
              $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
              message: { findMany: vi.fn().mockResolvedValue([]) },
              event: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
              },
              run: {
                findFirst: botRunFindFirst([waitingPeer, olderUser]),
                findMany: groupRunFindMany({ active: [waitingPeer, olderUser] }),
              },
            }),
          ),
        } as unknown as PrismaClient,
      },
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-user", status: "running" }));
  });

  it.each(["waiting_input", "running"])(
    "only exposes ticket runs waiting for input (%s)",
    async (status) => {
      const waitingTicket = {
        id: "run-ticket-waiting",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-ticket",
        status,
        trigger: "tickets",
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: new Date("2026-08-23T00:00:02.000Z"),
        completedAt: null,
        createdAt: new Date("2026-08-23T00:00:02.000Z"),
      };
      const snapshot = await threadSnapshot(
        {
          prisma: {
            $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
              callback({
                spaceMember: { count: vi.fn().mockResolvedValue(1) },
                $executeRaw: vi.fn(async () => 0),
                $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
                message: { findMany: vi.fn().mockResolvedValue([]) },
                event: {
                  findFirst: vi.fn().mockResolvedValue(null),
                  findMany: vi.fn().mockResolvedValue([]),
                },
                run: {
                  findFirst: botRunFindFirst([waitingTicket]),
                  findMany: groupRunFindMany({ active: [waitingTicket] }),
                },
              }),
            ),
          } as unknown as PrismaClient,
        },
        {
          kind: "bot",
          botId: "bot-1",
          threadId: "thread-1",
          bot: { computer: null },
        } as ThreadTarget,
      );

      if (status === "waiting_input") {
        expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-ticket-waiting", status }));
      } else {
        expect(snapshot.run).toBeNull();
      }
    },
  );

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:03.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const findFirstRun = botRunFindFirst([failed, completed]);
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { notIn: ["tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([]);
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun, findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
    expect(findManyEvents).not.toHaveBeenCalled();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const prisma = groupPrisma(findManyRuns);
    const snapshot = await threadSnapshot({ prisma }, groupTarget());

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          trigger: { notIn: ["bot_message", "tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          OR: [
            { trigger: { notIn: ["bot_message", "tickets"] } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
      maxWait: 5_000,
    });
  });

  it("omits peer bot_message runs from group activeRuns and displayed terminal run", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.run).toBeNull();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { trigger: { notIn: ["bot_message", "tickets"] } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { notIn: ["bot_message", "tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("includes waiting peer bot_message runs in group activeRuns", async () => {
    const peerWaiting = {
      id: "run-peer-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [peerWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    ]);
  });

  it.each([
    ["queued", "waiting_input"],
    ["leased", "waiting_input"],
    ["running", "waiting_input"],
    ["queued", "waiting_takeover"],
    ["leased", "waiting_takeover"],
    ["running", "waiting_takeover"],
  ])("keeps group %s work behind a %s headline", async (status, waitingStatus) => {
    // Real DB order is createdAt desc, so the newer busy run for bot-b comes
    // first here, ahead of the older waiting peer run for bot-a.
    const newerBusy = {
      id: "run-newer-busy",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-busy",
      status,
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:10.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:10.000Z"),
    };
    const olderWaiting = {
      id: "run-older-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: waitingStatus,
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [newerBusy, olderWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-older-waiting" }));
    // activeRuns is unaffected by which one is chosen as primary.
    expect(snapshot.activeRuns?.map((run) => run.id)).toEqual([
      "run-newer-busy",
      "run-older-waiting",
    ]);
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: { status?: { in?: string[] } } | undefined) {
  const statuses = where?.status?.in;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

type TriggerFilter = { not?: string; notIn?: string[] };

function matchesTriggerFilter(trigger: string | undefined, filter: TriggerFilter | undefined) {
  if (!filter) return true;
  if (filter.not !== undefined && trigger === filter.not) return false;
  if (filter.notIn !== undefined && trigger !== undefined && filter.notIn.includes(trigger)) {
    return false;
  }
  return true;
}

function matchesPeerActiveFilter(
  row: { trigger?: string; status?: string },
  where:
    | {
        trigger?: TriggerFilter;
        OR?: Array<{ trigger?: TriggerFilter; status?: { in?: string[] } }>;
      }
    | undefined,
) {
  if (where?.trigger) return matchesTriggerFilter(row.trigger, where.trigger);
  if (!where?.OR) return true;
  return where.OR.some((clause) => {
    if (!matchesTriggerFilter(row.trigger, clause.trigger)) return false;
    if (clause.status?.in) return clause.status.in.includes(row.status ?? "");
    return true;
  });
}

function botRunFindFirst(
  rows: Array<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: Date;
  }>,
) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: TriggerFilter;
      };
      select?: { id?: boolean };
    }) => {
      const statuses = args.where?.status?.in;
      const matched = rows
        .filter((row) => !statuses || statuses.includes(row.status))
        .filter((row) => matchesTriggerFilter(row.trigger, args.where?.trigger))
        .sort((a, b) => {
          const byCreated = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
        });
      const row = matched[0] ?? null;
      if (!row) return null;
      return args.select?.id ? { id: row.id } : row;
    },
  );
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: { not?: string };
        OR?: Array<{ trigger?: { not?: string }; status?: { in?: string[] } }>;
      };
    }) => {
      const rows = isTerminalRunQuery(args.where) ? (input.terminals ?? []) : (input.active ?? []);
      return rows.filter((row) =>
        matchesPeerActiveFilter(row as { trigger?: string; status?: string }, args.where),
      );
    },
  );
}

function groupPrisma(findManyRuns: ReturnType<typeof groupRunFindMany>) {
  const tx = {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    spaceMember: { count: vi.fn().mockResolvedValue(1) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("sendThreadMessage", () => {
  it.each(["latest", "reply", "unrelated-reply"] as const)(
    "answers a waiting question through the composer (explicit older reply: %s)",
    async (scenario) => {
      const olderReply = scenario === "reply";
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "Paris" }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date("2026-01-01T00:00:00Z"),
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "ask-1",
              blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
            },
          ]),
          findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => ({
            id: olderReply && !where.id ? "newer-message" : "ask-1",
            role: "bot",
            botId: "bot-1",
            blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
          })),
          update: vi.fn(),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "run-waiting",
              taskId: "task-1",
              status: "waiting_input",
              userId: "user-1",
              trigger: "user",
            },
          ]),
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
        task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const analytics = { capture: vi.fn(), flush: async () => undefined };

      await expect(
        sendThreadMessage(
          {
            prisma,
            sandbox: {} as never,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
            jobs: { enqueue } as never,
            analytics,
          },
          actor,
          target,
          {
            text: "Paris",
            clientNonce: "nonce-ask",
            ...(scenario === "latest"
              ? {}
              : { replyToMessageId: olderReply ? "ask-1" : "unrelated-message" }),
          },
        ),
      ).resolves.toMatchObject({
        runId: "run-waiting",
        taskId: "task-1",
        seq: 1,
        runIds: ["run-waiting"],
      });
      // Snapshot reads can hold the thread row lock for up to 15s; the send must wait
      // that out on the explicit budget instead of expiring at the default.
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 20_000,
      });
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-waiting" } } },
        data: { prompt: "Paris" },
      });
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "waiting_input" }),
          data: { status: "queued" },
        }),
      );
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "ask-1" },
        data: { blocks: [expect.objectContaining({ answer: "Paris", answerMessageId: "msg-1" })] },
      });
      if (olderReply) {
        expect(tx.message.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "ask-1", threadId: "thread-1", runId: "run-waiting", role: "bot" },
          }),
        );
        expect(tx.message.findFirst).not.toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: { seq: "desc" } }),
        );
      }
      expect(tx.steeringMessage.create).not.toHaveBeenCalled();
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
      // The composer send is the main way users talk to a bot; it must count as a message.
      expect(analytics.capture).toHaveBeenCalledExactlyOnceWith(
        "user-1",
        { name: "message_sent", trigger: "user" },
        { id: "msg-1", at: new Date("2026-01-01T00:00:00Z") },
      );
      expect(JSON.stringify(analytics.capture.mock.calls)).not.toContain("Paris");
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({ runIds: ["run-waiting"] }),
        }),
      });
    },
  );

  async function verifyMultiplePrivateQuestionReplies(explicitReply: boolean) {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi
          .fn()
          .mockImplementation(async ({ where }: { where: { runId: string } }) => [
            where.runId === "run-waiting-1" ? waitingAsk : { ...waitingAsk, id: "ask-older" },
          ]),
        findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
          explicitReply && where.id === "ask-older"
            ? {
                ...waitingAsk,
                id: "ask-older",
                role: "bot",
                botId: "bot-1",
                runId: "run-waiting-2",
              }
            : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-waiting-1",
            taskId: "task-1",
            status: "waiting_input",
            userId: "user-1",
          },
          {
            id: "run-waiting-2",
            taskId: "task-2",
            status: "waiting_input",
            userId: "user-1",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          status: where.id === "run-waiting-2" && !explicitReply ? "cancelled" : "queued",
        })),
      },
      attempt: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-multi",
          ...(explicitReply ? { replyToMessageId: "ask-older" } : {}),
        },
      ),
    ).resolves.toMatchObject({
      runId: explicitReply ? "run-waiting-2" : "run-waiting-1",
      taskId: explicitReply ? "task-2" : "task-1",
      seq: 1,
      runIds: [explicitReply ? "run-waiting-2" : "run-waiting-1"],
    });
    if (explicitReply) {
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "run-waiting-2" }),
          data: { status: "queued" },
        }),
      );
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "ask-older" },
        data: {
          blocks: [
            expect.objectContaining({
              status: "answered",
              answer: "Paris",
              answerMessageId: "msg-1",
            }),
          ],
        },
      });
      expect(tx.message.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ask-1" } }),
      );
      expect(tx.secret.deleteMany).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
      );
      return;
    }
    expect(tx.run.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "run-waiting-2", status: "waiting_input" }),
      data: expect.objectContaining({ status: "cancelled" }),
    });
    // The retired run never resumes to read a waiting secret answer.
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-waiting-2" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-waiting-2" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-waiting-2" },
          {
            userId: "user-1",
            spaceId: "workspace-1",
            kind: { startsWith: "run-login:run-waiting-2:" },
          },
        ],
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-older" },
      data: { blocks: [expect.objectContaining({ status: "answered", answer: "Paris" })] },
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ runIds: ["run-waiting-1"] }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
  }

  it.each([false, true])(
    "handles multiple private questions (explicit older reply: %s)",
    verifyMultiplePrivateQuestionReplies,
  );

  it("replays every answered waiting run from a free-text send receipt", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "msg-1",
          seq: 4,
          runId: "run-waiting-1",
          sourceRuns: [],
        }),
      },
      event: {
        findFirst: vi.fn(async ({ select }: { select?: { seq?: boolean } }) =>
          select?.seq
            ? { seq: 9 }
            : {
                payload: {
                  messageId: "msg-1",
                  role: "user",
                  runIds: ["run-waiting-1", "run-waiting-2"],
                },
              },
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-waiting-1",
            taskId: "task-1",
            status: "queued",
            userId: "user-1",
          },
          {
            id: "run-waiting-2",
            taskId: "task-2",
            status: "queued",
            userId: "user-1",
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: "run-waiting-1",
          taskId: "task-1",
          status: "queued",
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const analytics = { capture: vi.fn(), flush: async () => undefined };

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
          analytics,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-replay",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting-1",
      taskId: "task-1",
      seq: 4,
      runIds: ["run-waiting-1", "run-waiting-2"],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // The original send already counted this message.
    expect(analytics.capture).not.toHaveBeenCalled();
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-waiting-1", "run-waiting-2"] } },
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
    );
  });

  async function verifyMultipleGroupQuestionReplies(explicitReply: boolean) {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi
          .fn()
          .mockImplementation(async ({ where }: { where: { runId: string } }) => [
            where.runId === "run-waiting-1" ? waitingAsk : { ...waitingAsk, id: "ask-older" },
          ]),
        findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
          explicitReply && where.id === "ask-older"
            ? {
                ...waitingAsk,
                id: "ask-older",
                role: "bot",
                botId: "bot-a",
                runId: "run-waiting-2",
              }
            : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-waiting-1",
            taskId: "task-1",
            botId: "bot-a",
            status: "waiting_input",
            userId: "user-1",
          },
          {
            id: "run-waiting-2",
            taskId: "task-2",
            botId: "bot-a",
            status: "waiting_input",
            userId: "user-1",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          status: where.id === "run-waiting-2" && !explicitReply ? "cancelled" : "queued",
        })),
        create: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          mentions: ["bot-a"],
          clientNonce: "nonce-ask-group-multi",
          ...(explicitReply ? { replyToMessageId: "ask-older" } : {}),
        },
      ),
    ).resolves.toMatchObject({
      runId: explicitReply ? "run-waiting-2" : "run-waiting-1",
      taskId: explicitReply ? "task-2" : "task-1",
      seq: 1,
      runIds: [explicitReply ? "run-waiting-2" : "run-waiting-1"],
    });
    if (explicitReply) {
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "run-waiting-2" }),
          data: { status: "queued" },
        }),
      );
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "ask-older" },
        data: {
          blocks: [
            expect.objectContaining({
              status: "answered",
              answer: "Paris",
              answerMessageId: "msg-1",
            }),
          ],
        },
      });
      expect(tx.message.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ask-1" } }),
      );
      expect(tx.secret.deleteMany).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
      );
      return;
    }
    expect(tx.run.updateMany).toHaveBeenCalledTimes(3);
    // The person answered the member's question, so its reply is required.
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-waiting-1"] } },
      data: { groupReplyOptional: false },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "run-waiting-2", status: "waiting_input" }),
      data: expect.objectContaining({ status: "cancelled" }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-older" },
      data: { blocks: [expect.objectContaining({ status: "answered", answer: "Paris" })] },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ runIds: ["run-waiting-1"] }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
  }

  it.each([false, true])(
    "handles multiple group questions (explicit older reply: %s)",
    verifyMultipleGroupQuestionReplies,
  );

  it.each(["bot", "group"] as const)(
    "%s sends preserve approvals and retire older questions before starting new work",
    async (kind) => {
      for (const approval of [false, true]) {
        const ask = {
          id: "ask-old",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              ...(approval
                ? {
                    approvalEffectId: "effect-1",
                    actions: [
                      { id: "allow", label: "Allow once" },
                      { id: "deny", label: "Deny" },
                    ],
                  }
                : {}),
            },
          ],
        };
        const tx = {
          space: { findUnique: vi.fn(async () => null) },
          externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
          user: { findMany: vi.fn().mockResolvedValue([]) },
          spaceMember: { count: vi.fn().mockResolvedValue(1) },
          $executeRaw: vi.fn(async () => 0),
          $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
          thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 4, nextEventSeq: 5 }) },
          message: {
            create: vi.fn().mockResolvedValue({ id: "msg-new", seq: 3 }),
            findMany: vi.fn().mockResolvedValue([ask]),
            findFirst: vi.fn().mockResolvedValue({ id: approval ? "ask-old" : "newer-message" }),
            update: vi.fn(),
          },
          run: {
            findFirst: vi.fn().mockResolvedValue({ taskId: "task-old" }),
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
              status: where.id === "run-waiting" ? "cancelled" : "queued",
            })),
            findMany: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: "run-waiting",
                  taskId: "task-old",
                  botId: "bot-a",
                  status: "waiting_input",
                  userId: "user-1",
                },
              ])
              .mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({
              id: "run-new",
              taskId: "task-new",
              botId: "bot-a",
              status: "queued",
              userId: "user-1",
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          attempt: { updateMany: vi.fn() },
          secret: { deleteMany: vi.fn() },
          task: { create: vi.fn().mockResolvedValue({ id: "task-new" }), updateMany: vi.fn() },
          steeringMessage: { create: vi.fn() },
          event: { create: vi.fn().mockResolvedValue({ seq: 4 }) },
          chatGroup: {
            findFirst: vi.fn().mockResolvedValue({
              id: "group-1",
              members: [
                { bot: { id: "bot-a", name: "Alpha", color: null } },
                { bot: { id: "bot-b", name: "Beta", color: null } },
              ],
            }),
            update: vi.fn(),
          },
        };
        const prisma = {
          message: { findUnique: vi.fn().mockResolvedValue(null) },
          $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
        } as unknown as PrismaClient;
        const target = (
          kind === "bot"
            ? { kind, botId: "bot-a", threadId: "thread-1", bot: { computer: null } }
            : {
                kind,
                groupId: "group-1",
                threadId: "thread-1",
                members: [],
                memberBotIds: ["bot-a", "bot-b"],
              }
        ) as ThreadTarget;
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await expect(
          sendThreadMessage(
            {
              prisma,
              sandbox: {} as never,
              events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
              jobs: { enqueue } as never,
            },
            { spaceId: "space-1", userId: "user-1" } as Actor,
            target,
            { text: "Keep working", mentions: ["bot-a"], clientNonce: "nonce-new" },
          ),
        ).resolves.toMatchObject({ runId: "run-new", runIds: ["run-new"] });
        if (approval) {
          expect(tx.run.updateMany).not.toHaveBeenCalled();
        } else {
          expect(tx.run.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: "run-waiting" }),
            data: expect.objectContaining({ status: "cancelled" }),
          });
          expect(tx.message.update).toHaveBeenCalledWith({
            where: { id: "ask-old" },
            data: {
              blocks: [
                expect.objectContaining({
                  status: "answered",
                  answer: "Keep working",
                  answerMessageId: "msg-new",
                }),
              ],
            },
          });
        }
        expect(tx.steeringMessage.create).not.toHaveBeenCalled();
        expect(tx.message.update).toHaveBeenCalledWith({
          where: { id: "msg-new" },
          data: { runId: "run-new" },
        });
        expect(ask.blocks[0]?.status).toBe("pending");
        expect(enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ name: "run.continue", payload: { runId: "run-new" } }),
        );
      }
    },
  );

  it("waits for the creation intro instead of starting a second run", async () => {
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Check the inbox" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "intro-run",
            taskId: "intro-task",
            status: "running",
            trigger: "created",
            userId: "user-1",
          },
        ]),
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Check the inbox", clientNonce: "nonce-during-intro" },
      ),
    ).resolves.toMatchObject({
      runId: "intro-run",
      taskId: "intro-task",
      runIds: ["intro-run"],
    });
    // Pending steering: the intro never claims it, so only that turn replies.
    // The continuation after it finishes answers with tools.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "intro-run" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  describe("in a shared space", () => {
    function busyThread(activeRuns: unknown[]) {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "Paris" }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          findMany: vi.fn(),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
        run: {
          findMany: vi.fn().mockResolvedValueOnce(activeRuns).mockResolvedValue([]),
          findFirst: vi.fn(),
          updateMany: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({
            id: "run-partner",
            taskId: "task-partner",
            botId: "bot-a",
            status: "queued",
            userId: "user-2",
          }),
        },
        task: {
          create: vi.fn().mockResolvedValue({ id: "task-partner" }),
          updateMany: vi.fn(),
        },
        steeringMessage: { create: vi.fn() },
        event: {
          create: vi.fn().mockResolvedValue({
            id: "event-1",
            seq: 1,
            createdAt: new Date(),
          }),
        },
        chatGroup: {
          findFirst: vi.fn().mockResolvedValue({
            id: "group-1",
            members: [
              { bot: { id: "bot-a", name: "Alpha", color: null } },
              { bot: { id: "bot-b", name: "Beta", color: null } },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "group-1" }),
        },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      return { tx, prisma };
    }
    const botTarget = {
      kind: "bot",
      botId: "bot-a",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const groupTarget = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const ownerRun = {
      id: "run-owner",
      taskId: "task-owner",
      botId: "bot-a",
      status: "waiting_takeover",
      trigger: "user",
      userId: "user-1",
    };

    it.each([
      ["bot", botTarget],
      ["group", groupTarget],
    ] as const)(
      "steers a %s run only with messages from the person it acts for",
      async (_kind, target) => {
        for (const [sender, steers] of [
          ["user-1", true],
          ["user-2", false],
        ] as const) {
          const { tx, prisma } = busyThread([ownerRun]);
          const releaseTakeover = vi.fn().mockResolvedValue(undefined);

          await expect(
            sendThreadMessage(
              {
                prisma,
                sandbox: {} as never,
                events: {
                  notify: vi.fn().mockResolvedValue(undefined),
                } as never,
                jobs: {
                  enqueue: vi.fn().mockResolvedValue(undefined),
                } as never,
              },
              { spaceId: "workspace-1", userId: sender } as Actor,
              target,
              { text: "skip that", clientNonce: `nonce-${sender}` },
              releaseTakeover,
            ),
          ).resolves.toMatchObject({ runId: "run-owner" });
          // Another person's message waits for a continuation that acts as them.
          expect(tx.steeringMessage.create).toHaveBeenCalledWith({
            data: {
              messageId: "msg-1",
              botId: "bot-a",
              userId: sender,
              runId: steers ? "run-owner" : null,
            },
          });
          // In a group, a message that names nobody also wakes the idle member, as its sender.
          expect(
            tx.run.create.mock.calls.map((call) => (call[0] as { data: unknown }).data),
          ).toEqual(
            target.kind === "group"
              ? [expect.objectContaining({ botId: "bot-b", userId: sender })]
              : [],
          );
          if (steers) expect(releaseTakeover).toHaveBeenCalledWith("run-owner");
          else expect(releaseTakeover).not.toHaveBeenCalledWith("run-owner");
        }
      },
    );

    it.each([
      ["bot", botTarget],
      ["group", groupTarget],
    ] as const)(
      "starts the sender's own %s run instead of answering another person's question",
      async (_kind, target) => {
        const { tx, prisma } = busyThread([{ ...ownerRun, status: "waiting_input" }]);

        await expect(
          sendThreadMessage(
            {
              prisma,
              sandbox: {} as never,
              events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
              jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
            },
            { spaceId: "workspace-1", userId: "user-2" } as Actor,
            target,
            { text: "Paris", clientNonce: "nonce-partner" },
          ),
        ).resolves.toMatchObject({ runId: "run-partner" });
        expect(tx.run.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            userId: "user-2",
            sourceMessageId: "msg-1",
          }),
        });
        // The question stays pending on its card for the person who asked.
        expect(tx.run.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: "run-owner" }),
          }),
        );
        expect(tx.task.updateMany).not.toHaveBeenCalled();
        expect(tx.steeringMessage.create).not.toHaveBeenCalled();
      },
    );
  });

  it("steers a waiting-takeover run instead of refusing the message", async () => {
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "skip that" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-waiting",
            taskId: "task-1",
            status: "waiting_takeover",
            userId: "user-1",
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          status: "waiting_takeover",
          startedAt: new Date(),
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "skip that",
          clientNonce: "nonce-takeover",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "msg-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });
  it.each([
    ["routine", "user-1"],
    ["bot_message", "user-1"],
    ["user", "user-2"],
  ])(
    "keeps a message pending instead of steering into an active %s run of %s",
    async (trigger, owner) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "what are the alternatives?" }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          update: vi.fn(),
        },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "run-routine",
                taskId: "task-routine",
                status: "running",
                userId: owner,
                trigger,
              },
            ])
            .mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({
            id: "run-user",
            taskId: "task-user",
            status: "queued",
            userId: "user-1",
          }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-user" }) },
        steeringMessage: { create: vi.fn() },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
        },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const enqueue = vi.fn().mockResolvedValue(undefined);

      await expect(
        sendThreadMessage(
          {
            prisma,
            sandbox: {} as never,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
            jobs: { enqueue } as never,
          },
          actor,
          target,
          { text: "what are the alternatives?", clientNonce: "nonce-routine" },
        ),
      ).resolves.toMatchObject({
        runId: "run-routine",
        taskId: "task-routine",
        runIds: ["run-routine"],
      });
      // Pending steering (no run): the busy turn never claims it, and the continuation
      // that starts when that turn finishes answers with the full thread.
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
      });
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      // Another member's run acts with their accounts; the message is never shown as part of it.
      if (owner === "user-1") {
        expect(tx.message.update).toHaveBeenCalledWith({
          where: { id: "msg-1" },
          data: { runId: "run-routine" },
        });
      } else {
        expect(tx.message.update).not.toHaveBeenCalled();
        expect(tx.event.create.mock.calls[0]![0].data.runId).toBeUndefined();
      }
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it("keeps a group message pending instead of steering into a member's webhook run", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "status?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "running",
              trigger: "webhook",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({
          id: "run-a",
          taskId: "task-a",
          botId: "bot-a",
          status: "queued",
          userId: "user-1",
        }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-a" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "status?", mentions: ["bot-a"], clientNonce: "nonce-group-webhook" },
    );

    expect(result).toMatchObject({ runId: "run-webhook", taskId: "task-webhook" });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });
  it("names the bot of the sender's own run when another member's run holds the first bot", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(2) },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "both of you?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-theirs",
              taskId: "task-theirs",
              botId: "bot-a",
              status: "running",
              trigger: "user",
              userId: "user-2",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn(async ({ data }: { data: { botId: string } }) => ({
          id: `run-${data.botId}`,
          taskId: "task-new",
          botId: data.botId,
          status: "queued",
          userId: "user-1",
        })),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-new" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      target,
      { text: "both of you?", mentions: ["bot-a", "bot-b"], clientNonce: "nonce-pair" },
    );

    expect(tx.event.create.mock.calls[0]![0].data).toMatchObject({
      botId: "bot-b",
      runId: "run-bot-b",
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-bot-b" },
    });
  });
  describe("a group message", () => {
    async function sendToGroup(
      text: string,
      mentions?: string[],
      activeRuns: Array<{
        id: string;
        botId: string;
        status: string;
        trigger: string;
      }> = [],
      replyTo?: { role: string; botId: string | null },
    ) {
      let messageSeq = 0;
      let eventSeq = 0;
      let nextRun = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          update: vi.fn(),
          findFirst: vi.fn().mockResolvedValue(
            replyTo
              ? {
                  id: "reply-parent",
                  blocks: [{ kind: "text", text: "Which colour?" }],
                  ...replyTo,
                }
              : null,
          ),
        },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce(activeRuns.map((run) => ({ taskId: "task-0", ...run })))
            .mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          update: vi.fn(),
          updateMany: vi.fn(),
          create: vi.fn(
            async ({ data }: { data: { botId: string; groupReplyOptional?: boolean } }) => ({
              id: `run-${++nextRun}`,
              taskId: `task-${nextRun}`,
              botId: data.botId,
              status: "queued",
            }),
          ),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-x" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        steeringMessage: { create: vi.fn() },
        chatGroup: {
          findFirst: vi.fn().mockResolvedValue({
            id: "group-1",
            members: [
              { bot: { id: "bot-a", name: "Alpha", color: null } },
              { bot: { id: "bot-b", name: "Beta", color: null } },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "group-1" }),
        },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
          sandbox: {} as never,
        },
        { spaceId: "workspace-1", userId: "user-1" } as Actor,
        {
          kind: "group",
          groupId: "group-1",
          groupName: "Group",
          threadId: "thread-1",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        } satisfies ThreadTarget,
        {
          text,
          mentions,
          clientNonce: "nonce-group-fanout",
          ...(replyTo ? { replyToMessageId: "reply-parent" } : {}),
        },
      );
      return { tx, created: tx.run.create.mock.calls.map(([args]) => args.data) };
    }

    it("that names nobody wakes every member, each free to stay silent", async () => {
      const { created } = await sendToGroup("what is the plan?");
      expect(created.map((run) => run.botId)).toEqual(["bot-a", "bot-b"]);
      expect(created.map((run) => run.groupReplyOptional)).toEqual([true, true]);
    });

    it("that names one member wakes only that member, who must reply", async () => {
      for (const sent of [
        await sendToGroup("@Beta what is the plan?"),
        await sendToGroup("what is the plan?", ["bot-b"]),
      ]) {
        expect(sent.created.map((run) => run.botId)).toEqual(["bot-b"]);
        expect(sent.created.map((run) => run.groupReplyOptional)).toEqual([false]);
      }
    });

    it("that mentions everyone wakes every member, who must reply", async () => {
      const { created } = await sendToGroup("@everyone what is the plan?");
      expect(created.map((run) => run.botId)).toEqual(["bot-a", "bot-b"]);
      expect(created.map((run) => run.groupReplyOptional)).toEqual([false, false]);
    });

    it("that only names someone outside the group still reaches every member", async () => {
      const { created } = await sendToGroup("@Zed what is the plan?");
      expect(created.map((run) => run.botId)).toEqual(["bot-a", "bot-b"]);
      expect(created.map((run) => run.groupReplyOptional)).toEqual([true, true]);
    });

    it("that replies to a member's message goes to that member, who must answer", async () => {
      const { created } = await sendToGroup("blue", undefined, [], {
        role: "bot",
        botId: "bot-b",
      });
      expect(created.map((run) => run.botId)).toEqual(["bot-b"]);
      expect(created.map((run) => run.groupReplyOptional)).toEqual([false]);
    });

    it("that replies to a member's message but names another goes to the named one", async () => {
      const { created } = await sendToGroup("@Alpha and you?", undefined, [], {
        role: "bot",
        botId: "bot-b",
      });
      expect(created.map((run) => run.botId)).toEqual(["bot-a"]);
    });

    it("that replies to a person's message, or to a bot outside the group, reaches everyone", async () => {
      for (const replyTo of [
        { role: "user", botId: null },
        { role: "bot", botId: "bot-outside" },
      ]) {
        const { created } = await sendToGroup("blue", undefined, [], replyTo);
        expect(created.map((run) => run.botId)).toEqual(["bot-a", "bot-b"]);
      }
    });

    it("that replies to a busy member steers that member and wakes no one else", async () => {
      const busy = {
        id: "run-busy",
        botId: "bot-b",
        status: "running",
        trigger: "user",
        userId: "user-1",
      };
      const { created, tx } = await sendToGroup("blue", undefined, [busy], {
        role: "bot",
        botId: "bot-b",
      });
      expect(created).toEqual([]);
      expect(tx.run.findMany.mock.calls[0]![0].where.botId).toEqual({ in: ["bot-b"] });
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ botId: "bot-b", runId: "run-busy" }),
      });
      expect(tx.run.update).toHaveBeenCalledWith({
        where: { id: "run-busy" },
        data: { groupReplyOptional: false },
      });
    });

    it("that names a member working on an unnamed message makes its reply required", async () => {
      const working = { id: "run-old", botId: "bot-a", status: "running", trigger: "user" };
      const named = await sendToGroup("@Alpha and the budget?", undefined, [working]);
      expect(named.tx.run.update).toHaveBeenCalledWith({
        where: { id: "run-old" },
        data: { groupReplyOptional: false },
      });
      const unnamed = await sendToGroup("and the budget?", undefined, [working]);
      expect(unnamed.tx.run.update).not.toHaveBeenCalled();
    });
  });

  it("answers a routine run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn().mockResolvedValue(waitingAsk),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-routine",
            taskId: "task-routine",
            status: "waiting_input",
            userId: "user-1",
            trigger: "routine",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", clientNonce: "nonce-routine-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-routine",
      taskId: "task-routine",
      runIds: ["run-routine"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-routine" } } },
      data: { prompt: "Paris" },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-routine", status: "waiting_input" }),
        data: { status: "queued" },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-routine" } }),
    );
  });
  it("answers a group webhook run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn().mockResolvedValue(waitingAsk),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-webhook",
            taskId: "task-webhook",
            botId: "bot-a",
            status: "waiting_input",
            userId: "user-1",
            trigger: "webhook",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", mentions: ["bot-a"], clientNonce: "nonce-group-webhook-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-webhook",
      taskId: "task-webhook",
      runIds: ["run-webhook"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-webhook" } } },
      data: { prompt: "Paris" },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-webhook", status: "waiting_input" }),
        data: { status: "queued" },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-webhook" } }),
    );
  });
  it("steers a conversational run instead of answering a waiting routine", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ taskId: "task-waiting" }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-routine",
              taskId: "task-routine",
              status: "waiting_input",
              userId: "user-1",
              trigger: "routine",
            },
            {
              id: "run-user",
              taskId: "task-user",
              status: "running",
              userId: "user-1",
              trigger: "user",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        update: vi.fn(),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what about the watch?", clientNonce: "nonce-routine-and-chat" },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: "run-user" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("steers a group conversational run instead of answering a waiting webhook", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ taskId: "task-waiting" }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "waiting_input",
              userId: "user-1",
              trigger: "webhook",
            },
            {
              id: "run-user",
              taskId: "task-user",
              botId: "bot-a",
              status: "running",
              userId: "user-1",
              trigger: "user",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        update: vi.fn(),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "what about the watch?",
          mentions: ["bot-a"],
          clientNonce: "nonce-group-webhook-and-chat",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects a quote excerpt without a reply target", async () => {
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "hi", replyQuote: "just this span", clientNonce: "nonce-1" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists quotes and namespaces a client-chosen strategic initiative nonce", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "strategic-initiative:bot-1:1",
      },
    );

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "user", clientNonce: "send:msg-1" }),
      }),
    );
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: {
        id: true,
        blocks: true,
        role: true,
        botId: true,
        authorUserId: true,
        runId: true,
      },
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });

  it("stamps the call id on the live event so the bubble joins the call card at once", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const clientNonce = callClientNonce("call-7");
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "book the flight" }],
          botId: null,
          runId: null,
          clientNonce,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    // Who to tell about the message: Ada's teammate.
    const members = vi.fn().mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      spaceMember: { findMany: members },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const send = (nonce: string | undefined) =>
      sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
          notifications: { send: vi.fn() } as never,
        },
        { spaceId: "workspace-1", userId: "user-1" } as Actor,
        { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
        { text: "book the flight", clientNonce: nonce },
      );
    await send(clientNonce);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A spoken turn tells no teammate; a typed message does.
    expect(members).not.toHaveBeenCalled();

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ callId: "call-7" }),
      }),
    });
    await send(undefined);
    await vi.waitFor(() => expect(members).toHaveBeenCalledOnce());
  });

  it("puts the message seq on the live event so the sender can match its echo", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 7,
          role: "user",
          blocks: [{ kind: "text", text: "hello" }],
          botId: null,
          runId: null,
          clientNonce: "nonce-1",
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 3, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
      { text: "hello", clientNonce: "nonce-1" },
    );

    expect(result.seq).toBe(7);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ messageId: "msg-1", seq: 7 }),
      }),
    });
  });

  it.each([undefined, "words the parent never said"])(
    "sends an unavailable reply to malformed blocks (quote: %s)",
    async (quote) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: [null],
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: null,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: quote,
          clientNonce: "nonce-1",
        },
      );

      // The send still lands as a plain reply — the fabricated excerpt is dropped.
      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          replyToMessageId: "parent",
          replyQuote: undefined,
        }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyPreview: null, replyToMessageId: "parent" }),
        }),
      });
    },
  );

  it("sends a plain reply when the reply target no longer exists", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        // The parent was deleted (or paged out) between arming and send.
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: null,
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "deleted-parent",
        replyQuote: "the span that was quoted",
        clientNonce: "nonce-1",
      },
    );

    // The send lands with an unavailable marker and no dangling target.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: undefined,
        replyQuote: "",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.not.objectContaining({ replyToMessageId: expect.anything() }),
      }),
    });
  });

  it("accepts a quote excerpt that matches formatted parent text", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          // Rendered as "42% growth", stored with markdown source.
          blocks: [{ kind: "text", text: "we saw **42%** growth last week" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "42% growth",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "42% growth",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyQuote: "42% growth" }),
    });
  });

  // Markdown rendering cases live in packages/core message-quote tests; these reach the send path.
  it.each([
    [
      "lists after code fences",
      "```text\n1. code\n```\n1. First\n2. Second",
      "First\nSecond",
      "First\nSecond",
    ],
    ["tab-indented code", "\t2. restart()", "2. restart()", "2. restart()"],
    ["three-space lists", "   1. First\n   2. Second", "First\nSecond", "First\nSecond"],
  ])(
    "derives a quote excerpt spanning rendered %s",
    async (_name, parentText, requestedQuote, expectedQuote) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: [
              {
                kind: "text",
                text: parentText,
              },
            ],
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: expectedQuote,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: requestedQuote,
          clientNonce: "nonce-1",
        },
      );

      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replyQuote: expectedQuote }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyQuote: expectedQuote }),
        }),
      });
    },
  );

  it.each([
    [
      "image only",
      [{ kind: "image", artifactId: "photo", name: "", mimeType: "image/png" }],
      undefined,
      undefined,
      "",
      { kind: "image", artifactId: "photo", name: "", mimeType: "image/png" },
    ],
    [
      "file only",
      [{ kind: "file", artifactId: "file", name: "notes.txt", mimeType: "text/plain", size: 12 }],
      undefined,
      undefined,
      "notes.txt",
      { kind: "file", artifactId: "file", name: "notes.txt", mimeType: "text/plain" },
    ],
    [
      "caption and selection",
      [
        { kind: "image", artifactId: "photo", name: "photo.png", mimeType: "image/png" },
        { kind: "text", text: "Caption selected text" },
      ],
      "selected text",
      "selected text",
      "Caption selected text",
      { kind: "image", artifactId: "photo", name: "photo.png", mimeType: "image/png" },
    ],
  ])(
    "derives live reply metadata for %s from the same-thread parent",
    async (_name, parentBlocks, requestedQuote, expectedQuote, expectedText, expectedAttachment) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        space: { findUnique: vi.fn(async () => null) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: parentBlocks,
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: expectedQuote,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: requestedQuote,
          clientNonce: "nonce-1",
        },
      );

      expect(tx.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "parent", threadId: "thread-1" } }),
      );
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            replyPreview: { role: "bot", text: expectedText, attachment: expectedAttachment },
          }),
        }),
      });
      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replyQuote: expectedQuote }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyQuote: expectedQuote }),
        }),
      });
    },
  );

  it("drops a quote excerpt that only matches after stripping punctuation", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [
            {
              kind: "text",
              text: "C++ is fast and key:value pairs; version 1.2 and 2. items\n    2. restart()\n```text\n1. alpha\n2. beta\n```\n~~~text\n1. gamma\n2. delta\n~~~\n```text\n> ```\n1. epsilon\n2. zeta\n```\n> ```text\n> > ```\n> 1. eta\n> 2. theta\n> ```\n```text\nalpha\n---\nomega\n```\nRead [docs](https://example.test/private)\nAlice\n# 1. heading\n# 2. another heading\n\n    > 1. literal\n    > 2. another literal",
            },
          ],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    for (const replyQuote of [
      "C is fast",
      "key value pairs",
      "version 12",
      "and items",
      "3. restart()",
      "    3. restart()",
      "99. C++ is fast",
      "alpha\nbeta",
      "gamma\ndelta",
      "epsilon\nzeta",
      "eta\ntheta",
      "alpha\nomega",
      "text",
      "https://example.test/private",
      "alice",
      "heading\nanother heading",
      "literal\nanother literal",
    ]) {
      await sendThreadMessage(
        {
          prisma,
          sandbox: {} as never,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "why this?", replyToMessageId: "parent", replyQuote },
      );
    }

    for (const call of tx.message.create.mock.calls) {
      expect(call[0].data.replyQuote).toBeUndefined();
    }
  });

  it("still sends a plain reply when quote derivation throws", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "explode derivation",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyToMessageId: "parent" }),
    });
    expect(tx.message.create.mock.calls[0]![0].data.replyQuote).toBeUndefined();
  });

  it("persists the quote excerpt on a group send", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      space: { findUnique: vi.fn(async () => null) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-1", taskId: "task-1", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });
});

describe("stopThreadRuns", () => {
  it("snapshots every lease when group members share a team computer", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    let nextEventSeq = 0;
    const transaction = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      message: { findMany: vi.fn(async () => []) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a", threadId: "thread-1" },
          { id: "run-b", botId: "bot-b", threadId: "thread-1" },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      secret: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Production team ownership is lease-only: Computer.executionRunId stays null.
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { OR?: unknown[] } }) => {
          expect(where.OR).toEqual(
            expect.arrayContaining([
              { id: { in: ["computer-db-team"] } },
              { executionRunId: { in: ["run-a", "run-b"] } },
            ]),
          );
          return [
            {
              id: "computer-db-team",
              homeKey: "home-team",
              kind: "fake",
              providerRef: "computer-team",
              executionBotId: null,
              executionRunId: null,
            },
          ];
        }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-team", botId: "bot-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-team", botId: "bot-b", runId: "run-b", fence: 4 },
        ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      // Simulate workers clearing leases / execution columns as soon as the
      // transaction commits. A post-commit lookup would now miss both sandboxes.
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(transaction.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      select: { computerId: true, botId: true, runId: true, fence: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-b"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-b", botId: "bot-b" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });

  it("does not tear down a stale legacy execution run when the lease owns a cancelled run", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }),
      },
      message: { findMany: vi.fn(async () => []) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValue([{ id: "run-a", botId: "bot-a", threadId: "thread-1" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      secret: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Selected via lease for cancelled run A, but legacy columns still name
        // unrelated live run B. Legacy teardown must not cancel/release B.
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
      },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-db-a", botId: "bot-a", runId: "run-a", fence: 2 },
          ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-b"]),
      }),
      expect.anything(),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(1);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        botId: "bot-a",
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-b" }),
    );
  });

  it("writes a run.cancelled event per cancelled run ahead of the progress purge", async () => {
    // Two earlier progress events already hold seqs 0 and 1; a client may have
    // applied cursor 1 before Stop deletes those rows.
    let nextEventSeq = 2;
    const writes: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const transaction = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      message: { findMany: vi.fn(async () => []) },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", userId: "user-1", spaceId: "workspace-1" },
          { id: "run-b", userId: "user-1", spaceId: "workspace-1" },
        ]),
        updateManyAndReturn: vi.fn().mockResolvedValue([
          {
            id: "run-a",
            botId: "bot-a",
            userId: "user-1",
            spaceId: "workspace-1",
            threadId: "thread-1",
          },
          {
            id: "run-b",
            botId: "bot-b",
            userId: "user-1",
            spaceId: "workspace-1",
            threadId: "thread-1",
          },
        ]),
        // appendEventInTransaction re-reads the run after the flip.
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      secret: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { findMany: vi.fn().mockResolvedValue([]) },
      computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push("event.create");
          created.push(data);
          return data;
        }),
        deleteMany: vi.fn(async () => {
          writes.push("event.deleteMany");
          return { count: 4 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      // No event delegate: a post-commit progress delete would throw here.
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(created).toEqual([
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-a",
        type: "run.cancelled",
        runId: "run-a",
        payload: {},
        seq: 2,
      }),
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-b",
        type: "run.cancelled",
        runId: "run-b",
        payload: {},
        seq: 3,
      }),
    ]);
    // The terminal seqs sit above every deleted progress seq, so max(seq) never
    // rewinds below an applied cursor.
    expect(Math.max(...created.map((data) => data.seq as number))).toBeGreaterThan(1);
    expect(writes.lastIndexOf("event.create")).toBeLessThan(writes.indexOf("event.deleteMany"));
    expect(transaction.event.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { type: "thread.progress" },
          { type: "thread.meta", payload: { equals: { activity: { thinking: true } } } },
          { type: "thread.meta", payload: { equals: { activity: { thinking: false } } } },
        ],
        runId: { in: ["run-a", "run-b"] },
      },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 3);
    // A stopped run never resumes to read a waiting secret answer.
    expect(transaction.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-a" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-a" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-a" },
          { userId: "user-1", spaceId: "workspace-1", kind: { startsWith: "run-login:run-a:" } },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-b" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-b" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-b" },
          { userId: "user-1", spaceId: "workspace-1", kind: { startsWith: "run-login:run-b:" } },
        ],
      },
    });
  });

  it("emits no event and skips the wake when nothing was running", async () => {
    const transaction = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      spaceMember: { count: vi.fn().mockResolvedValue(1) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(),
      thread: { update: vi.fn() },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      secret: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { findMany: vi.fn() },
      computerExecutionLease: { findMany: vi.fn() },
      event: { create: vi.fn(), deleteMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(transaction.event.create).not.toHaveBeenCalled();
    expect(transaction.event.deleteMany).not.toHaveBeenCalled();
    expect(transaction.thread.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(transaction.secret.deleteMany).not.toHaveBeenCalled();
  });

  it("runs the stop transaction with the explicit thread-lock budget", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(),
      run: { updateManyAndReturn: vi.fn().mockResolvedValue([]) },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const $transaction = vi.fn(async (callback: (client: typeof transaction) => unknown) =>
      callback(transaction),
    );
    const prisma = {
      $transaction,
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    // The stop holds the thread row lock, which snapshot reads can hold for up to
    // 15s; Prisma's 5s default counts that wait and turns a loaded database into
    // a failed stop. Only the timeout is explicit: an explicit maxWait would
    // override the client's longer connection wait, so a saturated pool that
    // frees a connection late would fail the checkout instead of waiting it out.
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });
});

describe("helper snapshot settlement", () => {
  it.each(["bot", "group"] as const)(
    "settles stale helpers on reload in a %s thread",
    async (kind) => {
      const runs = [
        { id: "paused", status: "waiting_input" },
        { id: "working", status: "running" },
      ].map((run) => ({
        ...run,
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task",
        trigger: "user",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        startedAt: null,
        completedAt: null,
      }));
      const liveEvents = runs.map((run, seq) => ({
        id: `event-${seq}`,
        threadId: "thread-1",
        runId: run.id,
        seq,
        type: "thread.subagent",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        payload: { agentId: run.id, name: "Helper", task: "Check", status: "running" },
      }));
      const previous = liveEvents[1]!;
      const history = [
        liveEvents[0]!,
        { ...previous, payload: { ...previous.payload, agentId: "before-resume" } },
        { ...previous, seq: 2, type: "run.waiting_input", payload: {} },
        { ...previous, seq: 3 },
      ];
      const tx = {
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        message: { findMany: vi.fn().mockResolvedValue([]) },
        event: {
          findFirst: vi.fn().mockResolvedValue({ seq: 2 }),
          findMany: vi.fn(async (input: { where: { type: { in: string[] } } }) =>
            history.filter((event) => input.where.type.in.includes(event.type)),
          ),
        },
        run: { findFirst: botRunFindFirst(runs), findMany: groupRunFindMany({ active: runs }) },
      };
      const prisma = {
        spaceMember: { count: vi.fn().mockResolvedValue(1) },
        $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      } as unknown as PrismaClient;
      const result = await threadSnapshot({ prisma }, {
        kind,
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
        members: [],
      } as unknown as ThreadTarget);
      expect(result.messages.find((m) => m.id === "subagent:paused")?.blocks[0]).toMatchObject({
        status: "failed",
        result: "stopped",
      });
      expect(
        result.messages.find((m) => m.id === "subagent:before-resume")?.blocks[0],
      ).toMatchObject({
        status: "failed",
        result: "stopped",
      });
      expect(result.messages.find((m) => m.id === "subagent:working")?.blocks[0]).toMatchObject({
        status: "running",
      });
    },
  );
});

describe("sendTargetBotIds", () => {
  const group = {
    kind: "group" as const,
    members: [
      { botId: "bot-a", name: "Alpha" },
      { botId: "bot-b", name: "Beta" },
    ],
  };

  it("sends a reply to a member's message to that member alone", () => {
    expect(sendTargetBotIds(group, { text: "blue" }, "bot-b")).toEqual(["bot-b"]);
  });

  it("lets a mention beat the reply target, and ignores a bot outside the group", () => {
    expect(sendTargetBotIds(group, { text: "@Alpha and you?" }, "bot-b")).toEqual(["bot-a"]);
    expect(sendTargetBotIds(group, { text: "blue" }, "bot-outside")).toEqual(["bot-a", "bot-b"]);
    expect(sendTargetBotIds(group, { text: "blue" })).toEqual(["bot-a", "bot-b"]);
  });

  it("finds the bot a send replies to only for a bot's message", async () => {
    const findFirst = vi.fn().mockResolvedValue({ botId: "bot-b" });
    const prisma = { message: { findFirst } } as unknown as PrismaClient;
    expect(await replyParentBotId(prisma, { threadId: "thread-1" }, {})).toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
    expect(
      await replyParentBotId(prisma, { threadId: "thread-1" }, { replyToMessageId: "m-1" }),
    ).toBe("bot-b");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "m-1", threadId: "thread-1", role: "bot" },
      select: { botId: true },
    });
  });
});

describe("latestWaitingRun", () => {
  it("picks the most recent question among members waiting on the user", () => {
    const run = (id: string, status: string, minute: number) => ({
      id,
      status,
      updatedAt: new Date(2026, 0, 1, 9, minute),
    });
    expect(
      latestWaitingRun([
        run("a", "waiting_input", 1),
        run("b", "waiting_input", 5),
        run("c", "running", 9),
      ])?.id,
    ).toBe("b");
    expect(latestWaitingRun([run("c", "running", 9)])).toBeUndefined();
    const tied = [run("x", "waiting_input", 3), run("y", "waiting_input", 3)];
    expect(latestWaitingRun(tied)?.id).toBe("y");
    expect(latestWaitingRun([...tied].reverse())?.id).toBe("y");
  });
});
