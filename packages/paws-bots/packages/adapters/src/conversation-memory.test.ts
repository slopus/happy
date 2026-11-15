import type {
  BackgroundJob,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
} from "@rakazo/adapter-kit";
import { memoryRetainTurnJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  abandonRetainedConversation,
  retainRunConversation,
  retainsConversationTurn,
  settleRetainedConversation,
} from "./conversation-memory.js";

function memoryProvider(connectionIdentity = "connection-1") {
  const retain = vi.fn(
    async (): Promise<SemanticMemoryResponse<{ pending?: string }>> => ({ ok: true, value: {} }),
  );
  const settled = vi.fn(
    async (): Promise<SemanticMemoryResponse<{ settled: boolean }>> => ({
      ok: true,
      value: { settled: true },
    }),
  );
  return {
    connectionIdentity,
    describe: vi.fn(),
    recall: vi.fn(),
    save: vi.fn(),
    purgeHistory: vi.fn(
      async (): Promise<SemanticMemoryResponse<void>> => ({ ok: true, value: undefined }),
    ),
    retainConversation: retain,
    retainedConversationSettled: settled,
  } satisfies SemanticMemoryProvider;
}

describe("retainsConversationTurn", () => {
  const turn = {
    trigger: "user",
    sourceMessageId: "message-1",
    runBotId: "bot-1",
    threadBotId: "bot-1",
    threadGroupId: null,
    nonOwnerChatRun: false,
    provider: memoryProvider(),
  };

  it.each([
    ["a person's turn in the bot's own thread", {}],
    ["a message from another bot", { trigger: "bot_message" }],
    ["a group chat turn", { threadBotId: null, threadGroupId: "group-1" }],
  ])("captures %s", (_case, change) => {
    expect(retainsConversationTurn({ ...turn, ...change })).toBe(true);
  });

  it.each([
    ["a routine", { trigger: "routine" }],
    ["a chat-app member who is not the owner", { nonOwnerChatRun: true }],
    [
      "a chat-app member who is not the owner in a group",
      { threadBotId: null, threadGroupId: "group-1", nonOwnerChatRun: true },
    ],
    ["another bot's thread", { threadBotId: "bot-2" }],
    [
      "a provider that does not learn from conversations",
      { provider: { ...turn.provider, retainConversation: undefined } },
    ],
  ])("skips %s", (_case, change) => {
    expect(retainsConversationTurn({ ...turn, ...change })).toBe(false);
  });
});

interface FakeMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: unknown[];
  createdAt: Date;
  botId: string | null;
  runId: string | null;
  clientNonce: string | null;
  authorUserId: string | null;
}

type Where = Record<string, unknown>;

function matches(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return value === condition;
  const c = condition as {
    in?: unknown[];
    not?: unknown;
    gt?: number;
    lt?: number;
    lte?: number;
    startsWith?: string;
  };
  if (c.startsWith !== undefined && !(typeof value === "string" && value.startsWith(c.startsWith)))
    return false;
  if (c.in && !c.in.includes(value)) return false;
  if ("not" in c && value === c.not) return false;
  if (c.not !== undefined && value === null) return false;
  if (c.gt !== undefined && !((value as number) > c.gt)) return false;
  if (c.lt !== undefined && !((value as number) < c.lt)) return false;
  if (c.lte !== undefined && !((value as number) <= c.lte)) return false;
  return true;
}

function query(
  messages: FakeMessage[],
  args: { where: Where; orderBy?: { seq: "asc" | "desc" }; take?: number },
): FakeMessage[] {
  function eligible(message: FakeMessage, where: Where): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Where[]).some((branch) => eligible(message, branch));
      if (key === "AND") return (condition as Where[]).every((branch) => eligible(message, branch));
      if (key === "NOT") return !eligible(message, condition as Where);
      return matches(message[key as keyof FakeMessage], condition);
    });
  }
  const found = messages.filter((message) => eligible(message, args.where));
  if (args.orderBy) {
    const direction = args.orderBy.seq === "asc" ? 1 : -1;
    found.sort((a, b) => (a.seq - b.seq) * direction);
  }
  return args.take === undefined ? found : found.slice(0, args.take);
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, second));

