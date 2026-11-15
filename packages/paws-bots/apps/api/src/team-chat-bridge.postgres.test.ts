import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  BackgroundJob,
  MessagingInboundMessage,
  MessagingSurface,
  TeamChatInboundMessage,
} from "@rakazo/adapter-kit";
import { teamChatEngageJobKey } from "@rakazo/adapter-kit";
import { GraphileJobPublisher, MessagingDelivery, TeamChat } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createPool,
  provisionMessagingIdentity,
  runAsSystem,
  sendUserMessage as sendUserMessageTo,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { wakeMessageRoutines } from "./messaging-inbound.js";
import { TeamChatBridge } from "./team-chat-bridge.js";

const databaseUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl && ownerUrl ? describe : describe.skip;

describePostgres("team chat engagement through Graphile jobs (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createPool>;
  let system: PrismaClient;
  let graphile: GraphileJobPublisher;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const address = `teamchat-${randomUUID()}@example.test`;
  /** Run continuations this process started; the rest go to Graphile. */
  const continued: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    owner = createPool(ownerUrl!);
    system = asSystem(db.prisma);
    graphile = new GraphileJobPublisher(db.pool);
    identity = await runAsSystem("teamchat fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await graphile?.close();
    await owner?.end();
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  const jobs = {
    enqueue: async (job: BackgroundJob) => {
      if (job.name === "run.continue") continued.push(job.payload.runId);
      else await graphile.enqueue(job);
    },
    enqueueIn: (...args: Parameters<GraphileJobPublisher["enqueueIn"]>) =>
      graphile.enqueueIn(...args),
    cancelIn: (...args: Parameters<GraphileJobPublisher["cancelIn"]>) => graphile.cancelIn(...args),
    cancel: (key: string) => graphile.cancel(key),
  };
  const events = {
    sendUserMessage: (input: Parameters<typeof sendUserMessageTo>[1]) =>
      sendUserMessageTo(system, input),
    notify: vi.fn(async () => undefined),
  };

  function teamChat(judge?: ConstructorParameters<typeof TeamChat>[0]["judge"]) {
    return new TeamChat({ prisma: system, events, jobs, judge, ambientDebounceMs: 0 });
  }

  function bridge(chat = teamChat()) {
    return new TeamChatBridge({
      prisma: system,
      teamChat: chat,
      jobs,
      providerId: "slack",
      botId: identity.botId,
    });
  }

  function message(overrides: Partial<TeamChatInboundMessage> = {}): TeamChatInboundMessage {
    return {
      eventId: `Ev-${randomUUID()}`,
      workspaceId: "T-1",
      kind: "mention",
      conversationKey: `channel:C-${identity.botId}`,
      conversationId: "slack:C-1",
      replyThreadId: null,
      senderId: "U-1",
      senderName: "Ada",
      content: "Can you look at the release?",
      ...overrides,
    };
  }

  async function job(key: string) {
    const { rows } = await owner.query<{ run_at: Date; queue_name: string | null }>(
      `select jobs.run_at, queues.queue_name
       from graphile_worker._private_jobs as jobs
       left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
       where jobs.key = $1`,
      [key],
    );
    return rows[0];
  }

  function row(id: string) {
    return system.externalMessage.findUniqueOrThrow({ where: { id } });
  }

  async function nextSeq(threadId: string) {
    const thread = await system.thread.update({
      where: { id: threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    return thread.nextMessageSeq;
  }

  async function reply(threadId: string, runId: string, text: string) {
    return system.message.create({
      data: {
        threadId,
        seq: await nextSeq(threadId),
        role: "bot",
        botId: identity.botId,
        runId,
        blocks: [{ kind: "text", text }],
      },
    });
  }

  /** Delivery whose provider records each post. */
  function replies() {
    const sent: Array<{ threadId: string; body: string }> = [];
    const messaging = {
      platforms: () => [],
      sendToThread: vi.fn(async (request: { threadId: string; body: string }) => {
        sent.push({ threadId: request.threadId, body: request.body });
        return { handle: `1700.${sent.length + 1}` };
      }),
    } as unknown as MessagingSurface;
    const delivery = () =>
      new MessagingDelivery({
        prisma: system,
        messaging,
        events,
        jobs,
        artifacts: { get: vi.fn() },
      });
    return { delivery, sent };
  }

  it("starts a mention's run in the process that receives it and removes its backup job", async () => {
    const received = await runAsSystem("teamchat mention", () => bridge().receive(message()));
    const recorded = await row(received.externalMessageId);
    expect({
      status: recorded.status,
      continued: continued.includes(recorded.runId!),
      transcript: Boolean(recorded.threadMessageId),
      backup: await job(teamChatEngageJobKey(recorded.id)),
    }).toEqual({ status: "running", continued: true, transcript: true, backup: undefined });
  });

  it("schedules the end of routine routing as a job that hands the message to the agent", async () => {
    const before = Date.now();
    const deferred = await runAsSystem("teamchat routing", () =>
      bridge().receive(message(), { defer: true }),
    );
    expect(deferred.deferred).toBe(true);
    const expiry = await job(teamChatEngageJobKey(deferred.externalMessageId));
    expect(expiry!.run_at.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000 - 1_000);

    // The process routing it stopped; the job fires when routing's time is up.
    await teamChat().engageJob(deferred.externalMessageId);
    const answered = await row(deferred.externalMessageId);
    expect({ status: answered.status, run: Boolean(answered.runId) }).toEqual({
      status: "running",
      run: true,
    });
    expect(await job(teamChatEngageJobKey(deferred.externalMessageId))).toBeUndefined();
  });

  it("lets only one of a routine wake and the agent answer a deferred message", async () => {
    const routine = await system.routine.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        userId: identity.userId,
        name: "Release desk",
        prompt: "Handle release requests.",
        crons: [],
        active: true,
        messageProvider: "slack",
      },
    });
    try {
      for (let round = 0; round < 3; round += 1) {
        const inbound = message();
        const deferred = await runAsSystem("teamchat routing", () =>
          bridge().receive(inbound, { defer: true }),
        );
        const event = {
          type: "message",
          provider: "slack",
          handle: inbound.eventId,
          threadId: inbound.conversationId,
          isDirect: false,
          from: inbound.senderId,
          fromLabel: inbound.senderName,
          channelName: null,
          participants: [],
          content: inbound.content,
          mediaUrl: null,
        } satisfies MessagingInboundMessage;
        // Routing races the job that fires when its time is up.
        await runAsSystem("teamchat race", () =>
          Promise.all([
            wakeMessageRoutines({ prisma: system, events, jobs }, deferred, event, {
              deliveryProvider: "slack",
              externalMessageId: deferred.externalMessageId,
            }),
            teamChat().engageJob(deferred.externalMessageId),
          ]),
        );
        const settled = await row(deferred.externalMessageId);
        const wakes = await system.message.count({
          where: {
            threadId: deferred.threadId,
            blocks: { array_contains: [{ kind: "delivery" }] },
          },
        });
        const agentRuns = settled.runId ? 1 : 0;
        expect({ answers: agentRuns + (settled.status === "ignored" ? 1 : 0) }).toEqual({
          answers: 1,
        });
        expect(settled.status === "ignored" ? wakes > 0 : true).toBe(true);
      }
    } finally {
      await system.routine.delete({ where: { id: routine.id } });
    }
  });

  it("drops a message for a Space being deleted, keeping its transcript and starting no run", async () => {
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}:x`,
      },
    });
    try {
      const received = await runAsSystem("teamchat deleting", () => bridge().receive(message()));
      const dropped = await row(received.externalMessageId);
      expect({
        status: dropped.status,
        run: dropped.runId,
        transcript: Boolean(dropped.threadMessageId),
        backup: await job(teamChatEngageJobKey(dropped.id)),
      }).toEqual({ status: "ignored", run: null, transcript: true, backup: undefined });
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }
  });

  it("records a finished run's team-chat reply once and sends it to the thread it came from", async () => {
    const received = await runAsSystem("teamchat reply", () =>
      bridge().receive(message({ replyThreadId: "1700.1" })),
    );
    const { runId } = await row(received.externalMessageId);
    await system.run.update({ where: { id: runId! }, data: { status: "completed" } });
    const thread = await system.thread.findUniqueOrThrow({
      where: { id: received.threadId },
      select: { nextMessageSeq: true },
    });
    await system.message.create({
      data: {
        threadId: received.threadId,
        seq: thread.nextMessageSeq + 100,
        role: "bot",
        botId: identity.botId,
        runId,
        blocks: [{ kind: "text", text: "Release looks good." }],
      },
    });
    const { delivery, sent } = replies();
    // The finishing process and the run's reply job both deliver it.
    await Promise.all([delivery().deliverRun(runId!), delivery().deliverRun(runId!)]);
    expect(sent).toEqual([{ threadId: "slack:C-1:1700.1", body: "Release looks good." }]);
    expect((await row(received.externalMessageId)).status).toBe("delivered");
  });

  it("relays a delegated reply once, past the previous release's marker and its deferred drop", async () => {
    const received = await runAsSystem("teamchat delegation", () =>
      bridge().receive(message({ replyThreadId: "1800.1" })),
    );
    const { runId } = await row(received.externalMessageId);
    const asked = await reply(received.threadId, runId!, "Asking the research bot.");
    const delegated = async (text: string) => {
      const source = await system.message.create({
        data: {
          threadId: received.threadId,
          seq: await nextSeq(received.threadId),
          role: "user",
          blocks: [{ kind: "text", text: "Look into the release." }],
          replyToMessageId: asked.id,
        },
      });
      const task = await system.task.create({
        data: {
          spaceId: identity.spaceId,
          botId: identity.botId,
          userId: identity.userId,
          threadId: received.threadId,
          prompt: "delegated",
          status: "completed",
        },
      });
      const run = await system.run.create({
        data: {
          spaceId: identity.spaceId,
          botId: identity.botId,
          userId: identity.userId,
          threadId: received.threadId,
          taskId: task.id,
          status: "completed",
          trigger: "bot_message",
          sourceMessageId: source.id,
        },
      });
      await reply(received.threadId, run.id, text);
      return run.id;
    };
    const byPrevious = await delegated("Posted by the previous release.");
    const unposted = await delegated("Not posted yet.");
    const afterDrop = await delegated("Ended after the drop.");
    const marker = async (id: string) =>
      (
        await owner.query<{ marked: boolean }>(
          `SELECT "teamChatMirroredAt" IS NOT NULL AS marked FROM runs WHERE id = $1`,
          [id],
        )
      ).rows[0]?.marked;
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/db/prisma/migrations/20261214120100_drop_hand_rolled_delivery_state/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const { delivery, sent } = replies();

    // While the previous release still runs: its marker stops this release, and this release's
    // own relay sets it so the previous release's bridge passes it over.
    await owner.query(`ALTER TABLE runs ADD COLUMN "teamChatMirroredAt" TIMESTAMP(3)`);
    await owner.query(
      `UPDATE runs SET "teamChatMirroredAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`,
      [byPrevious],
    );
    await delivery().deliverRun(byPrevious);
    await Promise.all([delivery().deliverRun(unposted), delivery().deliverRun(unposted)]);
    expect(sent).toEqual([{ threadId: "slack:C-1:1800.1", body: "Not posted yet." }]);
    expect(await marker(unposted)).toBe(true);

    // The deferred drop, with the columns it drops put back.
    await owner.query(
      `ALTER TABLE messaging_outbound ADD COLUMN "attempts" INTEGER, ADD COLUMN "nextAttemptAt" TIMESTAMP(3)`,
    );
    await owner.query(
      `ALTER TABLE external_messages ADD COLUMN "attempts" INTEGER, ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
         ADD COLUMN "lastError" TEXT, ADD COLUMN "providerReplyHandle" TEXT, ADD COLUMN "deliveredAt" TIMESTAMP(3)`,
    );
    await owner.query(migration);
    expect(
      await system.messagingOutbound.findUnique({
        where: { idempotencyKey: `team-chat-run:${byPrevious}` },
        select: { status: true, providerHandle: true, identityId: true, threadId: true },
      }),
    ).toEqual({ status: "sent", providerHandle: "", identityId: null, threadId: null });

    // A reply job still pending after the drop finds the carried row; a new relay goes out once.
    await delivery().deliverRun(byPrevious);
    await delivery().deliverRun(afterDrop);
    await delivery().deliverRun(afterDrop);
    expect(sent.map((post) => post.body)).toEqual(["Not posted yet.", "Ended after the drop."]);
  });

  it("decides a person's message on the next pass behind a full batch of digests not yet due", async () => {
    const conversationKey = `channel:digests-${randomUUID()}`;
    const judge = {
      decide: vi.fn(async (_input: { messages: Array<{ content: string }> }) => ({
        act: false,
        reason: "Nothing to add.",
      })),
    };
    await system.bot.update({
      where: { id: identity.botId },
      data: { teamChatAmbientEnabled: true },
    });
    const chat = teamChat(judge);
    const person = await runAsSystem("teamchat ambient", () =>
      bridge(chat).receive(message({ kind: "ambient", conversationKey, content: "Any update?" })),
    );
    const { externalConversationId } = await row(person.externalMessageId);
    await system.externalConversation.update({
      where: { id: externalConversationId },
      data: {
        automatedSenderPolicies: { "B-digest": { name: "Digest", mode: "rollup", rollupHours: 6 } },
      },
    });
    const judgedAt = new Date(Date.now() - 60 * 60 * 1000);
    const digest = (index: number, fields: object) => ({
      externalConversationId,
      providerEventId: `Ev-digest-${randomUUID()}`,
      kind: "ambient",
      senderId: "B-digest",
      senderName: "Digest",
      senderIsBot: true,
      content: `Build ${index} passed`,
      createdAt: new Date(Date.now() - 10 * 60 * 1000 + index),
      ...fields,
    });
    // Its last digest was decided an hour ago; 120 more wait for the period, all older than the person.
    await system.externalMessage.createMany({
      data: [
        digest(0, { status: "ignored", judgedAt }),
        ...Array.from({ length: 120 }, (_, index) => digest(index + 1, { status: "observed" })),
      ],
    });

    await chat.ambientJob(externalConversationId);

    expect(judge.decide).toHaveBeenCalledOnce();
    expect(judge.decide.mock.calls[0]![0].messages.map((m) => m.content)).toEqual(["Any update?"]);
    expect((await row(person.externalMessageId)).status).toBe("ignored");
    expect(
      await system.externalMessage.count({
        where: { externalConversationId, senderId: "B-digest", status: "observed" },
      }),
    ).toBe(120);
    const next = await owner.query<{ run_at: Date }>(
      `select run_at from graphile_worker._private_jobs where key = $1`,
      [`team_chat.ambient:${externalConversationId}`],
    );
    expect(next.rows[0]?.run_at.getTime()).toBe(judgedAt.getTime() + 6 * 60 * 60 * 1000);
  });

  it("decides a quiet conversation's ambient messages in one queued job", async () => {
    const conversationKey = `channel:ambient-${randomUUID()}`;
    const judge = { decide: vi.fn(async () => ({ act: true, reason: "Asked about a date." })) };
    await system.bot.update({
      where: { id: identity.botId },
      data: { teamChatAmbientEnabled: true },
    });
    const chat = teamChat(judge);
    const first = await runAsSystem("teamchat ambient", () =>
      bridge(chat).receive(message({ kind: "ambient", conversationKey, content: "Morning" })),
    );
    const second = await runAsSystem("teamchat ambient", () =>
      bridge(chat).receive(
        message({ kind: "ambient", conversationKey, content: "When does it ship?" }),
      ),
    );
    const { externalConversationId } = await row(first.externalMessageId);
    const decision = await job(`team_chat.ambient:${externalConversationId}`);
    expect(decision?.queue_name).toBe(`team_chat.ambient:${externalConversationId}`);

    await chat.ambientJob(externalConversationId);
    const [morning, question] = [
      await row(first.externalMessageId),
      await row(second.externalMessageId),
    ];
    expect({
      judged: judge.decide.mock.calls.length,
      morning: morning.status,
      question: question.status,
      run: continued.includes(question.runId!),
    }).toEqual({ judged: 1, morning: "ignored", question: "running", run: true });
  });
});
