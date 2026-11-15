import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun, sendUserMessage } from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import { createThreadMessage, loadRunHistoryMessages } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { claimSteering, createPendingSteeringRun } from "./thread-steering.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("steering after a run ends without completing (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const partnerId = `steering-partner-${randomUUID()}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ userId, spaceId, botId, threadId } = identity);
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: { in: [userId, partnerId] } } });
      }
    } finally {
      await close?.();
    }
  });

  /** The executor finalizes and claims steering inside the run owner's tenant job. */
  const asOwner = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);

  async function runSteeredByMessage(status: "running" | "waiting_input") {
    await system.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "collect documents", status },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const steeringText = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `done ${randomUUID()}` }],
    });
    await system.steeringMessage.create({
      data: {
        messageId: steeringText.id,
        botId,
        userId,
        runId: run.id,
      },
    });
    await asOwner(() =>
      claimSteering(prisma, {
        threadId,
        botId,
        runId: run.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      }),
    );
    if (status === "waiting_input") {
      await system.run.update({ where: { id: run.id }, data: { status, leaseOwner: null } });
    }
    return { task, run, attempt };
  }

  async function botReplies(runId: string, clientNonce?: string) {
    await asOwner(() =>
      createThreadMessage(prisma, {
        threadId,
        role: "bot",
        botId,
        runId,
        blocks: [{ kind: "text", text: "Yes, I can pull the documents myself." }],
        clientNonce,
      }),
    );
  }

  function failRun(fixture: Awaited<ReturnType<typeof runSteeredByMessage>>) {
    return asOwner(() =>
      finalizeRun(prisma, {
        spaceId,
        threadId,
        botId,
        runId: fixture.run.id,
        taskId: fixture.task.id,
        attemptId: fixture.attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "failed",
        error: "stream idle timeout",
      }),
    );
  }

  it("does not answer a message again after the failed run already replied to it", async () => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id);

    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });

    expect(await system.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(0);
  });

  it("still continues a message the failed run claimed but never replied to", async () => {
    const fixture = await runSteeredByMessage("running");

    const result = await failRun(fixture);

    expect(result).toEqual({ continuationRunId: expect.any(String) });
    const continuation = await system.run.findUniqueOrThrow({
      where: { id: (result as { continuationRunId: string }).continuationRunId },
    });
    expect(continuation.trigger).toBe("follow_up");
  });

  it("does not replay a claimed request after a progress update or promoted narration", async () => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id, `user-progress:${fixture.run.id}:0:test`);
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });
  });

  it.each([0, 60_000])("ignores a claim clock offset of %i ms", async (offset) => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id);
    const reply = await system.message.findFirstOrThrow({ where: { runId: fixture.run.id } });
    await system.steeringMessage.updateMany({
      where: { runId: fixture.run.id },
      data: { claimedAt: new Date(reply.createdAt.getTime() + offset) },
    });
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });
    expect(await system.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(0);
  });

  it("replays a message claimed after a reply even when the user message preceded it", async () => {
    const fixture = await runSteeredByMessage("running");
    const message = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "A second request" }],
    });
    const steering = await system.steeringMessage.create({
      data: { messageId: message.id, botId, userId, runId: fixture.run.id },
    });
    await botReplies(fixture.run.id);
    const seenIds = (
      await system.steeringMessage.findMany({
        where: { runId: fixture.run.id, id: { not: steering.id } },
        select: { id: true },
      })
    ).map((item) => item.id);
    await asOwner(() =>
      claimSteering(prisma, {
        threadId,
        botId,
        runId: fixture.run.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds,
      }),
    );
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: expect.any(String) });
    expect(await system.steeringMessage.findUnique({ where: { id: steering.id } })).not.toBeNull();
  });

  it("holds a chat message sent during an app run for a messaging continuation", async () => {
    const { task, run, attempt } = await runSteeredByMessage("running");
    // Messaging inbound runs as system until it resolves the thread.
    const inbound = await runAsSystem("messaging inbound", () =>
      sendUserMessage(prisma, {
        spaceId,
        threadId,
        botId,
        userId,
        blocks: [{ kind: "text", text: "Rewrite your child's instructions" }],
        prompt: "Rewrite your child's instructions",
        trigger: "messaging",
      }),
    );
    expect(inbound.runId).toBe(run.id);
    expect(
      await system.steeringMessage.findFirstOrThrow({ where: { messageId: inbound.messageId } }),
    ).toMatchObject({ runId: null, originTrigger: "messaging" });
    // The held text is marked as waiting for this bot; one only another bot waits on is not.
    const peer = await system.bot.create({
      data: { spaceId, userId, name: "Peer", color: "blue" },
    });
    const peerWaiting = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "For the other bot" }],
    });
    await system.steeringMessage.create({
      data: { messageId: peerWaiting.id, botId: peer.id, userId },
    });
    const waiting = new Map(
      (await asOwner(() => loadRunHistoryMessages(prisma, run, 100))).map((message) => [
        message.id,
        message.steeringMessages.length > 0,
      ]),
    );
    expect(waiting.get(peerWaiting.id)).toBe(false);
    expect(waiting.get(inbound.messageId)).toBe(true);
    await system.bot.delete({ where: { id: peer.id } });

    const result = await asOwner(() =>
      finalizeRun(prisma, {
        spaceId,
        threadId,
        botId,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Done." }],
      }),
    );

    expect(result).toEqual({ continuationRunId: expect.any(String) });
    const continuation = await system.run.findUniqueOrThrow({
      where: { id: (result as { continuationRunId: string }).continuationRunId },
    });
    expect(continuation.sourceMessageId).toBe(inbound.messageId);
    expect(continuation.trigger).toBe("messaging");
  });

  it("keeps a private batch with a direct-line message a messaging run, even when the app wrote last", async () => {
    await system.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const directLine = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `Rewrite your child's instructions ${randomUUID()}` }],
    });
    const app = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `And thanks ${randomUUID()}` }],
    });
    const rows = await Promise.all([
      system.steeringMessage.create({
        data: { messageId: directLine.id, botId, userId, originTrigger: "messaging" },
      }),
      system.steeringMessage.create({ data: { messageId: app.id, botId, userId } }),
    ]);

    const continuationRunId = await asOwner(() =>
      prisma.$transaction((tx) => createPendingSteeringRun(tx, { spaceId, threadId, botId })),
    );

    const continuation = await system.run.findUniqueOrThrow({ where: { id: continuationRunId! } });
    expect(continuation).toMatchObject({ trigger: "messaging", sourceMessageId: app.id });
    expect(
      await system.steeringMessage.count({
        where: { id: { in: rows.map((row) => row.id) }, runId: continuationRunId },
      }),
    ).toBe(2);
  });

  it("keeps a channel message queued before origins were recorded a messaging run", async () => {
    await system.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const legacy = await createThreadMessage(system, {
      threadId,
      role: "user",
      blocks: [
        {
          kind: "channel_message",
          provider: "sendblue",
          channelId: randomUUID(),
          fromAddress: "+15550000000",
          fromLabel: "Guest",
          text: `Rewrite your child's instructions ${randomUUID()}`,
        },
      ],
    });
    await system.steeringMessage.create({ data: { messageId: legacy.id, botId, userId } });

    const continuationRunId = await asOwner(() =>
      prisma.$transaction((tx) => createPendingSteeringRun(tx, { spaceId, threadId, botId })),
    );

    const continuation = await system.run.findUniqueOrThrow({ where: { id: continuationRunId! } });
    expect(continuation.trigger).toBe("messaging");
  });

  it("does not answer a message again after an expired wait that already replied to it", async () => {
    const fixture = await runSteeredByMessage("waiting_input");
    await botReplies(fixture.run.id);
    const { updatedAt } = await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } });

    // The stuck-work reconciler runs as system.
    const expired = await system.$transaction((tx) =>
      expireStuckRun(tx, {
        runId: fixture.run.id,
        threadId,
        status: "waiting_input",
        updatedAt,
        now: new Date(),
      }),
    );

    expect(expired).toMatchObject({ continuationRunId: null });
  });

  /** A second person in the same space, so messages from both land in one bot thread. */
  async function addPartner() {
    if (await system.user.findUnique({ where: { id: partnerId } })) return;
    const { organizationId } = await system.space.findUniqueOrThrow({ where: { id: spaceId } });
    await system.user.create({
      data: { id: partnerId, name: "Partner", email: `${partnerId}@example.test` },
    });
    await system.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: partnerId,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Joining the organization may already add the person to its spaces.
    await system.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId: partnerId } },
      create: {
        id: randomUUID(),
        organizationId,
        spaceId,
        userId: partnerId,
        createdAt: new Date(),
      },
      update: {},
    });
  }

  const sendAs = (sender: string, text: string) =>
    runAsTenant({ spaceId, userId: sender }, () =>
      sendUserMessage(prisma, {
        spaceId,
        threadId,
        botId,
        userId: sender,
        authorUserId: sender,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
      }),
    );

  it("keeps another member's message out of a busy run and continues it as that member", async () => {
    await addPartner();
    await system.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const { task, run, attempt } = await runSteeredByMessage("running");

    const partnerSend = await sendAs(partnerId, `Book the table ${randomUUID()}`);
    const ownSend = await sendAs(userId, `Also the train ${randomUUID()}`);

    const rows = await system.steeringMessage.findMany({
      where: { messageId: { in: [partnerSend.messageId, ownSend.messageId] } },
    });
    expect(rows.find((row) => row.messageId === partnerSend.messageId)).toMatchObject({
      userId: partnerId,
      runId: null,
    });
    expect(rows.find((row) => row.messageId === ownSend.messageId)).toMatchObject({
      userId,
      runId: run.id,
    });

    const seenIds = (
      await system.steeringMessage.findMany({
        where: { runId: run.id, claimedAt: { not: null } },
        select: { id: true },
      })
    ).map((row) => row.id);
    const claimed = await asOwner(() =>
      claimSteering(prisma, {
        threadId,
        botId,
        runId: run.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds,
      }),
    );
    expect(claimed.map((item) => item.messageId)).toEqual([ownSend.messageId]);

    const result = await asOwner(() =>
      finalizeRun(prisma, {
        spaceId,
        threadId,
        botId,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Done." }],
      }),
    );
    const continuation = await system.run.findUniqueOrThrow({
      where: { id: (result as { continuationRunId: string }).continuationRunId },
      include: { task: true },
    });
    expect(continuation).toMatchObject({
      userId: partnerId,
      trigger: "follow_up",
      sourceMessageId: partnerSend.messageId,
    });
    expect(continuation.task.userId).toBe(partnerId);
  });

  it("continues each sender's pending messages in a run of their own", async () => {
    await addPartner();
    await system.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const pending = [];
    for (const sender of [partnerId, userId, partnerId]) {
      const message = await createThreadMessage(system, {
        threadId,
        role: "user",
        authorUserId: sender,
        blocks: [{ kind: "text", text: `pending ${randomUUID()}` }],
      });
      pending.push(
        await system.steeringMessage.create({
          data: { messageId: message.id, botId, userId: sender },
        }),
      );
    }

    const firstRunId = await asOwner(() =>
      prisma.$transaction((tx) => createPendingSteeringRun(tx, { spaceId, threadId, botId })),
    );
    const first = await system.run.findUniqueOrThrow({ where: { id: firstRunId! } });
    expect(first.userId).toBe(partnerId);
    const firstBatch = await system.steeringMessage.findMany({ where: { runId: firstRunId! } });
    expect(firstBatch.map((row) => row.id).sort()).toEqual([pending[0]!.id, pending[2]!.id].sort());

    await system.run.update({ where: { id: firstRunId! }, data: { status: "cancelled" } });
    await system.steeringMessage.deleteMany({ where: { runId: firstRunId! } });
    const secondRunId = await asOwner(() =>
      prisma.$transaction((tx) => createPendingSteeringRun(tx, { spaceId, threadId, botId })),
    );
    const second = await system.run.findUniqueOrThrow({ where: { id: secondRunId! } });
    expect(second.userId).toBe(userId);
    expect(
      (await system.steeringMessage.findMany({ where: { runId: secondRunId! } })).map(
        (row) => row.id,
      ),
    ).toEqual([pending[1]!.id]);
  });
});