function message(
  partial: Partial<FakeMessage> & Pick<FakeMessage, "id" | "seq" | "role">,
  text?: string,
): FakeMessage {
  return {
    threadId: "thread-1",
    blocks: text === undefined ? [] : [{ kind: "text", text }],
    createdAt: at(partial.seq),
    botId: null,
    runId: null,
    clientNonce: null,
    authorUserId: null,
    ...partial,
  };
}

const directMessages = [
  message({
    id: "message-1",
    seq: 1,
    role: "user",
    authorUserId: "user-2",
    blocks: [
      { kind: "text", text: "I'm moving to Lisbon." },
      { kind: "file", name: "plan.pdf" },
    ],
  }),
  message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "Which month?"),
  message(
    {
      id: "r-3",
      seq: 3,
      role: "bot",
      botId: "bot-1",
      runId: "run-1",
      clientNonce: "partial-reply:run-1",
    },
    "Half an ans",
  ),
  message(
    {
      id: "r-4",
      seq: 4,
      role: "bot",
      botId: "bot-1",
      runId: "run-1",
      clientNonce: "user-progress:run-1:1",
    },
    "Checking your calendar…",
  ),
  message({ id: "steer-1", seq: 5, role: "user" }, "April."),
  message({
    id: "r-6",
    seq: 6,
    role: "bot",
    botId: "bot-1",
    runId: "run-1",
    blocks: [
      { kind: "step", id: "step-1" },
      { kind: "text", text: "Noted." },
    ],
  }),
  message({ id: "elsewhere", threadId: "thread-2", seq: 9, role: "user" }, "Other chat."),
];

function harness(
  options: {
    generations?: number[];
    groupId?: string;
    messages?: FakeMessage[];
    sourceMessageId?: string;
    memoryScope?: string | null;
    defaultScope?: "isolated" | "shared";
    /** The thread was deleted. */
    threadGone?: boolean;
  } = {},
) {
  const generations = options.generations ?? [3, 3];
  const messages = options.messages ?? directMessages;
  const provider = memoryProvider();
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({
        id: "run-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        userId: "user-1",
        sourceMessageId: options.sourceMessageId ?? "message-1",
      })),
    },
    thread: {
      findUnique: vi.fn(async () =>
        options.threadGone
          ? null
          : {
              botId: options.groupId ? null : "bot-1",
              spaceId: "space-1",
              groupId: options.groupId ?? null,
              historyCompactionGeneration: generations.shift() ?? 3,
            },
      ),
    },
    message: {
      findFirst: vi.fn(
        async (args: { where: Where; orderBy?: { seq: "asc" | "desc" } }) =>
          query(messages, args)[0] ?? null,
      ),
      findMany: vi.fn(
        async (args: { where: Where; orderBy?: { seq: "asc" | "desc" }; take?: number }) =>
          query(messages, args),
      ),
      // A message in bot-1's own chat.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = messages.find((said) => said.id === where.id);
        return found
          ? { ...found, thread: { spaceId: "space-1", bot: { userId: "user-1" } } }
          : null;
      }),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "bot-1"
          ? { name: "Ada", memoryScope: options.memoryScope ?? null, userId: "user-1" }
          : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const bea = { id: "bot-2", name: "Bea", spaceId: "space-1", userId: "user-1" };
        return [bea].filter((bot) => where.id.in.includes(bot.id));
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes("user-2") ? [{ id: "user-2", name: "Sam" }] : [],
      ),
    },
  };
  const deps = {
    jobs: {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      enqueueIn: vi.fn(),
      cancelIn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    },
    prisma: prisma as unknown as PrismaClient,
    memoryProviders: {
      resolve: vi.fn(async () => ({
        provider,
        defaultScope: options.defaultScope ?? ("isolated" as const),
      })),
    },
  };
  return { deps, provider, prisma };
}

