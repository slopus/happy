import { randomUUID } from "node:crypto";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInput,
  asSystem,
  createDb,
  createPendingSteeringRun,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("typed replies to waiting cards (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  let peerBotId: string;
  let peerThreadId: string;
  let groupTarget: Extract<ThreadTarget, { kind: "group" }>;
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const question: MessageBlock = {
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [
      { id: "choice-1", label: "Berlin" },
      { id: "choice-2", label: "Paris" },
    ],
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
    vi.clearAllMocks();
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `typed-reply-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ botId, threadId } = identity);
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    const peer = await system.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Beta",
        color: "primary",
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    peerBotId = peer.id;
    peerThreadId = peer.thread!.id;
    const group = await system.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Group",
        members: { create: [{ botId }, { botId: peerBotId }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    groupTarget = {
      kind: "group",
      groupId: group.id,
      threadId: group.thread!.id,
      groupName: group.name,
      members: [],
      memberBotIds: [botId, peerBotId],
    };
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const privateTarget = () =>
    ({ kind: "bot", botId, threadId, bot: { computer: null } }) as ThreadTarget;
  function send(target: ThreadTarget, text = "Paris", clientNonce: string = randomUUID()) {
    return runAsTenant(actor, () =>
      sendThreadMessage(
        { prisma, sandbox: {} as never, events: { notify } as never, jobs: { enqueue } as never },
        actor,
        target,
        { text, mentions: target.kind === "group" ? [botId] : [], clientNonce },
      ),
    );
  }
  it.each(["bot", "group"] as const)(
    "refuses a %s chat message in a Space that is being deleted",
    async (kind) => {
      await system.space.update({
        where: { id: actor.spaceId },
        data: {
          deletingAt: new Date(),
          deletionClaimId: `organization-deletion:${actor.spaceId}:x`,
        },
      });
      await expect(send(kind === "bot" ? privateTarget() : groupTarget)).rejects.toBeInstanceOf(
        SpaceDeletionInProgressError,
      );
      await expect(system.run.count({ where: { spaceId: actor.spaceId } })).resolves.toBe(0);
    },
  );

  it("serializes simultaneous text sends into one run and steering", async () => {
    const [first, second] = await Promise.all([
      send(privateTarget(), "First simultaneous message", "parallel-send-first"),
      send(privateTarget(), "Second simultaneous message", "parallel-send-second"),
    ]);
    expect(first.runId).toBe(second.runId);
    const runs = await system.run.findMany({ where: { threadId, trigger: "user" } });
    expect(runs).toHaveLength(1);
    expect(await system.steeringMessage.count({ where: { runId: first.runId } })).toBe(1);
    expect(await system.message.count({ where: { threadId, role: "user" } })).toBe(2);
  });

  async function waitingCard(
    card: MessageBlock = question,
    targetThreadId = threadId,
    targetBotId = botId,
    trigger = "user",
  ) {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: targetBotId,
        threadId: targetThreadId,
        prompt: "Choose a city",
        status: "waiting_input",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: targetBotId,
        threadId: targetThreadId,
        taskId: task.id,
        status: "waiting_input",
        trigger,
        checkpoint: JSON.stringify({ pending: true }),
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_input" },
    });
    const message = await createThreadMessage(system, {
      threadId: targetThreadId,
      botId: targetBotId,
      runId: run.id,
      role: "bot",
      blocks: [card],
    });
    return { run, task, message, attempt };
  }
  async function expectPending(fixture: Awaited<ReturnType<typeof waitingCard>>) {
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_input",
      completedAt: null,
    });
    expect(
      await system.message.findUniqueOrThrow({ where: { id: fixture.message.id } }),
    ).toMatchObject({ blocks: fixture.message.blocks });
  }

  it.each(["bot", "group"] as const)(
    "retires questions that are no longer latest in a %s send and starts one normal run",
    async (kind) => {
      const target = kind === "bot" ? privateTarget() : groupTarget;
      const old = await waitingCard(question, target.threadId);
      // An unrelated newer message used to prevent composer answers from finding the old ask.
      await createThreadMessage(system, {
        threadId: target.threadId,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Another update" }],
      });
      const latest = await waitingCard(
        { kind: "ask", text: "Any preference?", status: "pending" },
        target.threadId,
      );
      const peer = await waitingCard(question, target.threadId, peerBotId);
      const otherThread = await waitingCard(question, peerThreadId);
      const nonce = randomUUID();
      const result = await send(target, "Paris", nonce);
      expect(result.runIds).toEqual([result.runId]);
      expect([old.run.id, latest.run.id]).not.toContain(result.runId);
      expect(await system.run.findUniqueOrThrow({ where: { id: result.runId! } })).toMatchObject({
        status: "queued",
        trigger: "user",
      });
      for (const fixture of [old, latest]) {
        expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject(
          { status: "cancelled", error: null, completedAt: expect.any(Date), checkpoint: null },
        );
        expect(
          await system.task.findUniqueOrThrow({ where: { id: fixture.task.id } }),
        ).toMatchObject({ status: "cancelled" });
        expect(
          await system.attempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
        ).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
        const updated = await system.message.findUniqueOrThrow({
          where: { id: fixture.message.id },
        });
        expect(updated.blocks).toEqual([
          expect.objectContaining({ status: "answered", answer: "Paris" }),
        ]);
        const events = await system.event.findMany({
          where: { runId: fixture.run.id },
          orderBy: { seq: "asc" },
        });
        expect(events.map((event) => event.type)).toEqual([
          "thread.message.updated",
          "run.cancelled",
        ]);
        expect(
          await runAsTenant(actor, () =>
            answerRunInput(prisma, {
              spaceId: actor.spaceId,
              threadId: target.threadId,
              runId: fixture.run.id,
              messageId: fixture.message.id,
              answeredByUserId: actor.userId,
              answer: "choice-1",
            }),
          ),
        ).toBe(false);
      }
      await expectPending(peer);
      await expectPending(otherThread);
      const count = await system.event.count({ where: { threadId: target.threadId } });
      expect(await send(target, "Paris", nonce)).toMatchObject({
        runId: result.runId,
        runIds: result.runIds,
      });
      expect(await system.event.count({ where: { threadId: target.threadId } })).toBe(count);
      expect(enqueue.mock.calls.every(([job]) => job.payload.runId === result.runId)).toBe(true);
    },
  );

  it.each(["bot", "group"] as const)(
    "resumes the latest question in a %s send while retiring an older stranded question",
    async (kind) => {
      const target = kind === "bot" ? privateTarget() : groupTarget;
      const old = await waitingCard(question, target.threadId);
      const peer = await waitingCard(question, target.threadId, peerBotId);
      const latest = await waitingCard(question, target.threadId);
      const result = await send(target);
      expect(result).toMatchObject({ runId: latest.run.id, runIds: [latest.run.id] });
      expect(await system.run.findUniqueOrThrow({ where: { id: latest.run.id } })).toMatchObject({
        status: "queued",
        completedAt: null,
      });
      expect(
        await system.message.findFirstOrThrow({
          where: { threadId: target.threadId, seq: result.seq },
        }),
      ).toMatchObject({
        runId: latest.run.id,
      });
      expect(
        await system.message.findUniqueOrThrow({ where: { id: latest.message.id } }),
      ).toMatchObject({
        blocks: [expect.objectContaining({ status: "answered", answer: "choice-2" })],
      });
      expect(await system.run.findUniqueOrThrow({ where: { id: old.run.id } })).toMatchObject({
        status: "cancelled",
      });
      expect(
        await system.message.findUniqueOrThrow({ where: { id: old.message.id } }),
      ).toMatchObject({
        blocks: [expect.objectContaining({ status: "answered", answer: "Paris" })],
      });
      const events = await system.event.findMany({
        where: { runId: latest.run.id },
        orderBy: { seq: "asc" },
      });
      expect(events.map((event) => event.type)).toEqual([
        "thread.message.updated",
        "thread.message.created",
      ]);
      expect(events.at(-1)?.payload).toMatchObject({ runIds: [latest.run.id] });
      expect(notify).toHaveBeenCalledWith(target.threadId, events.at(-1)?.seq);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: latest.run.id } }),
      );
      await expectPending(peer);
    },
  );

  it("associates a confirmed group reply with a secondary waiting recipient", async () => {
    // Member order creates the first recipient's new run before the waiting peer.
    const waiting = await waitingCard(question, groupTarget.threadId, peerBotId);
    const artifact = await system.artifact.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        groupId: groupTarget.groupId,
        name: "reply.png",
        mimeType: "image/png",
        size: 4,
        hash: "fixture",
        storageKey: "fixture",
      },
    });
    const result = await runAsTenant(actor, () =>
      sendThreadMessage(
        { prisma, sandbox: {} as never, events: { notify } as never, jobs: { enqueue } as never },
        actor,
        groupTarget,
        {
          text: "Paris",
          mentions: [botId, peerBotId],
          artifactIds: [artifact.id],
          imageHandling: "confirm",
          clientNonce: randomUUID(),
        },
      ),
    );
    expect(result.runIds).toContain(waiting.run.id);
    expect(result.runId).not.toBe(waiting.run.id);
    const message = await system.message.findFirstOrThrow({
      where: { threadId: groupTarget.threadId, seq: result.seq },
    });
    expect(message.runId).toBe(result.runId);
    expect(await system.steeringMessage.findMany({ where: { messageId: message.id } })).toEqual([
      expect.objectContaining({ botId: peerBotId, runId: waiting.run.id }),
    ]);
    const guarded = await system.message.findMany({
      where: {
        threadId: groupTarget.threadId,
        role: "user",
        steeringMessages: { some: { runId: waiting.run.id, botId: peerBotId } },
        blocks: { array_contains: [{ kind: "image" }] },
      },
      select: { id: true, blocks: true },
    });
    expect(guarded).toEqual([
      {
        id: message.id,
        blocks: expect.arrayContaining([
          expect.objectContaining({ kind: "image", imageHandling: "confirm" }),
        ]),
      },
    ]);
    expect(await system.run.findUniqueOrThrow({ where: { id: waiting.run.id } })).toMatchObject({
      status: "queued",
    });
  });

  function privateImage() {
    return system.artifact.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        name: "reply.png",
        mimeType: "image/png",
        size: 4,
        hash: "fixture",
        storageKey: "fixture",
      },
    });
  }
  function sendConfirmedImage(artifactId: string, text: string) {
    return runAsTenant(actor, () =>
      sendThreadMessage(
        { prisma, sandbox: {} as never, events: { notify } as never, jobs: { enqueue } as never },
        actor,
        privateTarget(),
        { text, artifactIds: [artifactId], imageHandling: "confirm", clientNonce: randomUUID() },
      ),
    );
  }

  it("associates a confirmed private reply with the waiting routine it answers", async () => {
    const waiting = await waitingCard(question, threadId, botId, "routine");
    const artifact = await privateImage();
    const result = await sendConfirmedImage(artifact.id, "Paris");
    expect(result.runId).toBe(waiting.run.id);
    const message = await system.message.findFirstOrThrow({
      where: { threadId, seq: result.seq },
    });
    expect(message.runId).toBe(waiting.run.id);
    // A routine turn reads no thread history, so only this row delivers the image.
    expect(await system.steeringMessage.findMany({ where: { messageId: message.id } })).toEqual([
      expect.objectContaining({ botId, runId: waiting.run.id, claimedAt: null }),
    ]);
    expect(await system.run.findUniqueOrThrow({ where: { id: waiting.run.id } })).toMatchObject({
      status: "queued",
    });
  });

  it.each(["bot", "group"] as const)(
    "binds a file reply to the waiting routine it answers in a %s thread",
    async (kind) => {
      const target = kind === "bot" ? privateTarget() : groupTarget;
      const answeringBotId = kind === "bot" ? botId : peerBotId;
      const waiting = await waitingCard(question, target.threadId, answeringBotId, "routine");
      const artifact = await system.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(kind === "bot" ? { botId } : { groupId: groupTarget.groupId }),
          name: "reply.png",
          mimeType: "image/png",
          size: 4,
          hash: "fixture",
          storageKey: "fixture",
        },
      });
      const result = await runAsTenant(actor, () =>
        sendThreadMessage(
          { prisma, sandbox: {} as never, events: { notify } as never, jobs: { enqueue } as never },
          actor,
          target,
          {
            text: "Paris",
            artifactIds: [artifact.id],
            imageHandling: "file",
            mentions: kind === "group" ? [botId, peerBotId] : [],
            clientNonce: randomUUID(),
          },
        ),
      );
      expect(result.runIds).toContain(waiting.run.id);
      const message = await system.message.findFirstOrThrow({
        where: { threadId: target.threadId, seq: result.seq },
      });
      // Send as file stores the picture as a file the routine can list and copy.
      expect(message.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", artifactId: artifact.id }),
        ]),
      );
      // A routine reads no thread history, so only this row delivers the attachment.
      expect(await system.steeringMessage.findMany({ where: { messageId: message.id } })).toEqual([
        expect.objectContaining({ botId: answeringBotId, runId: waiting.run.id }),
      ]);
    },
  );

  it("adds no steering row for a text-only answer to a waiting routine", async () => {
    const waiting = await waitingCard(question, threadId, botId, "routine");
    const result = await send(privateTarget());
    expect(result.runId).toBe(waiting.run.id);
    const message = await system.message.findFirstOrThrow({ where: { threadId, seq: result.seq } });
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
  });

  it("leaves a confirmed image sent during a background routine to its continuation", async () => {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        prompt: "Routine work",
        status: "running",
      },
    });
    const routine = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "routine",
      },
    });
    const artifact = await privateImage();
    const result = await sendConfirmedImage(artifact.id, "Look at this");
    const message = await system.message.findFirstOrThrow({
      where: { threadId, seq: result.seq },
    });
    // The routine only links the message for display; it never receives pending steering.
    expect(message.runId).toBe(routine.id);
    expect(await system.steeringMessage.findMany({ where: { messageId: message.id } })).toEqual([
      expect.objectContaining({ botId, runId: null }),
    ]);
    await system.run.update({ where: { id: routine.id }, data: { status: "completed" } });
    const continuationId = await system.$transaction((tx) =>
      createPendingSteeringRun(tx, { spaceId: actor.spaceId, threadId, botId }),
    );
    expect(continuationId).toBeTruthy();
    expect(await system.run.findUniqueOrThrow({ where: { id: continuationId! } })).toMatchObject({
      sourceMessageId: message.id,
    });
    expect(await system.steeringMessage.findMany({ where: { messageId: message.id } })).toEqual([
      expect.objectContaining({ botId, runId: continuationId }),
    ]);
  });

  it("still resumes the same run when an option is tapped", async () => {
    const fixture = await waitingCard();
    expect(
      await runAsTenant(actor, () =>
        answerRunInput(prisma, {
          spaceId: actor.spaceId,
          threadId,
          runId: fixture.run.id,
          messageId: fixture.message.id,
          answeredByUserId: actor.userId,
          answer: "choice-2",
        }),
      ),
    ).toBe(true);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
      checkpoint: null,
    });
    expect(
      await system.message.findUniqueOrThrow({ where: { id: fixture.message.id } }),
    ).toMatchObject({
      blocks: [expect.objectContaining({ status: "answered", answer: "choice-2" })],
    });
    expect(await system.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).toMatchObject({
      prompt: "Selected choice choice-2: Paris",
    });
  });

  it.each(["secret", "login", "approval"] as const)(
    "leaves a %s card and its run pending",
    async (kind) => {
      const card: MessageBlock = {
        kind: "ask",
        text: "Input needed",
        status: "pending",
        ...(kind === "approval"
          ? {
              approvalEffectId: "synthetic-effect",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            }
          : { input: "secret" as const }),
        ...(kind === "login"
          ? {
              credential: {
                name: "site_login",
                origin: "https://login.example.test",
                auth: { type: "login" as const },
              },
            }
          : {}),
      };
      const fixture = await waitingCard(card);
      const result = await send(privateTarget());
      expect(result.runId).not.toBe(fixture.run.id);
      await expectPending(fixture);
      expect(await system.event.count({ where: { runId: fixture.run.id } })).toBe(0);
    },
  );

  it("retires a question while steering live work for the same bot", async () => {
    const fixture = await waitingCard();
    await createThreadMessage(system, {
      threadId,
      botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Current update" }],
    });
    const liveTask = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        prompt: "Current work",
        status: "running",
      },
    });
    const liveRun = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: liveTask.id,
        status: "running",
        trigger: "user",
      },
    });
    const result = await send(privateTarget());
    expect(result.runId).toBe(liveRun.id);
    expect(await system.run.findUniqueOrThrow({ where: { id: liveRun.id } })).toMatchObject({
      status: "running",
    });
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.steeringMessage.count({ where: { runId: liveRun.id } })).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("saves a typed stop only together with its cancel, so a retry finishes it", async () => {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        prompt: "work",
        status: "queued",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const failing = prisma.$extends({
      query: {
        run: {
          updateManyAndReturn() {
            throw new Error("synthetic stop failure");
          },
        },
      },
    });
    const send = (db: PrismaClient) =>
      runAsTenant(actor, () =>
        sendThreadMessage(
          {
            prisma: db,
            sandbox: {} as never,
            events: { notify } as never,
            jobs: { enqueue } as never,
          },
          actor,
          privateTarget(),
          { text: "stop", clientNonce: "typed-stop" },
        ),
      );
    await expect(send(failing as PrismaClient)).rejects.toThrow("synthetic stop failure");
    expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
    });
    expect(await system.message.count({ where: { threadId, role: "user" } })).toBe(0);
    expect(await system.steeringMessage.count({ where: { botId } })).toBe(0);

    await send(prisma);
    expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.message.count({ where: { threadId, role: "user" } })).toBe(1);
  });

  it("tears down a typed stop's computer work and wakes the chat, as Stop does", async () => {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        prompt: "work",
        status: "queued",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const computer = await system.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scopeKey: `typed-stop-${run.id}`,
        homeKey: `typed-stop-${run.id}`,
        kind: "fake",
        state: "running",
        providerRef: `ref-${run.id}`,
      },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId,
        runId: run.id,
        fence: 5,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const sandbox = {
      execute: vi.fn(async function* () {
        yield { type: "exit", code: 0 };
      }),
      releaseScreen: vi.fn().mockResolvedValue(undefined),
    };
    await runAsTenant(actor, () =>
      sendThreadMessage(
        {
          prisma,
          sandbox: sandbox as never,
          events: { notify } as never,
          jobs: { enqueue } as never,
        },
        actor,
        privateTarget(),
        { text: "stop" },
      ),
    );
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${run.id}` }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", computer.id, run.id]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: run.id }),
    );
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${run.id}` }),
      expect.objectContaining({ runId: run.id, screenLeaseId: `${run.id}:5` }),
    );
    expect(
      (
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })
      ).expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(notify).toHaveBeenCalledWith(threadId, expect.any(Number));
  });

  it("stops every working member when a group chat gets a bare stop", async () => {
    const working = async (memberBotId: string) => {
      const task = await system.task.create({
        data: {
          spaceId: actor.spaceId,
          botId: memberBotId,
          threadId: groupTarget.threadId,
          userId: actor.userId,
          prompt: "work",
          status: "running",
        },
      });
      return system.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: memberBotId,
          threadId: groupTarget.threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
    };
    const runs = [await working(botId), await working(peerBotId)];

    const result = await send(groupTarget, "stop", "group-stop");
    // A retry of the same send replays the stop instead of failing on its nonce.
    expect((await send(groupTarget, "stop", "group-stop")).runId).toBe(result.runId);

    expect(runs.map((run) => run.id)).toContain(result.runId);
    for (const run of runs) {
      expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "cancelled",
      });
    }
    expect(
      await system.run.count({
        where: { threadId: groupTarget.threadId, status: { not: "cancelled" } },
      }),
    ).toBe(0);
    expect(notify).toHaveBeenCalledWith(groupTarget.threadId, expect.any(Number));
  });

  it("stops a background helper a group chat started when it is the only work left", async () => {
    const source = await createThreadMessage(system, {
      threadId: groupTarget.threadId,
      botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Asking Beta to look it up." }],
    });
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: peerBotId,
        threadId: peerThreadId,
        userId: actor.userId,
        prompt: "look it up",
        status: "running",
      },
    });
    const helper = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: peerBotId,
        threadId: peerThreadId,
        taskId: task.id,
        status: "running",
        trigger: "helper",
        sourceMessageId: source.id,
      },
    });

    const result = await send(groupTarget, "stop");

    expect(result.runId).toBe(helper.id);
    expect(await system.run.findUniqueOrThrow({ where: { id: helper.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.run.count({ where: { threadId: groupTarget.threadId } })).toBe(0);
  });

  it("rolls back retirement if accepting the new run fails", async () => {
    const fixture = await waitingCard();
    await createThreadMessage(system, {
      threadId,
      botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Current update" }],
    });
    const failing = prisma.$extends({
      query: {
        run: {
          create() {
            throw new Error("synthetic send failure");
          },
        },
      },
    });
    await expect(
      runAsTenant(actor, () =>
        sendThreadMessage(
          {
            prisma: failing as PrismaClient,
            sandbox: {} as never,
            events: { notify } as never,
            jobs: { enqueue } as never,
          },
          actor,
          privateTarget(),
          { text: "Paris" },
        ),
      ),
    ).rejects.toThrow("synthetic send failure");
    await expectPending(fixture);
    expect(await system.message.count({ where: { threadId, role: "user" } })).toBe(0);
    expect(await system.event.count({ where: { runId: fixture.run.id } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
