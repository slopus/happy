import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};

const baseBot = {
  id: "bot-1",
  spaceId: "ws-1",
  userId: "user-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", reads: [{ unread: false }], messages: [], runs: [] },
  runs: [],
  computer: null,
};

function reposFor(memoryScope: string | null) {
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [{ ...baseBot, memoryScope }]),
    },
    run: {
      findMany: vi.fn(async () => []),
    },
    $queryRaw: vi.fn(async () => []),
  };
  return createRepos(prisma as unknown as PrismaClient);
}

describe("createRepos.listBots", () => {
  it.each([undefined, "organic", "rakazo"])(
    "preserves appearance metadata on reload (set=%s)",
    async (avatarSet) => {
      const rows = ["#8B5CF6", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="].map(
        (color, index) => ({ ...baseBot, id: `bot-${index}`, color, avatarSet }),
      );
      const prisma = {
        bot: { findMany: vi.fn(async () => rows) },
        run: { findMany: vi.fn(async () => []) },
        $queryRaw: vi.fn(async () => []),
      };
      const bots = await createRepos(prisma as unknown as PrismaClient).listBots(actor);
      expect(
        bots.map((bot) => ({ id: bot.id, color: bot.color, avatarSet: bot.avatarSet })),
      ).toEqual(
        rows.map((row) => ({ id: row.id, color: row.color, avatarSet: avatarSet ?? "organic" })),
      );
    },
  );

  it("surfaces a failed foreground run and clears the signal after recovery", async () => {
    const findMany = vi.fn(async () => [baseBot]);
    const queryRaw = vi.fn(async () => [] as unknown[]);
    queryRaw.mockResolvedValueOnce([{ id: "run-failed", threadId: "thread-1", status: "failed" }]);
    const repos = createRepos({
      bot: { findMany },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient);
    const failed = await repos.listBots(actor);
    expect(failed[0]).toMatchObject({ status: "idle", runErrorId: "run-failed" });
    queryRaw.mockResolvedValueOnce([
      { id: "run-recovered", threadId: "thread-1", status: "completed" },
    ]);
    const recovered = await repos.listBots(actor);
    expect(recovered[0]).toMatchObject({ status: "idle", runErrorId: null });
  });

  it("classifies initial preview runs once across bots, including non-peer results", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () =>
          ["one", "two"].map((id) => ({
            ...baseBot,
            id,
            thread: { ...baseBot.thread, id: `thread-${id}`, messages: [] },
          })),
        ),
      },
      run: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () =>
        ["one", "two"].map((id, seq) => ({
          threadId: `thread-${id}`,
          seq,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          runId: `run-${id}`,
          blocks: [{ kind: "text", text: `Answer ${id}` }],
        })),
      ),
    };

    const bots = await createRepos(prisma as unknown as PrismaClient).listBots(actor);

    expect(bots.map((bot) => bot.preview)).toEqual(["Answer one", "Answer two"]);
    expect(prisma.run.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["run-one", "run-two"] }, trigger: { in: ["bot_message", "tickets"] } },
      select: { id: true, trigger: true },
    });
  });

  it("classifies unseen runs in older pages and retains negative results between pages", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: { ...baseBot.thread, messages: [] },
          },
        ]),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "peer-new" }])
          .mockResolvedValueOnce([{ id: "peer-old" }]),
      },
      $queryRaw: vi.fn(async () => [
        {
          threadId: "thread-1",
          seq: 30,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          runId: "peer-new",
          blocks: [{ kind: "text", text: "Hidden" }],
        },
      ]),
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { seq: 20, runId: "peer-old", blocks: [{ kind: "text", text: "Also hidden" }] },
            { seq: 19, runId: "user-old", blocks: [] },
          ])
          .mockResolvedValueOnce([
            { seq: 10, runId: "peer-old", blocks: [{ kind: "text", text: "Still hidden" }] },
            { seq: 9, runId: "user-old", blocks: [{ kind: "text", text: "Visible answer" }] },
          ]),
      },
    };

    const bots = await createRepos(prisma as unknown as PrismaClient).listBots(actor);

    expect(bots[0]?.preview).toBe("Visible answer");
    expect(prisma.run.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.run.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["peer-old", "user-old"] },
        trigger: { in: ["bot_message", "tickets"] },
      },
      select: { id: true, trigger: true },
    });
    expect(prisma.message.findMany).toHaveBeenCalledTimes(2);
  });

  it("keeps bot-to-bot run output out of sidebar previews", async () => {
    const findMany = vi.fn(async () => [
      {
        ...baseBot,
        thread: { ...baseBot.thread, messages: [] },
      },
    ]);
    const prisma = {
      bot: {
        findMany,
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      $queryRaw: vi.fn(async () => [
        {
          threadId: "thread-1",
          seq: 3,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          runId: "run-peer",
          blocks: [{ kind: "text", text: "Echoed peer reply" }],
        },
        {
          threadId: "thread-1",
          seq: 2,
          createdAt: new Date("2026-08-19T00:00:00.000Z"),
          runId: "run-peer",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "bot-2",
              fromBotName: "Coder",
              text: "Peer result",
            },
          ],
        },
        {
          threadId: "thread-1",
          seq: 1,
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
          runId: "run-user",
          blocks: [{ kind: "text", text: "Visible answer" }],
        },
      ]),
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Visible answer" }),
    ]);
  });

  it("skips a peer-run preview tail when the receipt is outside the window", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: { ...baseBot.thread, messages: [] },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      $queryRaw: vi.fn(async () => [
        {
          threadId: "thread-1",
          seq: 2,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          runId: "run-peer",
          blocks: [{ kind: "text", text: "Echoed peer reply" }],
        },
        {
          threadId: "thread-1",
          seq: 1,
          createdAt: new Date("2026-08-19T00:00:00.000Z"),
          runId: "run-user",
          blocks: [{ kind: "text", text: "Visible answer" }],
        },
      ]),
      message: {
        findMany: vi.fn(async () => []),
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Visible answer" }),
    ]);
  });

  it("uses text from the same window after a chart-only peer relay", async () => {
    const messageFindMany = vi.fn(async () => [
      { seq: 1, blocks: [{ kind: "text", text: "Earlier-window answer" }] },
    ]);
    const prisma = {
      bot: { findMany: vi.fn(async () => [baseBot]) },
      run: { findMany: vi.fn(async () => [{ id: "run-peer", trigger: "bot_message" }]) },
      $queryRaw: vi.fn(async () => [
        {
          id: "chart-reply",
          threadId: "thread-1",
          seq: 4,
          role: "bot",
          runId: "run-peer",
          blocks: [{ kind: "chart", name: "Results", spec: {}, data: [] }],
        },
        {
          id: "relay-receipt",
          threadId: "thread-1",
          seq: 3,
          role: "bot",
          runId: "run-peer",
          replyToMessageId: "sent",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "bot-2",
              fromBotName: "Coder",
              text: "Peer result",
              intent: "result",
            },
          ],
        },
        {
          id: "answer",
          threadId: "thread-1",
          seq: 2,
          role: "bot",
          runId: null,
          blocks: [{ kind: "text", text: "Current-window answer" }],
        },
      ]),
      message: { findMany: messageFindMany },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Current-window answer" }),
    ]);
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it("scans older messages when the newest window is only peer output", async () => {
    const messageFindMany = vi.fn(async () => [
      { seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Older visible answer" }] },
    ]);
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: { ...baseBot.thread, messages: [] },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      $queryRaw: vi.fn(async () => [
        {
          threadId: "thread-1",
          seq: 20,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          runId: "run-peer",
          blocks: [{ kind: "text", text: "Echoed peer reply" }],
        },
      ]),
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { lt: 20 } },
      orderBy: { seq: "desc" },
      take: 16,
    });
  });

  it("uses a visible message from the fourth older window for preview", async () => {
    const peerWindows = [
      [{ seq: 80, runId: "run-peer", blocks: [{ kind: "text", text: "peer 80" }] }],
      [{ seq: 60, runId: "run-peer", blocks: [{ kind: "text", text: "peer 60" }] }],
      [{ seq: 40, runId: "run-peer", blocks: [{ kind: "text", text: "peer 40" }] }],
      [{ seq: 20, runId: "run-peer", blocks: [{ kind: "text", text: "peer 20" }] }],
      [{ seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Fourth-window answer" }] }],
    ];
    let windowIndex = 0;
    const messageFindMany = vi.fn(async () => {
      windowIndex += 1;
      return peerWindows[windowIndex] ?? [];
    });
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: { ...baseBot.thread, messages: [] },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      $queryRaw: vi.fn(async () =>
        (peerWindows[0] ?? []).map((message) => ({
          threadId: "thread-1",
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          ...message,
        })),
      ),
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Fourth-window answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledTimes(4);
  });

  it("dates the row by its newest message, not the bot's last settings write", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            updatedAt: new Date("2026-08-21T09:00:00.000Z"),
            thread: { ...baseBot.thread, messages: [] },
          },
        ]),
      },
      run: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => [
        {
          threadId: "thread-1",
          seq: 2,
          createdAt: new Date("2026-08-20T10:30:00.000Z"),
          blocks: [{ kind: "text", text: "Latest answer" }],
        },
        {
          threadId: "thread-1",
          seq: 1,
          createdAt: new Date("2026-08-20T10:00:00.000Z"),
          blocks: [{ kind: "text", text: "Question" }],
        },
      ]),
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ updatedAt: "2026-08-20T10:30:00.000Z" }),
    ]);
  });

  it("keeps the bot's own updatedAt for a chat with no messages", async () => {
    await expect(reposFor(null).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ updatedAt: "2026-08-19T00:00:00.000Z" }),
    ]);
  });
});

