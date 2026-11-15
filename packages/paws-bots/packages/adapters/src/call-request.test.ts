import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  callRequestRefusal,
  newCallRequest,
  reconcileCallRequests,
  requestUserCall,
  settleCallRequest,
} from "./call-request.js";

function prismaWith(options: {
  voice?: boolean;
  recent?: boolean;
  status?: string;
  updated?: number;
  expiresAt?: string;
}) {
  const blocks = [
    {
      kind: "call_request",
      callId: "call-1",
      reason: "Send the report",
      opening: "Hi, it's about the report.",
      status: options.status ?? "ringing",
      expiresAt: options.expiresAt ?? new Date(Date.now() + 45_000).toISOString(),
    },
  ];
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 0 })) },
    userVoiceCredential: {
      findFirst: vi.fn(async () => (options.voice === false ? null : { id: "voice-1" })),
    },
    message: {
      findFirst: vi.fn(async () => (options.recent ? { id: "earlier" } : null)),
      findUnique: vi.fn(async () => ({
        id: "message-1",
        blocks,
        botId: "bot-1",
        thread: { spaceId: "space-1", userId: "user-1", bot: { name: "Caller" } },
      })),
      updateMany: vi.fn(async () => ({ count: options.updated ?? 1 })),
    },
  };
  return {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient & {
    event: { create: ReturnType<typeof vi.fn> };
    message: { updateMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  };
}

describe("call_user", () => {
  it("only rings a one-to-one chat with a voice provider, once per cooldown", async () => {
    const input = { userId: "user-1", threadId: "thread-1", groupChat: false };
    await expect(callRequestRefusal(prismaWith({}), input)).resolves.toBeNull();
    await expect(
      callRequestRefusal(prismaWith({}), { ...input, groupChat: true }),
    ).resolves.toMatch(/one-to-one/);
    await expect(callRequestRefusal(prismaWith({ voice: false }), input)).resolves.toMatch(
      /voice provider/,
    );
    await expect(callRequestRefusal(prismaWith({ recent: true }), input)).resolves.toMatch(
      /last 2 minutes/,
    );
  });

  it("limits calls across every chat owned by the recipient", async () => {
    const prisma = prismaWith({});
    await callRequestRefusal(prisma, {
      userId: "user-1",
      groupChat: false,
      now: Date.parse("2026-10-14T18:30:00Z"),
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: { userId: "user-1" },
          clientNonce: { startsWith: "call:", endsWith: ":request" },
          createdAt: { gt: new Date("2026-10-14T18:28:00Z") },
        }),
      }),
    );
  });

  it.each([1, 5])(
    "uses the configured %i minute cooldown in the query and refusal",
    async (minutes) => {
      const prisma = prismaWith({ recent: true });
      const now = Date.parse("2026-10-14T18:30:00Z");
      await expect(
        callRequestRefusal(prisma, {
          userId: "user-1",
          groupChat: false,
          now,
          phoneCallCooldownMinutes: minutes,
        }),
      ).resolves.toContain(`last ${minutes} ${minutes === 1 ? "minute." : "minutes."}`);
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gt: new Date(now - minutes * 60_000) } }),
        }),
      );
    },
  );

  it("builds a ringing request that expires after the ring window", () => {
    const request = newCallRequest({
      reason: "  Send the report  ",
      opening: "Hi!",
      now: Date.parse("2026-10-14T18:30:00Z"),
    });
    if ("error" in request) throw new Error(request.error);
    expect(request.clientNonce).toBe(`call:${request.callId}:request`);
    expect(request.expiresAt.toISOString()).toBe("2026-10-14T18:30:45.000Z");
    expect(request.blocks).toEqual([
      expect.objectContaining({
        kind: "call_request",
        reason: "Send the report",
        status: "ringing",
      }),
    ]);
    expect(newCallRequest({ reason: "", opening: "Hi" })).toEqual({ error: "reason is required." });
  });

  it("does not split an emoji when it shortens the reason or opening", () => {
    const request = newCallRequest({
      reason: `${"r".repeat(119)}😀tail`,
      opening: `${"o".repeat(239)}😀tail`,
    });
    if ("error" in request) throw new Error(request.error);
    const block = request.blocks[0] as { reason: string; opening: string };
    expect(block.reason).toBe("r".repeat(119));
    expect(block.opening).toBe("o".repeat(239));
  });
});

