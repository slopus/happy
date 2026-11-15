import type { JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { STUCK_WORK_NOTICE, stuckWorkStatusMessage } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "./expo-push.js";
import { createJobReconciler } from "./job-reconciler.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";
import { reconcileStuckWork, STUCK_NOTICE_CLAIM_TTL_MS } from "./stuck-work.js";

const now = new Date("2026-09-28T16:00:00.000Z");
const budget = { timeout: 20_000 };

afterEach(async () => {
  vi.unstubAllGlobals();
});

function age(hours: number) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function candidate(status: "queued" | "waiting_input" | "waiting_takeover", hours: number) {
  return {
    id: `run-${status}`,
    status,
    updatedAt: age(hours),
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    userId: "user-1",
    taskId: "task-1",
    bot: { name: "Ada", color: "blue", avatarSet: "organic", notifyOnFinish: true },
    thread: { groupId: null as string | null },
  };
}

function publisher() {
  const enqueue = vi.fn(async () => undefined);
  const jobs: JobPublisher = {
    enqueue,
    enqueueIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function notifications() {
  const send = vi.fn(async () => undefined);
  return { provider: { send } as unknown as NotificationProvider, send };
}

describe("reconcileStuckWork", () => {
  it("ignores a young queue and a row the scan cannot classify", async () => {
    const eventFindMany = vi.fn(async () => []);
    const prisma = {
      run: {
        findMany: vi.fn(async () => [
          candidate("queued", 1),
          { id: "partial", updatedAt: age(30) },
        ]),
      },
      event: { findMany: eventFindMany },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();

    await reconcileStuckWork({ prisma, jobs, now, batchSize: 100 });

    expect(eventFindMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reminds once for a question that has been waiting for hours", async () => {
    const run = candidate("waiting_input", 5);
    const stamps: Array<{ runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();
    const publishChatAlert = vi.fn(async () => undefined);
    const events = { publishChatAlert } as unknown as ThreadEvents;

    await reconcileStuckWork({
      prisma,
      jobs,
      events,
      notifications: provider,
      now,
      batchSize: 100,
    });
    await reconcileStuckWork({
      prisma,
      jobs,
      events,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(publishChatAlert).toHaveBeenCalledTimes(1);
    expect(publishChatAlert).toHaveBeenCalledWith("user-1", {
      kind: "help",
      title: "Ada still needs an answer",
      body: "This has been waiting on you.",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      {
        kind: "help",
        title: "Ada still needs an answer",
        body: "This has been waiting on you.",
        botId: "bot-1",
        threadId: "thread-1",
        sender: expect.objectContaining({ botId: "bot-1", name: "Ada" }),
      },
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
    expect(stamps).toEqual([
      expect.objectContaining({
        runId: run.id,
        payload: {
          notice: STUCK_WORK_NOTICE,
          updatedAt: run.updatedAt.toISOString(),
          state: "delivered",
        },
      }),
    ]);
    // The claim and the delivered stamp lock the thread row behind snapshot reads.
    expect(prisma.$transaction.mock.calls.map(([, options]) => options)).toEqual([budget, budget]);
  });

  it("does not send again when this episode was already reminded", async () => {
    const run = candidate("waiting_input", 5);
    const stamps = [
      {
        runId: run.id,
        payload: { notice: STUCK_WORK_NOTICE, updatedAt: run.updatedAt.toISOString() },
      },
    ];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(send).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not stamp a skipped reminder, so enabling notices later still sends", async () => {
    const run = candidate("queued", 5);
    run.bot.notifyOnFinish = false;
    const stamps: Array<{ runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(stamps).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    run.bot.notifyOnFinish = true;
    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(stamps).toHaveLength(1);
  });

  it("does not stamp a reminder until Expo has a token to deliver it", async () => {
    const tokens = new MemoryPushTokenStore();
    const run = candidate("waiting_input", 5);
    const stamps: Array<{ runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const push = new ExpoPushProvider(tokens);

    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });

    expect(stamps).toHaveLength(0);

    await tokens.save(run.userId, "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { status: "ok", id: "ticket" } })),
    );
    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });

    expect(stamps).toEqual([
      expect.objectContaining({
        runId: run.id,
        payload: {
          notice: STUCK_WORK_NOTICE,
          updatedAt: run.updatedAt.toISOString(),
          state: "delivered",
        },
      }),
    ]);
  });

  it("drops the claim when the token is removed before Expo accepts the push", async () => {
    const tokens = new MemoryPushTokenStore();
    const run = candidate("waiting_input", 5);
    const stamps: Array<{ id?: string; runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const push = new ExpoPushProvider(tokens);
    await tokens.save(run.userId, "ExponentPushToken[test]");
    const fetchMock = vi.fn(async () => Response.json({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const hasPushRecipient = push.hasPushRecipient.bind(push);
    push.hasPushRecipient = async (userId) => {
      const registered = await hasPushRecipient(userId);
      if (registered) await tokens.remove(userId);
      return registered;
    };

    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stamps).toHaveLength(0);

    await tokens.save(run.userId, "ExponentPushToken[later]");
    push.hasPushRecipient = hasPushRecipient;
    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stamps).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ state: "delivered" }),
      }),
    ]);
  });

  it("stops reminding once Expo reports the device unregistered", async () => {
    const tokens = new MemoryPushTokenStore();
    const run = candidate("waiting_input", 5);
    const stamps: Array<{ runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const push = new ExpoPushProvider(tokens);
    await tokens.save(run.userId, "ExponentPushToken[gone]");
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });
    await reconcileStuckWork({ prisma, jobs, notifications: push, now, batchSize: 100 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stamps).toHaveLength(0);
    await expect(push.hasPushRecipient(run.userId)).resolves.toBe(false);
  });

  it("retries a pending reminder left behind when the worker stops", async () => {
    const run = candidate("waiting_input", 5);
    const otherEpisode = {
      id: "event-other-episode",
      runId: run.id,
      payload: {
        notice: STUCK_WORK_NOTICE,
        updatedAt: new Date(run.updatedAt.getTime() - 60_000).toISOString(),
        state: "pending",
        claimedAt: now.toISOString(),
      },
    };
    const expectedOtherEpisode = structuredClone(otherEpisode);
    const stamps = [
      {
        runId: run.id,
        payload: {
          notice: STUCK_WORK_NOTICE,
          updatedAt: run.updatedAt.toISOString(),
          state: "pending",
          claimedAt: new Date(now.getTime() - STUCK_NOTICE_CLAIM_TTL_MS - 1_000).toISOString(),
        },
      },
      otherEpisode,
    ];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(stamps).toEqual([
      expectedOtherEpisode,
      expect.objectContaining({
        payload: {
          notice: STUCK_WORK_NOTICE,
          updatedAt: run.updatedAt.toISOString(),
          state: "delivered",
        },
      }),
    ]);
  });

  it("does not send a second reminder while a claim is still in flight", async () => {
    const run = candidate("waiting_input", 5);
    const pending = {
      runId: run.id,
      payload: {
        notice: STUCK_WORK_NOTICE,
        updatedAt: run.updatedAt.toISOString(),
        state: "pending",
        claimedAt: now.toISOString(),
      },
    };
    const stamps = [pending];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(send).not.toHaveBeenCalled();
    expect(stamps).toEqual([pending]);
  });

  it("retries the four-hour reminder when the push fails", async () => {
    const run = candidate("waiting_input", 5);
    const stamps: Array<{ runId: string | null; payload: unknown }> = [];
    const prisma = noticePrisma(run, stamps);
    const { jobs } = publisher();
    const { provider, send } = notifications();
    send.mockRejectedValueOnce(new Error("push down"));
    const publishChatAlert = vi.fn(async () => undefined);
    const events = { publishChatAlert } as unknown as ThreadEvents;

    await reconcileStuckWork({
      prisma,
      jobs,
      events,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(stamps).toHaveLength(0);
    expect(publishChatAlert).not.toHaveBeenCalled();

    await reconcileStuckWork({
      prisma,
      jobs,
      events,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(publishChatAlert).toHaveBeenCalledTimes(1);
    expect(stamps).toEqual([
      expect.objectContaining({
        runId: run.id,
        payload: {
          notice: STUCK_WORK_NOTICE,
          updatedAt: run.updatedAt.toISOString(),
          state: "delivered",
        },
      }),
    ]);
  });

  it("still reminds a group thread when finish notices are off", async () => {
    const run = candidate("queued", 5);
    run.bot.notifyOnFinish = false;
    run.thread.groupId = "group-1";
    const prisma = noticePrisma(run, []);
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({ prisma, jobs, notifications: provider, now, batchSize: 100 });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "help", title: "Ada is still queued" }),
      expect.anything(),
    );
  });

  it("does not record a reminder when nothing can deliver it", async () => {
    const run = candidate("waiting_input", 5);
    const prisma = noticePrisma(run, []);
    const { jobs } = publisher();

    await reconcileStuckWork({ prisma, jobs, now, batchSize: 100 });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("cancels a day-old queue with a status line and a stopped notice", async () => {
    const run = candidate("queued", 25);
    const client = expireClient(run);
    const { jobs, enqueue } = publisher();
    const { provider, send } = notifications();
    const notify = vi.fn(async () => undefined);

    const cursor = await reconcileStuckWork({
      prisma: client as unknown as PrismaClient,
      jobs,
      events: { notify } as unknown as ThreadEvents,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(cursor).toBeUndefined();
    expect(client.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "system",
        blocks: [{ kind: "meta", text: stuckWorkStatusMessage("queued") }],
      }),
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 8);
    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-next" },
      replaceKey: "run:run-next",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "failure",
        title: "Ada stopped",
        body: stuckWorkStatusMessage("queued"),
      }),
      expect.anything(),
    );
    expect(client.$transaction.mock.calls.map(([, options]) => options)).toEqual([budget]);
  });

  it("alerts open apps when work is cancelled, even without a push provider", async () => {
    const run = { ...candidate("queued", 25), thread: { groupId: "group-1" } };
    const publishChatAlert = vi.fn(async () => undefined);
    const { jobs } = publisher();

    await reconcileStuckWork({
      prisma: expireClient(run) as unknown as PrismaClient,
      jobs,
      events: { notify: vi.fn(async () => undefined), publishChatAlert } as unknown as ThreadEvents,
      now,
      batchSize: 100,
    });

    expect(publishChatAlert).toHaveBeenCalledWith("user-1", {
      kind: "failure",
      title: "Ada stopped",
      body: stuckWorkStatusMessage("queued"),
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      groupId: "group-1",
    });
  });

  it("cancels a takeover nobody acted on after half an hour, without a reminder first", async () => {
    const young = candidate("waiting_takeover", 29 / 60);
    const youngClient = expireClient(young);
    const { jobs } = publisher();
    await reconcileStuckWork({
      prisma: youngClient as unknown as PrismaClient,
      jobs,
      now,
      batchSize: 100,
    });
    expect(youngClient.$transaction).not.toHaveBeenCalled();

    const run = candidate("waiting_takeover", 0.5);
    const client = expireClient(run);
    const { provider, send } = notifications();
    await reconcileStuckWork({
      prisma: client as unknown as PrismaClient,
      jobs,
      events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(client.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "system",
        blocks: [{ kind: "meta", text: stuckWorkStatusMessage("waiting_takeover") }],
      }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failure", title: "Ada stopped" }),
      expect.anything(),
    );
  });

  it("asks only for takeovers past half an hour and other work past the reminder age", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { run: { findMany } } as unknown as PrismaClient;
    const { jobs } = publisher();

    await reconcileStuckWork({ prisma, jobs, now, batchSize: 100 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { status: "queued", updatedAt: { lte: age(4) } },
                { status: "waiting_input", updatedAt: { lte: age(4) } },
                { status: "waiting_takeover", updatedAt: { lte: age(0.5) } },
              ],
            },
          ],
        },
      }),
    );
  });

  it("does not write a status line when the cancel loses the race", async () => {
    const run = candidate("waiting_takeover", 25);
    const client = expireClient(run, { cancelled: 0 });
    const { jobs } = publisher();
    const { provider, send } = notifications();

    await reconcileStuckWork({
      prisma: client as unknown as PrismaClient,
      jobs,
      notifications: provider,
      now,
      batchSize: 100,
    });

    expect(client.message.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps scanning past an already reminded row", async () => {
    const first = candidate("queued", 6);
    const second = { ...candidate("waiting_input", 5), id: "run-next-page" };
    const seen: unknown[] = [];
    const prisma = {
      run: {
        findMany: vi.fn(async (args: { where?: { AND?: unknown[] } }) => {
          seen.push(args.where);
          const paged = JSON.stringify(args.where).includes(first.id);
          return paged ? [second] : [first];
        }),
      },
      event: {
        findMany: vi.fn(async () => [
          {
            runId: first.id,
            payload: { notice: STUCK_WORK_NOTICE, updatedAt: first.updatedAt.toISOString() },
          },
          {
            runId: second.id,
            payload: { notice: STUCK_WORK_NOTICE, updatedAt: second.updatedAt.toISOString() },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const { provider, send } = notifications();

    const cursor = await reconcileStuckWork({
      prisma,
      jobs,
      notifications: provider,
      now,
      batchSize: 1,
    });
    expect(cursor).toEqual({ at: first.updatedAt, id: first.id });
    await reconcileStuckWork({
      prisma,
      jobs,
      notifications: provider,
      now,
      batchSize: 1,
      cursor,
    });

    expect(send).not.toHaveBeenCalled();
    expect(seen[1]).toMatchObject({
      AND: [
        expect.anything(),
        {
          OR: [
            { updatedAt: { gt: first.updatedAt } },
            { updatedAt: first.updatedAt, id: { gt: first.id } },
          ],
        },
      ],
    });
  });

  it("continues the other scans when the stuck query fails", async () => {
    const prisma = {
      run: {
        findMany: vi.fn(async (args: { where?: unknown }) => {
          if (JSON.stringify(args.where).includes("waiting_takeover")) {
            throw new Error("stuck down");
          }
          return [];
        }),
      },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const { jobs } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(prisma.routine.findMany).toHaveBeenCalled();
  });
});

type NoticeStamp = { id?: string; runId: string | null; payload: unknown };

type NoticeDeleteWhere = {
  id?: string;
  runId?: string;
  AND?: Array<{ payload?: { path?: string[]; equals?: unknown } }>;
};

function payloadValue(payload: unknown, path: string[]): unknown {
  let current = payload;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stampMatchesDelete(stamp: NoticeStamp, where: NoticeDeleteWhere | undefined): boolean {
  if (!where) return false;
  if (where.id) return stamp.id === where.id;
  if (where.runId === undefined || stamp.runId !== where.runId) return false;
  const clauses = where.AND ?? [];
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const filter = clause.payload;
    if (!filter?.path?.length) return false;
    return payloadValue(stamp.payload, filter.path) === filter.equals;
  });
}

function noticePrisma(run: ReturnType<typeof candidate>, stamps: NoticeStamp[]) {
  let nextId = 0;
  const prisma = {
    run: {
      findMany: vi.fn(async () => [run]),
      findUnique: vi.fn(async () => ({
        status: run.status,
        updatedAt: run.updatedAt,
        startedAt: null,
      })),
    },
    event: {
      findMany: vi.fn(async () => stamps.map((stamp) => stamp)),
      findFirst: vi.fn(async () => stamps.find((stamp) => stamp.runId === run.id) ?? null),
      create: vi.fn(async (args: { data: { runId?: string; payload: unknown } }) => {
        nextId += 1;
        const stamp = {
          id: `event-${nextId}`,
          runId: args.data.runId ?? null,
          payload: args.data.payload,
        };
        stamps.push(stamp);
        return { id: stamp.id, seq: stamps.length };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { payload: unknown } }) => {
        const stamp = stamps.find((item) => item.id === args.where.id);
        if (!stamp) throw new Error("missing notice");
        stamp.payload = args.data.payload;
        return stamp;
      }),
      deleteMany: vi.fn(async (args?: { where?: NoticeDeleteWhere }) => {
        const before = stamps.length;
        for (let index = stamps.length - 1; index >= 0; index -= 1) {
          const stamp = stamps[index];
          if (stamp && stampMatchesDelete(stamp, args?.where)) stamps.splice(index, 1);
        }
        return { count: before - stamps.length };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: stamps.length + 1 })) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return prisma as unknown as PrismaClient & { $transaction: ReturnType<typeof vi.fn> };
}

function expireClient(run: ReturnType<typeof candidate>, options?: { cancelled?: number }) {
  const client = {
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    run: {
      findMany: vi.fn(async () => [run]),
      updateMany: vi.fn(async () => ({ count: options?.cancelled ?? 1 })),
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({ status: run.status, updatedAt: run.updatedAt, startedAt: null })
        .mockResolvedValue({ status: "cancelled", startedAt: null }),
      findUniqueOrThrow: vi.fn(async () => ({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        taskId: run.taskId,
      })),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "run-next" })),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "task-next" })),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 9 })) },
    message: {
      create: vi.fn(async () => ({ id: "message-expired", seq: 1 })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    event: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ seq: 8 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    steeringMessage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [
        {
          id: "steer-1",
          userId: "user-1",
          originTrigger: null,
          message: { id: "message-steer", blocks: [], seq: 1 },
        },
      ]),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
  };
  return Object.assign(client, {
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>, _options?: unknown) =>
      fn(client),
    ),
  });
}