describe("createRepos.listSpaceBotsForSpaces", () => {
  it("loads and maps only the compact cross-space sidebar fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        color: "#123456",
        avatarSet: "organic",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        parentBotId: null,
        thread: {
          id: "thread-2",
          reads: [{ unread: true, snoozedUntil: new Date("2026-08-21T09:00:00.000Z") }],
          runs: [{ id: "run-failed", status: "failed" }],
        },
        runs: [{ status: "running", threadId: "group-thread" }],
      },
    ]);
    const repos = createRepos({
      bot: { findMany },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "run-failed", threadId: "thread-2", status: "failed" }])
        .mockResolvedValueOnce([
          {
            id: "message-2",
            threadId: "thread-2",
            seq: 4,
            role: "user",
            blocks: [{ kind: "text", text: "Waiting for a reply" }],
            botId: null,
            replyToMessageId: null,
            replyQuote: null,
            runId: null,
            clientNonce: null,
            createdAt: new Date("2026-08-19T12:00:00.000Z"),
          },
        ]),
    } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(["ws-2"], "user-1")).resolves.toEqual([
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "",
        color: "#123456",
        avatarSet: "organic",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        unread: true,
        snoozedUntil: "2026-08-21T09:00:00.000Z",
        parentBotId: null,
        preview: "Waiting for a reply",
        status: "running",
        threadStatus: "idle",
        runErrorId: "run-failed",
        updatedAt: "2026-08-19T12:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.select.thread).toEqual(
      expect.objectContaining({
        select: expect.not.objectContaining({
          messages: expect.anything(),
        }),
      }),
    );
    expect(query.where).toEqual(expect.objectContaining({ spaceId: { in: ["ws-2"] } }));
    expect(query.select).not.toHaveProperty("description");
    expect(query.select).not.toHaveProperty("instructions");
    expect(query.select).not.toHaveProperty("computer");
  });
});