describe("settleCallRequest", () => {
  it("moves a ringing call on and tells the thread", async () => {
    const prisma = prismaWith({});
    const events = { notify: vi.fn(async () => undefined) };
    const settled = await settleCallRequest(
      { prisma, events },
      { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
    );

    expect(vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prisma.message.findUnique).mock.invocationCallOrder[0]!,
    );
    expect(settled).toMatchObject({ status: "answered", opening: "Hi, it's about the report." });
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.updated",
          botId: "bot-1",
          payload: expect.objectContaining({ messageId: "message-1", callId: "call-1" }),
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });

  it("keeps a committed answer recoverable when notification fails", async () => {
    const prisma = prismaWith({});
    const events = { notify: vi.fn().mockRejectedValue(new Error("offline")) };
    await expect(
      settleCallRequest(
        { prisma, events },
        {
          threadId: "thread-1",
          callId: "call-1",
          from: ["ringing"],
          status: "answered",
        },
      ),
    ).resolves.toMatchObject({ status: "answered" });
    expect(events.notify).toHaveBeenCalledWith("thread-1", 0);
  });

  it("leaves a call that already moved on alone", async () => {
    const events = { notify: vi.fn(async () => undefined) };
    await expect(
      settleCallRequest(
        { prisma: prismaWith({ status: "missed" }), events },
        { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
      ),
    ).resolves.toBeNull();
    expect(events.notify).not.toHaveBeenCalled();
  });

  it("settles once when two devices race", async () => {
    const events = { notify: vi.fn(async () => undefined) };
    await expect(
      settleCallRequest(
        { prisma: prismaWith({ updated: 0 }), events },
        { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
      ),
    ).resolves.toBeNull();
    expect(events.notify).not.toHaveBeenCalled();
  });

  it("stops the ring on other devices unless the call already rang out", async () => {
    const incomingCall = vi.fn(async () => undefined);
    const events = { notify: vi.fn(async () => undefined) };
    await settleCallRequest(
      {
        prisma: prismaWith({}),
        events,
        notifications: { describe: vi.fn(), send: vi.fn(), incomingCall },
      },
      { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "declined" },
    );
    expect(incomingCall).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ callId: "call-1", botName: "Caller", ended: true }),
    );
    incomingCall.mockClear();
    await settleCallRequest(
      {
        prisma: prismaWith({ expiresAt: new Date(0).toISOString() }),
        events,
        notifications: { describe: vi.fn(), send: vi.fn(), incomingCall },
      },
      { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "declined" },
    );
    expect(incomingCall).not.toHaveBeenCalled();
  });

  it("records how long an answered call lasted", async () => {
    const prisma = prismaWith({ status: "answered" });
    await settleCallRequest(
      { prisma, events: { notify: vi.fn(async () => undefined) } },
      { threadId: "thread-1", callId: "call-1", from: ["answered"], durationSeconds: 42 },
    );
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocks: [expect.objectContaining({ status: "answered", durationSeconds: 42 })] },
      }),
    );
  });
});

