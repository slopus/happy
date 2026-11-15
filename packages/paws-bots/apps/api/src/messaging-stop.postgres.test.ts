import { randomUUID } from "node:crypto";
import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { MessagingDelivery } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { STOPPED_BY_MESSAGE_NOTE } from "./thread-stop.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Calls the inbound handler directly, as a provider retry on another instance reaches it:
// the Chat SDK's in-memory dedupe never sees the second delivery.
describe.skipIf(!enabled)("a linked owner's stop command (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let handle: (event: MessagingInboundMessage) => Promise<void>;
  let transaction: ReturnType<typeof vi.fn>;
  const sandbox = {
    execute: vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    }),
    releaseScreen: vi.fn().mockResolvedValue(undefined),
  };

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `stop-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    transaction = vi.fn((...args: unknown[]) => Reflect.apply(prisma.$transaction, prisma, args));
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      enqueueIn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      cancelIn: vi.fn(async () => undefined),
    };
    const recorder = new MessagingDelivery({
      prisma,
      messaging: {} as never,
      events: createThreadEvents(prisma),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const inbound = createMessagingInboundHandler({
      prisma: new Proxy(prisma, {
        get: (target, key) => (key === "$transaction" ? transaction : Reflect.get(target, key)),
      }),
      events: createThreadEvents(prisma),
      jobs,
      delivery: { recordIn: recorder.recordIn.bind(recorder), send: vi.fn(async () => undefined) },
      sandbox: sandbox as never,
      provision: vi.fn(),
      openSignup: false,
      signupPolicy: { signupsEnabled: undefined, signupAllowlist: undefined },
    });
    handle = (event) => runAsSystem("test inbound", () => inbound(event));
  });
  afterEach(async () => {
    await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
    await system.organization.deleteMany({ where: { id: identity.spaceId } });
    await system.user.deleteMany({ where: { id: identity.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const text = (content: string, id: string, extra: Partial<MessagingInboundMessage> = {}) =>
    handle({
      type: "message",
      provider: "test",
      // Handles are unique per run: delivery receipts outlive the fixture.
      handle: `${identity.address}:${id}`,
      threadId: `dm-${identity.address}`,
      isDirect: true,
      from: identity.address,
      fromLabel: null,
      channelName: null,
      participants: [],
      content,
      mediaUrl: null,
      ...extra,
    });
  const work = async () => {
    const owner = {
      spaceId: identity.spaceId,
      botId: identity.botId,
      threadId: identity.threadId,
      userId: identity.userId,
    };
    const task = await system.task.create({ data: { ...owner, prompt: "work", status: "queued" } });
    return system.run.create({
      data: { ...owner, taskId: task.id, status: "running", trigger: "user" },
    });
  };
  const status = async (id: string) =>
    (await system.run.findUniqueOrThrow({ where: { id } })).status;
  const runs = () => system.run.count({ where: { botId: identity.botId } });
  const replies = async () =>
    (
      await system.messagingOutbound.findMany({
        where: {
          identityId: (
            await system.messagingIdentity.findFirstOrThrow({ where: { botId: identity.botId } })
          ).id,
        },
      })
    ).map((row) => row.body);
  const notes = async () =>
    (
      await system.message.findMany({ where: { threadId: identity.threadId, role: "system" } })
    ).filter((message) => JSON.stringify(message.blocks).includes(STOPPED_BY_MESSAGE_NOTE)).length;
  const userMessages = () =>
    system.message.count({ where: { threadId: identity.threadId, role: "user" } });

  it("ignores a deactivated owner's chat app: no command, message or turn", async () => {
    const running = await work();
    await system.user.update({
      where: { id: identity.userId },
      data: { deactivatedAt: new Date() },
    });
    const messages = await system.message.count({ where: { threadId: identity.threadId } });

    await text("stop", "deactivated-stop");
    await text("hello", "deactivated-hello");

    expect(await status(running.id)).toBe("running");
    expect(await system.message.count({ where: { threadId: identity.threadId } })).toBe(messages);
    expect(await runs()).toBe(1);
    expect(await replies()).toEqual([]);

    // In a group, too: no memberships, invitations or relays come from them.
    await text("hello all", "deactivated-group", {
      isDirect: false,
      threadId: `group-${identity.address}`,
      channelName: "Team",
      participants: [identity.address, `other-${identity.address}`],
    });
    expect(
      await system.messagingChannelMember.count({
        where: { channel: { threadId: `group-${identity.address}` } },
      }),
    ).toBe(0);

    // An active person's group does not invite them either.
    const friend = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `friend-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      await handle({
        type: "message",
        provider: "test",
        handle: `${friend.address}:invite`,
        threadId: `friends-${identity.address}`,
        isDirect: false,
        from: friend.address,
        fromLabel: null,
        channelName: "Friends",
        participants: [friend.address, identity.address],
        content: "hi both",
        mediaUrl: null,
      } as MessagingInboundMessage);
      expect(await replies()).toEqual([]);
      expect(await system.message.count({ where: { threadId: identity.threadId } })).toBe(messages);
    } finally {
      await system.messagingIdentity.deleteMany({ where: { userId: friend.userId } });
      await system.organization.deleteMany({ where: { id: friend.spaceId } });
      await system.user.deleteMany({ where: { id: friend.userId } });
    }
  });

  it("stops running work, answers once and notes it in the app", async () => {
    const running = await work();
    await text("stop", "h-stop");
    expect(await status(running.id)).toBe("cancelled");
    expect([await replies(), await notes()]).toEqual([[STOPPED_BY_MESSAGE_NOTE], 1]);
    // The stop locks the thread row, which snapshot reads hold for up to 15s.
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });

  it("tears down the stopped run's computer work, as Stop does", async () => {
    const running = await work();
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `stop-${running.id}`,
        homeKey: `stop-${running.id}`,
        kind: "fake",
        state: "running",
        providerRef: `ref-${running.id}`,
      },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: identity.botId,
        runId: running.id,
        fence: 3,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await text("stop", "h-computer");
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${running.id}` }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", computer.id, running.id]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: running.id }),
    );
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${running.id}` }),
      expect.objectContaining({ runId: running.id, screenLeaseId: `${running.id}:3` }),
    );
    expect(
      (
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })
      ).expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });

  it("answers an idle stop without a message, a turn or a routine wake", async () => {
    await system.routine.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        name: "Replies",
        prompt: "Answer the message",
        crons: [],
        messageProvider: "test",
        active: true,
      },
    });
    await text("Stop now!", "h-idle");
    expect([await runs(), await userMessages(), await notes()]).toEqual([0, 0, 0]);
    expect(await replies()).toEqual(["Nothing is running."]);
  });

  it("leaves work started after a stop alone when that stop is delivered again", async () => {
    const first = await work();
    await text("stop", "h-again");
    expect(await status(first.id)).toBe("cancelled");
    const newer = await work();
    await text("stop", "h-again");
    expect(await status(newer.id)).toBe("running");
    expect(await replies()).toEqual([STOPPED_BY_MESSAGE_NOTE]);
  });

  it("leaves work started after an idle stop alone when it is delivered again", async () => {
    await text("stop", "h-idle-again");
    const newer = await work();
    await text("stop", "h-idle-again");
    expect(await status(newer.id)).toBe("running");
    expect(await replies()).toEqual(["Nothing is running."]);
  });

  it("stops once when two copies arrive together", async () => {
    const running = await work();
    await Promise.all([text("stop", "h-twice"), text("stop", "h-twice")]);
    expect(await status(running.id)).toBe("cancelled");
    expect([await replies(), await notes()]).toEqual([[STOPPED_BY_MESSAGE_NOTE], 1]);
  });

  it("delivers a stop that carries a file as a message", async () => {
    const running = await work();
    await text("stop", "h-file", {
      attachments: [
        { name: "photo.jpg", mimeType: "image/jpeg", fetch: async () => new Uint8Array() },
      ],
    });
    expect(await status(running.id)).toBe("running");
    expect(await userMessages()).toBe(1);
    expect(await replies()).toEqual([]);
  });

  it("treats a stop in a group chat as an ordinary message", async () => {
    const running = await work();
    await text("stop", "h-group", {
      isDirect: false,
      threadId: `group-${identity.address}`,
      participants: [identity.address, "someone-else"],
    });
    expect(await status(running.id)).toBe("running");
    // The group is new, so its only DM is the invitation to join it.
    expect(await replies()).not.toContain(STOPPED_BY_MESSAGE_NOTE);
    expect(await replies()).not.toContain("Nothing is running.");
  });
});