describe("createRepos.reorderBots", () => {
  function reorderRepos(ids: string[]) {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      bot: {
        findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
        update,
      },
    };
    const prisma = {
      $transaction: vi.fn((run: (client: typeof tx) => Promise<void>) => run(tx)),
    };
    return { repos: createRepos(prisma as unknown as PrismaClient), update };
  }

  it("writes each owned bot's requested position", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await repos.reorderBots(actor, ["bot-2", "bot-1"]);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "bot-2" },
      data: { position: 0 },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "bot-1" },
      data: { position: 1 },
    });
  });

  it("rejects partial or foreign bot lists before writing", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await expect(repos.reorderBots(actor, ["bot-1"])).rejects.toBeInstanceOf(IsolationError);
    await expect(repos.reorderBots(actor, ["bot-1", "foreign"])).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});

it("finds incoming calls independently of the sidebar message window", async () => {
  const blocks = [
    {
      kind: "call_request",
      callId: "call-1",
      reason: "Review",
      opening: "Ready?",
      status: "ringing",
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
    },
  ];
  const messageQuery = vi.fn(async () => [{ threadId: "thread-1", role: "bot", blocks }]);
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [
        baseBot,
        { ...baseBot, id: "bot-2", thread: { ...baseBot.thread, id: "thread-2" } },
      ]),
    },
    message: { findMany: messageQuery },
    $queryRaw: vi.fn(async () => []),
  } as unknown as PrismaClient;
  const now = Date.now();
  const bots = await createRepos(prisma, {
    phoneCallsEnabled: true,
    phoneCallRingSeconds: 90,
  }).listBots(actor);
  expect(bots[0]?.incomingCall?.callId).toBe("call-1");
  expect(messageQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        createdAt: { gt: expect.any(Date) },
        threadId: { in: ["thread-1", "thread-2"] },
        role: "bot",
        clientNonce: { startsWith: "call:", endsWith: ":request" },
      }),
      distinct: ["threadId"],
    }),
  );
  const cutoff = (
    messageQuery.mock.calls[0] as unknown as [{ where: { createdAt: { gt: Date } } }]
  )[0].where.createdAt.gt.getTime();
  expect(cutoff).toBeGreaterThanOrEqual(now - 90_000);
  expect(cutoff).toBeLessThanOrEqual(Date.now() - 90_000);
  expect(messageQuery).toHaveBeenCalledOnce();
  expect(bots[1]?.incomingCall).toBeNull();
  messageQuery.mockClear();
  expect((await createRepos(prisma).listBots(actor))[0]?.incomingCall).toBeNull();
  expect(messageQuery).not.toHaveBeenCalled();
});