describe("requestUserCall security", () => {
  const run = {
    id: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    botId: "bot-1",
  };
  const input = { reason: "Review the report", opening: "Can we review it?" };
  function fixture() {
    let saved: { id: string; blocks: unknown; botId: string; thread: { spaceId: string } } | null =
      null;
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      thread: {
        findFirst: vi.fn(
          async (): Promise<{ bot: { name: string } } | null> => ({ bot: { name: "Caller" } }),
        ),

        update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      userVoiceCredential: { findFirst: vi.fn(async () => ({ id: "voice-1" })) },
      message: {
        findFirst: vi.fn(async () => saved),
        create: vi.fn(async ({ data }: { data: { blocks: unknown } }) => {
          saved = {
            id: "message-1",
            blocks: data.blocks,
            botId: run.botId,
            thread: { spaceId: run.spaceId },
          };
          return saved;
        }),
        findUnique: vi.fn(async () => saved),
        updateMany: vi.fn(async ({ data }: { data: { blocks: unknown } }) => {
          if (saved) saved.blocks = data.blocks;
          return { count: 1 };
        }),
      },
      event: { create: vi.fn(async () => ({ seq: 0 })) },
    };
    let tail = Promise.resolve();
    const prisma = {
      ...tx,
      $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => {
        const result = tail.then(() => fn(tx));
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      phoneCallsEnabled: true,
      events: { append: vi.fn(), notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        enqueueIn: vi.fn(),
        cancelIn: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn(),
      },
    };
    return { deps, tx, saved: () => saved };
  }

  it("pushes only the persisted call owner's minimal ringing request after scheduling expiry", async () => {
    const { deps, saved } = fixture();
    const incomingCall = vi.fn(async (_userId: string, _call: unknown) => {
      expect(deps.jobs.enqueue).toHaveBeenCalled();
    });
    const notifications = {
      incomingCall,
      send: vi.fn(),
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { push: true, email: false },
      }),
    };
    await requestUserCall({ ...deps, notifications }, run, input);
    const block = (saved()!.blocks as { callId: string; expiresAt: string }[])[0]!;
    expect(incomingCall).toHaveBeenCalledWith(run.userId, {
      callId: block.callId,
      botId: run.botId,
      botName: "Caller",
      expiresAt: block.expiresAt,
    });
    incomingCall.mockClear();
    await requestUserCall({ ...deps, notifications }, run, input);
    expect(incomingCall).not.toHaveBeenCalled();
  });

  it("forwards the first-response winner for a call request card", async () => {
    const { deps } = fixture();
    await requestUserCall(deps, run, input);
    expect(deps.events.notify).toHaveBeenCalledWith(run.threadId, 0, run.id);
  });

  it("passes configured durations to the persisted request and recipient cooldown", async () => {
    const { deps, tx, saved } = fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await requestUserCall(
        { ...deps, phoneCallRingSeconds: 90, phoneCallCooldownMinutes: 1 },
        run,
        input,
      );
      expect(saved()?.blocks).toEqual([
        expect.objectContaining({ expiresAt: new Date(now + 90_000).toISOString() }),
      ]);
      expect(tx.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gt: new Date(now - 60_000) } }),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not ring from an attempt a newer claim superseded", async () => {
    const { deps, tx, saved } = fixture();
    tx.run.findUnique.mockResolvedValue({
      status: "running",
      leaseOwner: "worker-2",
      leaseFence: 2,
    } as never);
    await expect(
      requestUserCall(
        { ...deps, runLease: { runId: run.id, owner: "worker-1", fence: 1 } },
        run,
        input,
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(saved()).toBeNull();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does no work while disabled", async () => {
    const { deps } = fixture();
    expect(await requestUserCall({ ...deps, phoneCallsEnabled: false }, run, input)).toHaveProperty(
      "error",
    );
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["userId", "spaceId", "botId", "threadId"] as const)(
    "rejects a mismatched %s",
    async (key) => {
      const { deps, tx } = fixture();
      tx.thread.findFirst.mockResolvedValueOnce(null);
      expect(await requestUserCall(deps, { ...run, [key]: "other" }, input)).toHaveProperty(
        "error",
      );
      expect(tx.thread.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: key === "threadId" ? "other" : run.threadId,
            userId: key === "userId" ? "other" : run.userId,
            spaceId: key === "spaceId" ? "other" : run.spaceId,
            botId: key === "botId" ? "other" : run.botId,
            groupId: null,
            externalConversationId: null,
            bot: expect.objectContaining({ userId: key === "userId" ? "other" : run.userId }),
          }),
        }),
      );
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it("allows only one concurrent ring across a recipient's bots", async () => {
    const { deps, tx } = fixture();
    const results = await Promise.all([
      requestUserCall(deps, run, input),
      requestUserCall(deps, { ...run, botId: "bot-2", threadId: "thread-2" }, input),
    ]);
    expect(results.filter((result) => "ok" in result)).toHaveLength(1);
    expect(tx.message.create).toHaveBeenCalledOnce();
    // The ring lock, once per attempt; the rest set and restore the unread mark's system context.
    expect(
      tx.$queryRaw.mock.calls.filter((call) =>
        ((call as unknown[])[0] as TemplateStringsArray).join("?").includes("pg_advisory"),
      ),
    ).toHaveLength(2);
    expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("settles missed when expiry cannot be enqueued", async () => {
    const { deps, saved } = fixture();
    deps.jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    expect(await requestUserCall(deps, run, input)).toHaveProperty("error");
    expect(saved()?.blocks).toEqual([expect.objectContaining({ status: "missed" })]);
  });

  it("restores expiry jobs from persisted ringing requests", async () => {
    const enqueue = vi.fn();
    const prisma = {
      message: {
        findMany: vi.fn(async () => [
          {
            threadId: "thread-1",
            blocks: [
              {
                kind: "call_request",
                callId: "call-1",
                status: "ringing",
                expiresAt: "2026-10-14T18:30:45Z",
              },
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;
    await reconcileCallRequests({ prisma, jobs: { enqueue } as never });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "call.expire",
        payload: { threadId: "thread-1", callId: "call-1" },
      }),
    );
  });
});