const turn = (role: "user" | "assistant", content: string, second: number, speaker?: string) => ({
  role,
  content,
  timestamp: at(second).toISOString(),
  ...(speaker === undefined ? {} : { speaker }),
});

/** Another bot asks bot-1 a question; its words stay attributed to that bot. */
const fromBea = () =>
  harness({
    sourceMessageId: "inbound-1",
    messages: [
      message({
        id: "inbound-1",
        seq: 1,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Bea",
            text: "Can you check the budget?",
            hop: 1,
            intent: "ask",
            returnToMessageId: "outbound-1",
          },
        ],
      }),
      message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "It's on track."),
    ],
  });

describe("retainRunConversation", () => {
  it.each([
    ["large messages", 40, '"\\😀'.repeat(4_000)],
    ["many messages", 400, "A short message."],
  ] as const)(
    "bounds the aggregate direct-chat transcript with %s",
    async (_case, count, content) => {
      const people = Array.from({ length: count }, (_, index) =>
        message({ id: `m-${index}`, seq: index * 2 + 1, role: "user" }, `${index}: ${content}`),
      );
      const replies = Array.from({ length: count }, (_, index) =>
        message(
          { id: `r-${index}`, seq: index * 2 + 2, role: "bot", botId: "bot-1", runId: "run-1" },
          `${index}: ${content}`,
        ),
      );
      const { deps, provider } = harness({
        sourceMessageId: people[0]!.id,
        messages: [...people, ...replies],
      });
      await retainRunConversation(
        deps,
        "run-1",
        people.map((person) => person.id),
      );
      const [request] = provider.retainConversation.mock.calls[0] as unknown as [
        { turns: Array<{ role: string; content: string }> },
      ];
      expect(request.turns.length).toBeLessThanOrEqual(200);
      expect(
        request.turns.reduce((size, turn) => size + turn.content.length, 0),
      ).toBeLessThanOrEqual(32_400);
      expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThan(256_000);
      for (const role of ["user", "assistant"]) {
        expect(
          request.turns.some(
            (turn) => turn.role === role && turn.content.includes(`${count - 1}:`),
          ),
        ).toBe(true);
      }
    },
  );
  it.each([undefined, "", "   "])(
    "refuses to submit without a connection identity: %j",
    async (identity) => {
      const { deps, provider } = harness();
      Object.assign(provider, { connectionIdentity: identity });
      await expect(retainRunConversation(deps, "run-1")).rejects.toThrow(
        "Conversation retention requires a stable connection identity.",
      );
      expect(provider.retainConversation).not.toHaveBeenCalled();
      expect(provider.purgeHistory).not.toHaveBeenCalled();
    },
  );

  it("does not submit any data when durable cleanup cannot be scheduled", async () => {
    const { deps, provider } = harness();
    deps.jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow("queue unavailable");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it("keeps cleanup after losing the submission response, even after group deletion", async () => {
    const { deps, provider, prisma } = harness();
    let stored = false;
    provider.retainConversation.mockImplementationOnce(async () => {
      expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
      // The remote service accepts the write, then the worker loses its response.
      throw new Error("worker stopped before receiving the operation token");
    });
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow("worker stopped");
    const guard = deps.jobs.enqueue.mock.calls[0]![0];
    if (guard.name !== "memory.retain-turn") throw new Error("Wrong cleanup job");
    const recovery = guard.payload.pending!;
    expect(recovery).toEqual({
      unconfirmed: true,
      checks: 0,
      generation: 3,
      connectionIdentity: "connection-1",
      source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
    });
    // Group deletion removes the source run and messages before the remote write lands.
    prisma.run.findUnique.mockResolvedValue(null as never);
    prisma.thread.findUnique.mockResolvedValue(null as never);
    prisma.message.findFirst.mockResolvedValue(null);
    provider.purgeHistory.mockImplementation(async () => {
      stored = false;
      return { ok: true, value: undefined };
    });
    await expect(settleRetainedConversation(deps, "run-1", recovery)).resolves.toEqual({
      settled: false,
    });
    expect(stored).toBe(false);
    stored = true;
    // An earlier successful purge must not stop polling while remote completion is unknown.
    await expect(settleRetainedConversation(deps, "run-1", recovery)).resolves.toEqual({
      settled: false,
    });
    expect(stored).toBe(false);
    expect(provider.purgeHistory).toHaveBeenCalledTimes(2);
    expect(provider.retainedConversationSettled).not.toHaveBeenCalled();
    expect(prisma.run.findUnique).toHaveBeenCalledTimes(1);
  });

  it("preserves the pre-submit guard when the token handoff fails and the retry finds a clear", async () => {
    const { deps, provider, prisma } = harness();
    const durable = new Map<string, BackgroundJob>();
    deps.jobs.enqueue.mockImplementation(async (job) => {
      durable.set(job.replaceKey!, job);
    });
    provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
    const retained = await retainRunConversation(deps, "run-1");
    const key = "memory.retain-turn:run-1:recover";
    const guard = durable.get(key)!;
    expect(guard.replaceKey).not.toBe(memoryRetainTurnJob("run-1").replaceKey);
    deps.jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable after submit"));
    await expect(
      deps.jobs.enqueue(
        memoryRetainTurnJob("run-1", [], {
          pending: { ...retained.pending!, checks: 0 },
        }),
      ),
    ).rejects.toThrow("queue unavailable after submit");
    prisma.message.findFirst.mockResolvedValue(null);
    await expect(retainRunConversation(deps, "run-1")).resolves.toEqual({});
    expect(durable.get(key)).toBe(guard);
    expect(provider.retainConversation).toHaveBeenCalledOnce();
    prisma.thread.findUnique.mockResolvedValue(null as never);
    if (guard.name !== "memory.retain-turn") throw new Error("Wrong cleanup job");
    await expect(
      settleRetainedConversation(deps, "run-1", guard.payload.pending!),
    ).resolves.toEqual({ settled: false });
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.objectContaining({ spaceId: "space-1" }),
    );
  });

  it("does not clean up an unconfirmed submission through a replacement connection", async () => {
    const { deps, provider, prisma } = harness();
    provider.retainConversation.mockRejectedValueOnce(new Error("lost response"));
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow("lost response");
    const guard = deps.jobs.enqueue.mock.calls[0]![0];
    if (guard.name !== "memory.retain-turn") throw new Error("Wrong cleanup job");
    Object.assign(provider, { connectionIdentity: "replacement-connection" });
    prisma.thread.findUnique.mockResolvedValue(null as never);
    await expect(
      settleRetainedConversation(deps, "run-1", guard.payload.pending!),
    ).resolves.toEqual({ settled: true });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("checks only local thread state for unconfirmed writes until cleanup is needed", async () => {
    const { deps, provider, prisma } = harness();
    provider.retainConversation.mockRejectedValueOnce(new Error("lost response"));
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow("lost response");
    const guard = deps.jobs.enqueue.mock.calls[0]![0];
    if (guard.name !== "memory.retain-turn") throw new Error("Wrong cleanup job");
    vi.mocked(deps.memoryProviders.resolve).mockClear();
    await expect(
      settleRetainedConversation(deps, "run-1", guard.payload.pending!),
    ).resolves.toEqual({ settled: false });
    expect(deps.memoryProviders.resolve).not.toHaveBeenCalled();
    expect(provider.retainedConversationSettled).not.toHaveBeenCalled();
    expect(provider.purgeHistory).not.toHaveBeenCalled();
    prisma.thread.findUnique.mockResolvedValue(null as never);
    await expect(
      settleRetainedConversation(deps, "run-1", guard.payload.pending!),
    ).resolves.toEqual({ settled: false });
    expect(deps.memoryProviders.resolve).toHaveBeenCalledOnce();
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.objectContaining({ spaceId: "space-1" }),
    );
  });

  it("sends the person's words and the replies with names, scope and generation", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      {
        botId: "bot-1",
        botName: "Ada",
        userName: "Sam",
        scope: "isolated",
        threadId: "thread-1",
        conversation: "direct",
        generation: 3,
        runId: "run-1",
        turns: [
          turn("user", "I'm moving to Lisbon.", 1),
          turn("assistant", "Which month?\n\nNoted.", 6),
        ],
      },
      expect.objectContaining({ spaceId: "space-1", runId: "run-1" }),
    );
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("includes what the person added while the run worked, in order", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1", ["message-1", "steer-1", "elsewhere"]);
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "I'm moving to Lisbon.", 1),
          turn("assistant", "Which month?", 2),
          turn("user", "April.", 5),
          turn("assistant", "Noted.", 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("learns completed replies as data rather than discarding outside-derived knowledge", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1", ["steer-1"]);
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "I'm moving to Lisbon.", 1),
          turn("assistant", "Which month?", 2),
          turn("user", "April.", 5),
          turn("assistant", "Noted.", 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("does not retain a turn before the bot has replied", async () => {
    const { deps, provider } = harness({
      messages: directMessages.filter((said) => said.role === "user"),
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it.each([
    ["the bot's own scope", { memoryScope: "shared" }],
    ["the Space default", { defaultScope: "shared" as const }],
  ])("passes a shared scope from %s", async (_case, change) => {
    const { deps, provider } = harness(change);
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "shared" }),
      expect.any(Object),
    );
  });

  it("sends a message from another of the owner's bots under that bot's name", async () => {
    const { deps, provider } = fromBea();
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Can you check the budget?", 1, "Bea"),
          turn("assistant", "It's on track.", 2),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps group replies with outside or unknown provenance as data", async () => {
    const bea = { role: "bot", botId: "bot-2" };
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "b-1", seq: 1, ...bea, runId: "run-2" }, "A finding from a page."),
        message({ id: "b-2", seq: 2, ...bea }, "An imported note."),
        message({ id: "source", seq: 3, role: "user" }, "What did you find?"),
        message(
          { id: "r-4", seq: 4, role: "bot", botId: "bot-1", runId: "run-1" },
          "Here is the finding.",
        ),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "A finding from a page.\n\nAn imported note.", 2, "Bea"),
          turn("user", "What did you find?", 3),
          turn("assistant", "Here is the finding.", 4),
        ],
      }),
      expect.any(Object),
    );
  });

  it("refuses retention when a run and its thread belong to different Spaces", async () => {
    const { deps, prisma, provider } = harness();
    prisma.thread.findUnique.mockResolvedValueOnce({
      botId: "bot-1",
      groupId: null,
      spaceId: "space-2",
      historyCompactionGeneration: 3,
    } as never);
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it("attributes source and steering messages to their own authors", async () => {
    const { deps, prisma, provider } = harness({
      messages: directMessages.map((message) =>
        message.id === "steer-1" ? { ...message, authorUserId: "user-3" } : message,
      ),
    });
    prisma.user.findMany.mockImplementation(async ({ where }) =>
      [
        { id: "user-2", name: "Sam" },
        { id: "user-3", name: "Riley" },
      ].filter((user) => where.id.in.includes(user.id)),
    );
    await retainRunConversation(deps, "run-1", ["steer-1"]);
    const [request] = provider.retainConversation.mock.calls[0] as unknown as [
      { turns: { content: string; speaker?: string }[] },
    ];
    expect(request.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "I'm moving to Lisbon.", speaker: "Sam" }),
        expect.objectContaining({ content: "April.", speaker: "Riley" }),
      ]),
    );
  });

  it("sends what a group chat said since the bot's previous reply", async () => {
    const own = { role: "bot", botId: "bot-1" };
    const bea = { role: "bot", botId: "bot-2" };
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "old", seq: 4, role: "user" }, "Old news."),
        message({ id: "prev", seq: 5, ...own, runId: "run-0" }, "Earlier reply."),
        message({ id: "hi", seq: 6, role: "user", authorUserId: "user-3" }, "Hi all."),
        message({ id: "b-7", seq: 7, ...bea, runId: "run-2" }, "I'm booking the room."),
        message(
          { id: "b-8", seq: 8, ...bea, runId: "run-2", clientNonce: "partial-reply:run-2" },
          "Cut o",
        ),
        message({ id: "b-9", seq: 9, ...bea, runId: "run-2" }, "Room is booked."),
        message({ id: "sys", seq: 10, role: "system" }, "Bea joined."),
        message(
          { id: "source", seq: 11, role: "user", authorUserId: "user-2" },
          "Ada, what's for lunch?",
        ),
        message(
          { id: "p-12", seq: 12, ...own, runId: "run-1", clientNonce: "user-progress:run-1:1" },
          "Looking at menus…",
        ),
        message({ id: "r-13", seq: 13, ...own, runId: "run-1" }, "Pasta."),
        message({ id: "late", seq: 14, role: "user" }, "Thanks!"),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        userName: "Sam",
        conversation: "group",
        turns: [
          turn("user", "Hi all.", 6, "another person"),
          turn("user", "I'm booking the room.\n\nRoom is booked.", 9, "Bea"),
          turn("user", "Ada, what's for lunch?", 11, "Sam"),
          turn("assistant", "Pasta.", 13),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps the source conversation when progress rows exceed the group window", async () => {
    const own = { role: "bot", botId: "bot-1", runId: "run-1" };
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "source", seq: 1, role: "user" }, "Remember the launch date."),
        ...Array.from({ length: 220 }, (_, index) =>
          message(
            {
              id: `progress-${index}`,
              seq: index + 2,
              ...own,
              clientNonce:
                index % 2 ? `partial-reply:run-1:${index}` : `user-progress:run-1:${index}`,
            },
            "Working…",
          ),
        ),
        message({ id: "final", seq: 222, ...own }, "The launch is in April."),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Remember the launch date.", 1),
          turn("assistant", "The launch is in April.", 222),
        ],
      }),
      expect.any(Object),
    );
  });

  it("skips a group turn whose thread was cleared", async () => {
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "gone",
      messages: [message({ id: "r-1", seq: 1, role: "bot", botId: "bot-1", runId: "run-1" }, "Hi")],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it("cuts an oversized group message and keeps the newest that fit the window", async () => {
    const cut = (letter: string) => `${letter.repeat(8_000)} […]`;
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "e",
      messages: [
        ...["a", "b", "c", "d", "e"].map((letter, index) =>
          message(
            { id: letter, seq: index + 1, role: "user", authorUserId: "user-1" },
            letter.repeat(9_000),
          ),
        ),
        message({ id: "r-6", seq: 6, role: "bot", botId: "bot-1", runId: "run-1" }, "Done."),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", [cut("c"), cut("d"), cut("e")].join("\n\n"), 5),
          turn("assistant", "Done.", 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps same-name humans and bots in separate turns", async () => {
    const { deps, prisma, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "a",
      messages: [
        message({ id: "a", seq: 1, role: "user", authorUserId: "user-1" }, "First person's fact."),
        message({ id: "b", seq: 2, role: "user", authorUserId: "user-2" }, "Second person's fact."),
        message({ id: "c", seq: 3, role: "bot", botId: "bot-2" }, "Another bot's fact."),
        message({ id: "d", seq: 4, role: "bot", botId: "bot-1", runId: "run-1" }, "Noted."),
      ],
    });
    prisma.user.findMany.mockResolvedValue([
      { id: "user-1", name: "Sam" },
      { id: "user-2", name: "Sam" },
    ]);
    prisma.bot.findMany.mockResolvedValue([
      { id: "bot-2", name: "Sam", spaceId: "space-1", userId: "user-1" },
    ]);
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "First person's fact.", 1, "Sam"),
          turn("user", "Second person's fact.", 2, "Sam"),
          turn("user", "Another bot's fact.", 3, "Sam"),
          turn("assistant", "Noted.", 4),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps what people said in a group turn with long replies, dropping the oldest replies", async () => {
    const long = (letter: string) => letter.repeat(8_000);
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "source", seq: 1, role: "user" }, "Ada, draft all five sections."),
        ...["p", "q", "r", "s", "t"].map((letter, index) =>
          message(
            { id: `r-${index + 2}`, seq: index + 2, role: "bot", botId: "bot-1", runId: "run-1" },
            long(letter),
          ),
        ),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Ada, draft all five sections.", 1),
          turn("assistant", [long("s"), long("t")].join("\n\n"), 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("never splits a surrogate pair when cutting a group message", async () => {
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "s",
      messages: [
        message({ id: "s", seq: 1, role: "user" }, `${"x".repeat(7_999)}😀tail`),
        message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "Ok."),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [turn("user", `${"x".repeat(7_999)} […]`, 1), turn("assistant", "Ok.", 2)],
      }),
      expect.any(Object),
    );
  });

  it("purges the turn again when the thread was cleared during the retain", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    await retainRunConversation(deps, "run-1");
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("hands back the stored generation when the purge after a clear fails, so it runs again", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    provider.purgeHistory.mockResolvedValueOnce({ ok: false, error: "memory request failed: 503" });
    await expect(retainRunConversation(deps, "run-1")).resolves.toEqual({
      pending: {
        connectionIdentity: "connection-1",
        generation: 3,
        source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
      },
    });
  });

  it("hands back a turn still being stored without purging yet", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
    await expect(retainRunConversation(deps, "run-1")).resolves.toEqual({
      pending: {
        connectionIdentity: "connection-1",
        token: "op-1",
        generation: 3,
        source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
      },
    });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("fails the job so it retries when the provider refuses the turn", async () => {
    const { deps, provider } = harness();
    provider.retainConversation.mockResolvedValueOnce({
      ok: false,
      error: "memory request failed: 503",
    });
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow(
      "memory request failed: 503",
    );
    // A refused shared submission can still have written to its own bank.
    expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
    const guard = deps.jobs.enqueue.mock.calls[0]![0];
    if (guard.name !== "memory.retain-turn") throw new Error("Wrong cleanup job");
    expect(guard.payload.pending).toMatchObject({ unconfirmed: true });
    expect(deps.jobs.cancel).not.toHaveBeenCalled();
  });
});

describe("settleRetainedConversation", () => {
  it.each([false, true])(
    "purges a late write after its bot is deleted from a surviving group (unconfirmed=%s)",
    async (unconfirmed) => {
      const { deps, provider, prisma } = harness({ groupId: "group-1" });
      provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
      const retained = await retainRunConversation(deps, "run-1");
      prisma.bot.findUnique.mockResolvedValue(null);
      const pending = unconfirmed
        ? { ...retained.pending!, token: undefined, unconfirmed: true as const }
        : retained.pending!;
      await expect(settleRetainedConversation(deps, "run-1", pending)).resolves.toEqual({
        settled: !unconfirmed,
      });
      expect(provider.purgeHistory).toHaveBeenCalledWith(
        { botId: "bot-1", threadId: "thread-1", generations: [3] },
        expect.objectContaining({ spaceId: "space-1", botId: "bot-1" }),
      );
    },
  );
  const pending = {
    token: "op-1",
    generation: 3,
    connectionIdentity: "connection-1",
    source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
  };

  it("purges a late turn after deleting the group has removed its run", async () => {
    const { deps, prisma, provider } = harness();
    Object.assign(provider, { connectionIdentity: "accepting-connection" });
    provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
    const retained = await retainRunConversation(deps, "run-1");
    expect(retained.pending?.connectionIdentity).toBe("accepting-connection");
    prisma.run.findUnique.mockResolvedValueOnce(null as never);
    prisma.thread.findUnique.mockResolvedValueOnce(null as never);
    await settleRetainedConversation(deps, "run-1", retained.pending!);
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
  });

  it.each(["disconnected", "replaced"])(
    "does not send old operations to a %s connection",
    async (change) => {
      const { deps, provider } = harness();
      Object.assign(provider, { connectionIdentity: "accepting-connection" });
      provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
      const retained = await retainRunConversation(deps, "run-1");
      deps.memoryProviders.resolve.mockResolvedValueOnce(
        change === "disconnected"
          ? (null as never)
          : {
              provider: { ...provider, connectionIdentity: "replacement-connection" },
              defaultScope: "isolated",
            },
      );
      await expect(settleRetainedConversation(deps, "run-1", retained.pending!)).resolves.toEqual({
        settled: true,
      });
      expect(provider.retainedConversationSettled).not.toHaveBeenCalled();
      expect(provider.purgeHistory).not.toHaveBeenCalled();
    },
  );

  it("keeps waiting while the provider is still storing the turn", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.retainedConversationSettled.mockResolvedValueOnce({
      ok: true,
      value: { settled: false },
    });
    await expect(settleRetainedConversation(deps, "run-1", pending)).resolves.toEqual({
      settled: false,
    });
    expect(provider.retainedConversationSettled).toHaveBeenCalledWith("op-1", expect.any(Object));
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("leaves a settled turn alone when the thread was not cleared", async () => {
    const { deps, provider } = harness({ generations: [3] });
    await expect(settleRetainedConversation(deps, "run-1", pending)).resolves.toEqual({
      settled: true,
    });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["was cleared", { generations: [4], messages: [] }],
    ["is gone", { threadGone: true, messages: [] }],
  ])("purges a settled turn whose thread %s meanwhile", async (_case, change) => {
    const { deps, provider } = harness(change);
    await settleRetainedConversation(deps, "run-1", pending);
    expect(provider.retainConversation).not.toHaveBeenCalled();
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("purges a stored turn without asking the provider when there is no token", async () => {
    const { deps, provider } = harness({ generations: [4] });
    await expect(
      settleRetainedConversation(deps, "run-1", {
        generation: 3,
        connectionIdentity: "connection-1",
        source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
      }),
    ).resolves.toEqual({
      settled: true,
    });
    expect(provider.retainedConversationSettled).not.toHaveBeenCalled();
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("fails the job so it retries when the purge after a clear fails", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.purgeHistory.mockResolvedValueOnce({ ok: false, error: "memory request failed: 503" });
    await expect(settleRetainedConversation(deps, "run-1", pending)).rejects.toThrow(
      "memory request failed: 503",
    );
  });
});

describe("abandonRetainedConversation", () => {
  it("purges the turn's generation once more when its chat was cleared", async () => {
    const { deps, provider } = harness({ generations: [4] });
    await abandonRetainedConversation(deps, "run-1", {
      generation: 3,
      connectionIdentity: "connection-1",
      source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
    });
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("leaves the turn alone when its chat was not cleared", async () => {
    const { deps, provider } = harness({ generations: [3] });
    await abandonRetainedConversation(deps, "run-1", {
      generation: 3,
      connectionIdentity: "connection-1",
      source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
    });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("never fails: nothing checks again after giving up", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.purgeHistory.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      abandonRetainedConversation(deps, "run-1", {
        generation: 3,
        connectionIdentity: "connection-1",
        source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
      }),
    ).resolves.toBeUndefined();
  });
});
