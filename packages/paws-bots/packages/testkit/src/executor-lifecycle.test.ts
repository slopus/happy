import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  DestinationEmulator,
  releaseComputerExecutionLease,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import {
  createDb,
  createThreadEvents,
  createThreadMessage,
  loadRunHistoryMessages,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration("run executor lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const destination = new DestinationEmulator();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-executor-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      connectors: [destination],
    });
    db = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows only one worker to claim a queued run", async () => {
    const seeded = await seedRun("concurrent", "write a file that says one-claim");

    await Promise.all([
      runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "worker-a"),
      ),
      runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "worker-b"),
      ),
    ]);

    const [run, attempts] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 1, status: "completed" });
  });

  it("reclaims an expired running lease with a higher fence", async () => {
    const seeded = await seedRun("expired", "write a file that says recovered", {
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    });

    await runAsSystem("background job run.continue", () =>
      handles.executor.continueRun(seeded.run.id, "recovery-worker"),
    );

    const [run, attempts] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(run.leaseFence).toBe(8);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 8, status: "completed" });
  });

  it.each(["completed", "cancelled"])("does not rerun a %s run", async (status) => {
    const seeded = await seedRun(`terminal-${status}`, "write a destination record", {
      status,
      completedAt: new Date(),
    });
    const recordsBefore = destination.records.length;

    await runAsSystem("background job run.continue", () =>
      handles.executor.continueRun(seeded.run.id, "late-worker"),
    );

    expect(await db.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(destination.records).toHaveLength(recordsBefore);
    await expect(db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).resolves.toMatchObject(
      { status },
    );
  });

  it("records an uncertain result without replaying an interrupted external effect", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("uncertain-effect", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    await db.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "executing",
        request: args,
      },
    });
    const recordsBefore = destination.records.length;

    await runAsSystem("background job run.continue", () =>
      handles.executor.continueRun(seeded.run.id, "retry-worker"),
    );

    const [run, attempt, effect] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      db.externalEffect.findUniqueOrThrow({ where: { idempotencyKey: executionId } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(attempt).toMatchObject({ status: "completed", error: null });
    expect(effect).toMatchObject({
      status: "uncertain",
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(destination.records).toHaveLength(recordsBefore);
    expect(
      await db.event.count({
        where: { runId: seeded.run.id, type: "effect.reconciled" },
      }),
    ).toBe(1);
  });

  it("recreates the approval pause when an intended effect was interrupted before the card", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("interrupted-before-approval", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    const effect = await db.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "intended",
        request: args,
      },
    });
    await db.userActionApprovalRule.create({
      data: {
        userId: seeded.me.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "destination.write",
      },
    });
    const recordsBefore = destination.records.length;

    await runAsSystem("background job run.continue", () =>
      handles.executor.continueRun(seeded.run.id, "retry-worker"),
    );

    const [run, attempt, message] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      db.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      }),
    ]);
    expect(run.status).toBe("waiting_input");
    expect(attempt.status).toBe("waiting_input");
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ask", approvalEffectId: effect.id, status: "pending" }),
      ]),
    );
    expect(destination.records).toHaveLength(recordsBefore);
  });

  it("fences concurrent terminal commits so only one final message is durable", async () => {
    const seeded = await seedRun("terminal-fence", "finish once", {
      status: "running",
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await db.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    const input = {
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: "the one final answer" }],
    };

    const results = await Promise.all([
      runAsSystem("background job run.continue", () => events.finalizeRun(input)),
      runAsSystem("background job run.continue", () => events.finalizeRun(input)),
    ]);

    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(results.filter(Boolean)).toEqual([{ continuationRunId: null }]);
    const [run, storedAttempt, task, messages, terminalEvents] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      db.message.findMany({ where: { runId: seeded.run.id } }),
      db.event.findMany({
        where: {
          runId: seeded.run.id,
          type: { in: ["thread.message.created", "run.completed"] },
        },
        orderBy: { seq: "asc" },
      }),
    ]);
    expect(run).toMatchObject({ status: "completed", leaseOwner: null, leaseExpiresAt: null });
    expect(storedAttempt.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(messages).toHaveLength(1);
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "thread.message.created",
      "run.completed",
    ]);
  });

  it("rolls back every terminal write when the atomic commit fails", async () => {
    const seeded = await seedRun("terminal-rollback", "do not partially finish", {
      status: "running",
      leaseOwner: "rollback-worker",
      leaseFence: 9,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await db.attempt.create({
      data: { runId: seeded.run.id, fence: 9, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);

    await expect(
      runAsSystem("background job run.continue", () =>
        events.finalizeRun({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          taskId: seeded.task.id,
          attemptId: "missing-attempt",
          leaseOwner: "rollback-worker",
          leaseFence: 9,
          outcome: "completed",
          blocks: [{ kind: "text", text: "must roll back" }],
        }),
      ),
    ).rejects.toThrow();

    await expect(db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).resolves.toMatchObject(
      { status: "running", leaseOwner: "rollback-worker" },
    );
    await expect(
      db.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ status: "running", finishedAt: null });
    await expect(
      db.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await db.message.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(await db.event.count({ where: { runId: seeded.run.id } })).toBe(0);
  });

  it("coalesces steering that races finalization into one durable continuation", async () => {
    const seeded = await seedRun("steering-race", "start the analysis", {
      status: "running",
      leaseOwner: "steering-worker",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await db.attempt.create({
      data: { runId: seeded.run.id, fence: 3, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    for (const text of ["Use the revised data.", "Keep it concise."]) {
      await runAsTenant(seeded.me, () =>
        events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text }],
          prompt: text,
          trigger: "follow_up",
        }),
      );
    }

    const finalized = await runAsSystem("background job run.continue", () =>
      events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: attempt.id,
        leaseOwner: "steering-worker",
        leaseFence: 3,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Initial answer" }],
      }),
    );

    if (!finalized) throw new Error("Expected the active run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const [continuation, steering] = await Promise.all([
      db.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
      db.steeringMessage.findMany({
        where: { botId: seeded.bot.id },
        orderBy: { message: { seq: "asc" } },
      }),
    ]);
    expect(continuation).toMatchObject({ status: "queued", trigger: "follow_up" });
    expect(continuation.task.prompt).toBe("Respond to the user's steering context.");
    expect(steering).toHaveLength(2);
    expect(steering).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
      ]),
    );
    const userMessages = await db.message.findMany({
      where: { threadId: seeded.thread.id, role: "user" },
      orderBy: { seq: "asc" },
    });
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.seq).toBeLessThan(userMessages[1]!.seq);
  });

  it.each([
    { claim: false, fresh: false, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "failed" as const },
    { claim: false, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "completed" as const },
  ])("bounds steering recovery ($claim, $fresh, $outcome)", async ({ claim, fresh, outcome }) => {
    const seeded = await seedRun(`steering-${claim}-${fresh}-${outcome}`, "start the analysis", {
      status: "running",
      leaseOwner: "failure-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await db.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    await runAsTenant(seeded.me, () =>
      events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "Recover this context." }],
        prompt: "Recover this context.",
        trigger: "follow_up",
      }),
    );
    await expect(
      runAsSystem("background job run.continue", () =>
        events.claimSteering({
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          leaseOwner: "failure-worker",
          leaseFence: 4,
          seenIds: [],
        }),
      ),
    ).resolves.toHaveLength(1);

    const finalized = await runAsSystem("background job run.continue", () =>
      events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: attempt.id,
        leaseOwner: "failure-worker",
        leaseFence: 4,
        outcome: "failed",
        error: "provider failed",
      }),
    );
    if (!finalized) throw new Error("Expected the failed run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    await expect(
      db.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      trigger: "follow_up",
      task: { prompt: "Respond to the user's steering context." },
    });
    await expect(
      db.steeringMessage.findFirstOrThrow({ where: { botId: seeded.bot.id } }),
    ).resolves.toMatchObject({ runId: continuationRunId, claimedAt: null });

    const lease = { leaseOwner: "failure-worker", leaseFence: 1 };
    async function startContinuation(runId: string) {
      const run = await db.run.update({
        where: { id: runId },
        data: { status: "running", ...lease },
      });
      const attempt = await db.attempt.create({
        data: { runId, fence: lease.leaseFence, status: "running" },
      });
      return {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: run.taskId,
        runId,
        attemptId: attempt.id,
        ...lease,
      };
    }

    const continuation = await startContinuation(continuationRunId!);
    if (claim) {
      await expect(
        runAsSystem("background job run.continue", () =>
          events.claimSteering({ ...continuation, seenIds: [] }),
        ),
      ).resolves.toHaveLength(1);
    }
    // A failure before claimSteering (such as missing model configuration) must also stop.
    const freshMessage = fresh
      ? await runAsTenant(seeded.me, () =>
          events.sendUserMessage({
            spaceId: seeded.me.spaceId,
            threadId: seeded.thread.id,
            botId: seeded.bot.id,
            userId: seeded.me.userId,
            blocks: [{ kind: "text", text: "Try this new instruction." }],
            prompt: "Try this new instruction.",
            trigger: "follow_up",
          }),
        )
      : null;
    const recovered = await runAsSystem("background job run.continue", () =>
      events.finalizeRun({
        ...continuation,
        ...(outcome === "completed"
          ? { outcome, blocks: [] }
          : { outcome, error: "provider failed" }),
      }),
    );
    if (!recovered) throw new Error("Expected the continuation to finalize");
    if (freshMessage) {
      expect(recovered.continuationRunId).toEqual(expect.any(String));
      const next = await startContinuation(recovered.continuationRunId!);
      await expect(
        runAsSystem("background job run.continue", () =>
          events.claimSteering({ ...next, seenIds: [] }),
        ),
      ).resolves.toEqual([expect.objectContaining({ messageId: freshMessage.messageId })]);
      await expect(
        runAsSystem("background job run.continue", () =>
          events.finalizeRun({ ...next, outcome: "failed", error: "provider failed" }),
        ),
      ).resolves.toEqual({ continuationRunId: null });
    } else {
      expect(recovered.continuationRunId).toBeNull();
    }
    expect(
      await db.run.count({
        where: { botId: seeded.bot.id, trigger: { not: "created" } },
      }),
    ).toBe(fresh ? 3 : 2);
    expect(await db.run.count({ where: { botId: seeded.bot.id, status: "queued" } })).toBe(0);
    // Settled steering cannot be reclaimed by unrelated future runs; chat history is retained.
    expect(await db.steeringMessage.count({ where: { botId: seeded.bot.id, runId: null } })).toBe(
      0,
    );
    expect(await db.message.count({ where: { threadId: seeded.thread.id, role: "user" } })).toBe(
      fresh ? 2 : 1,
    );
    if (outcome === "completed") {
      expect(await db.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(0);
    }
  });

  it("discards pending steering when the user stops active work", async () => {
    const seeded = await seedRun("steering-stop", "keep working", {
      status: "running",
      leaseOwner: "stop-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    await rpc(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "Context that should stop with the run.",
      clientNonce: `stop-steering-${stamp}`,
    });

    await rpc(seeded.cookie, "threads/stop", { botId: seeded.bot.id });

    await expect(db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).resolves.toMatchObject(
      { status: "cancelled" },
    );
    expect(await db.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(0);
    expect(
      await db.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
  });

  it("turns a regular bot-thread send during active work into steering", async () => {
    const seeded = await seedRun("bot-steering-send", "keep working", {
      status: "running",
      leaseOwner: "busy-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Use this additional context.",
      clientNonce: `bot-steering-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(
      await db.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
    expect(
      await db.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      db.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id, claimedAt: null });
  });

  it("turns a send during waiting takeover into steering", async () => {
    const seeded = await seedRun("bot-steering-takeover", "keep working", {
      status: "waiting_takeover",
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Skip that and tell me what you were going to check.",
      clientNonce: `bot-steering-takeover-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(
      await db.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
    expect(
      await db.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      db.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id });
  });

  it("applies the same no-parallel-run rule to the targeted group member", async () => {
    const cookie = await signup(
      `executor-group-steering-${stamp}@rakazo.test`,
      "Executor group steering",
    );
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const botA = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group lead",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const botB = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const group = await rpc<{ id: string }>(cookie, "groups/create", {
      name: "Steering group",
      botIds: [botA.id, botB.id],
    });
    const thread = await db.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const member = await db.chatGroupMember.findFirstOrThrow({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    const task = await db.task.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        userId: me.userId,
        prompt: "keep working",
        status: "queued",
      },
    });
    const activeRun = await db.run.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "group-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      },
    });

    await rpc(cookie, "threads/send", {
      groupId: group.id,
      text: "Use this group context.",
      mentions: [{ kind: "bot", id: member.botId }],
      clientNonce: `group-steering-${stamp}`,
    });

    expect(await db.run.count({ where: { threadId: thread.id } })).toBe(1);
    await expect(
      db.steeringMessage.findFirstOrThrow({
        where: { botId: member.botId, message: { threadId: thread.id } },
      }),
    ).resolves.toMatchObject({ runId: activeRun.id, claimedAt: null });

    const otherBotId = botA.id === member.botId ? botB.id : botA.id;
    const mixedInput = {
      groupId: group.id,
      text: "Use both agents.",
      mentions: [
        { kind: "bot", id: member.botId },
        { kind: "bot", id: otherBotId },
      ],
      clientNonce: `group-mixed-${stamp}`,
    };
    const first = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    const replay = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    expect(first.runIds).toHaveLength(2);
    expect(replay.runIds).toEqual(first.runIds);
    expect(await db.run.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it("leaves private steering for a private continuation and excludes it from group recovery", async () => {
    const seeded = await seedRun("channel-steering", "Group request", {
      status: "running",
      leaseOwner: "channel-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const scope = { ...seeded.me, threadId: seeded.thread.id, botId: seeded.bot.id };
    const events = createThreadEvents(handles.prisma);
    await runAsSystem("test fixture", () =>
      createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Older private detail" }],
      }),
    );
    const channel = {
      kind: "channel_message" as const,
      provider: "fake",
      channelId: "fake-group",
      fromAddress: "sender",
      fromLabel: "Sender",
      text: "Group request",
      hop: 0,
    };
    const source = await runAsSystem("test fixture", () =>
      createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        blocks: [channel],
      }),
    );
    await db.run.update({
      where: { id: seeded.run.id },
      data: { trigger: "messaging", sourceMessageId: source.id },
    });
    await runAsSystem("test fixture", () =>
      createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        blocks: [{ ...channel, channelId: "other-group", text: "Other group detail" }],
      }),
    );
    const privateDm = await runAsSystem("messaging inbound", () =>
      events.sendUserMessage({
        ...scope,
        trigger: "messaging",
        blocks: [{ kind: "text", text: "Private DM detail" }],
        prompt: "Private DM detail",
      }),
    );
    const privateSend = await rpc<{ runId: string }>(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "New private detail",
      clientNonce: `private-channel-${stamp}`,
    });
    expect(privateSend.runId).toBe(seeded.run.id);
    const privateMessage = await db.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: seeded.thread.id,
          clientNonce: `private-channel-${stamp}`,
        },
      },
    });
    const publicSend = await runAsSystem("messaging inbound", () =>
      events.sendUserMessage({
        ...scope,
        trigger: "messaging",
        blocks: [{ ...channel, text: "Group follow-up" }],
        prompt: "Group follow-up",
      }),
    );
    const fence = { ...scope, runId: seeded.run.id, leaseOwner: "channel-worker", leaseFence: 1 };
    const claimed = await runAsSystem("background job run.continue", () =>
      events.claimSteering({ ...fence, seenIds: [] }),
    );
    expect(claimed.map((item) => item.messageId)).toEqual([publicSend.messageId]);
    const history = await runAsSystem("background job run.continue", () =>
      loadRunHistoryMessages(handles.prisma, seeded.run, 100, channel.channelId),
    );
    expect(history.map((message) => message.id).sort()).toEqual(
      [source.id, publicSend.messageId].sort(),
    );
    const attempt = await db.attempt.create({
      data: { runId: seeded.run.id, fence: 1, status: "running" },
    });
    const result = await runAsSystem("background job run.continue", () =>
      events.finalizeRun({
        ...fence,
        taskId: seeded.task.id,
        attemptId: attempt.id,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Public reply" }],
      }),
    );
    if (result === false || !result.continuationRunId)
      throw new Error("Missing private continuation");
    const continuation = await db.run.findUniqueOrThrow({
      where: { id: result.continuationRunId },
    });
    // The direct-line delivery in the batch keeps the continuation from counting as owner-started.
    expect(continuation).toMatchObject({
      trigger: "messaging",
      sourceMessageId: privateMessage.id,
    });
    const steering = await db.steeringMessage.findUniqueOrThrow({
      where: { messageId_botId: { messageId: privateMessage.id, botId: seeded.bot.id } },
    });
    expect(steering).toMatchObject({ runId: continuation.id, claimedAt: null });
    expect(
      await db.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: privateDm.messageId, botId: seeded.bot.id } },
      }),
    ).toMatchObject({ runId: continuation.id, claimedAt: null });
    // A later group run gets channel inputs, without either run's private context or bot answers.
    expect(
      (
        await runAsSystem("background job run.continue", () =>
          loadRunHistoryMessages(
            handles.prisma,
            { ...seeded.run, id: "next-group-run" },
            100,
            channel.channelId,
          ),
        )
      )
        .map((message) => message.id)
        .sort(),
    ).toEqual([source.id, publicSend.messageId].sort());
  });

  it("waits out a failover while finishing a turn instead of failing or rerunning it", async () => {
    const seeded = await seedRun("failover-finish", "write a file that says failover-finish");
    const failover = await failNext(
      "failover_finish",
      "UPDATE ON runs",
      `NEW.id = '${seeded.run.id}' AND NEW.status = 'completed' AND OLD.status <> 'completed'`,
    );
    try {
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "worker-a"),
      );
      expect(await failover.fired()).toBe(true);
    } finally {
      await failover.drop();
    }

    const [run, attempts] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null, leaseFence: 1 });
    expect(attempts.map(({ fence, status }) => ({ fence, status }))).toEqual([
      { fence: 1, status: "completed" },
    ]);
    expect(await repliesOf(seeded.run.id)).toBe(1);
  });

  it("resumes a turn the database interrupted at once instead of failing it", async () => {
    const seeded = await seedRun("failover-turn", "write a file that says failover-turn");
    const failover = await failNext(
      "failover_turn",
      "INSERT ON events",
      `NEW."runId" = '${seeded.run.id}' AND NEW.type = 'agent.tool.called'`,
    );
    try {
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "worker-a"),
      );
      // The interrupted attempt hands the run back, and its next attempt starts at once.
      await expect
        .poll(
          async () => (await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).status,
          {
            timeout: 10_000,
          },
        )
        .toBe("completed");
      expect(await failover.fired()).toBe(true);
    } finally {
      await failover.drop();
    }

    const [run, attempts] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.attempt.findMany({ where: { runId: seeded.run.id }, orderBy: { fence: "asc" } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null, leaseFence: 2 });
    expect(attempts.map(({ fence, status }) => ({ fence, status }))).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await repliesOf(seeded.run.id)).toBe(1);
  });

  it("recovers a computer a crashed worker left booting", async () => {
    const seeded = await seedRun("stale-boot", "write a file that says recovered");
    const bot = await db.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;
    expect(computerId).toBeTruthy();

    // A worker killed between the boot claim and its own failure handler: the row keeps
    // "booting" and its execution lease is gone. Age the claim stamp past the execution-lease
    // TTL so reclaim treats it as abandoned, not a live mid-provision claim.
    await db.computerExecutionLease.deleteMany({ where: { computerId } });
    await db.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        // Matches BOOT_CLAIM_STALE_MS (execution-lease TTL) plus a small cushion.
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    await runAsSystem("background job run.continue", () =>
      handles.executor.continueRun(seeded.run.id, "worker-stale-boot"),
    );

    const computer = await db.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(computer.state).toBe("running");
    const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.status).toBe("completed");
  });

  it("leaves a booting computer alone while its worker still holds the lease", async () => {
    const seeded = await seedRun("live-boot", "write a file that says waited");
    const bot = await db.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;

    await db.computerExecutionLease.deleteMany({ where: { computerId } });
    await db.computerExecutionLease.create({
      data: {
        computerId,
        botId: "another-bot",
        runId: "run-still-booting",
        fence: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    // Age past BOOT_CLAIM_STALE_MS so reclaim reaches the live foreign-lease check
    // instead of refusing on a fresh mid-provision stamp.
    await db.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    try {
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "worker-live-boot"),
      );

      const computer = await db.computer.findUniqueOrThrow({
        where: { id: computerId },
      });
      expect(computer.state).toBe("booting");
      const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
      expect(run.status).not.toBe("completed");
    } finally {
      // Shared Postgres journeys reuse one database. Leave this run terminal and the computer
      // unblocked so later suites' reconcilers do not keep retrying a wedged boot forever.
      await db.computerExecutionLease.deleteMany({ where: { computerId } });
      await db.computer.update({
        where: { id: computerId },
        data: { state: "error", providerRef: "" },
      });
      await db.run.updateMany({
        where: { id: seeded.run.id, status: { notIn: ["completed", "failed", "cancelled"] } },
        data: {
          status: "failed",
          error: "test cleanup after live-boot lease check",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    }
  });

  it("allocates dedicated screen fences monotonically on PostgreSQL and retains the expired tombstone", async () => {
    const seeded = await seedRun(
      "dedicated-screen-fence-postgres",
      "exercise dedicated screen fencing",
      {
        status: "running",
        leaseOwner: "worker-first",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
      "dedicated",
    );
    const activeRunIds = [seeded.run.id];

    try {
      const bot = await db.bot.findUniqueOrThrow({
        where: { id: seeded.bot.id },
        select: { computerId: true, computer: { select: { scope: true } } },
      });
      expect(bot.computer?.scope).toBe("dedicated");
      if (!bot.computerId) throw new Error("Dedicated bot has no assigned computer");
      const computerId = bot.computerId;
      await createRunForBot(seeded, "legacy-screen-fence", {
        status: "completed",
        leaseFence: 7,
        completedAt: new Date(),
      });

      // A mode switch holds the computer first; deletion holds the bot first.
      // Allocation must requeue without waiting in either case (including a locked run).
      for (const locked of ["bot", "computer", "run"] as const) {
        await db.$transaction(async (tx) => {
          if (locked === "bot") {
            await tx.$queryRaw`SELECT id FROM bots WHERE id = ${seeded.bot.id} FOR UPDATE`;
          } else if (locked === "computer") {
            await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
          } else {
            await tx.$queryRaw`SELECT id FROM runs WHERE id = ${seeded.run.id} FOR UPDATE`;
          }
          await expect(
            acquireDedicatedScreenLeaseFence(db, {
              computerId,
              runId: seeded.run.id,
              botId: seeded.bot.id,
              workerId: "worker-first",
              runFence: 1,
            }),
          ).rejects.toBeInstanceOf(ComputerBusyError);
          // The unsuccessful allocator released any earlier locks.
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${seeded.bot.id} FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE NOWAIT`;
        });
      }

      const first = await acquireDedicatedScreenLeaseFence(db, {
        computerId,
        runId: seeded.run.id,
        botId: seeded.bot.id,
        workerId: "worker-first",
        runFence: 1,
      });
      expect(first.fence).toBe(8);
      await releaseComputerExecutionLease(db, first);
      const leaseKey = { computerId_botId: { computerId, botId: seeded.bot.id } };
      await expect(
        db.computerExecutionLease.findUniqueOrThrow({ where: leaseKey }),
      ).resolves.toMatchObject({
        runId: seeded.run.id,
        fence: 8,
        expiresAt: new Date(0),
      });

      const laterRun = await createRunForBot(seeded, "later-dedicated-run", {
        status: "running",
        leaseOwner: "worker-later",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      activeRunIds.push(laterRun.id);
      const later = await acquireDedicatedScreenLeaseFence(db, {
        computerId,
        runId: laterRun.id,
        botId: seeded.bot.id,
        workerId: "worker-later",
        runFence: 2,
      });
      expect(later.fence).toBe(9);

      await releaseComputerExecutionLease(db, later);
      const staleRun = await createRunForBot(seeded, "stale-dedicated-worker", {
        status: "running",
        leaseOwner: "worker-current",
        leaseFence: 4,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      activeRunIds.push(staleRun.id);
      await expect(
        acquireDedicatedScreenLeaseFence(db, {
          computerId,
          runId: staleRun.id,
          botId: seeded.bot.id,
          workerId: "worker-stale",
          runFence: 3,
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await expect(
        db.computerExecutionLease.findUniqueOrThrow({ where: leaseKey }),
      ).resolves.toMatchObject({
        fence: 9,
        runId: laterRun.id,
        expiresAt: new Date(0),
      });

      const parallelRuns = await Promise.all([
        createRunForBot(seeded, "parallel-dedicated-run-a", {
          status: "running",
          leaseOwner: "worker-parallel-a",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
        createRunForBot(seeded, "parallel-dedicated-run-b", {
          status: "running",
          leaseOwner: "worker-parallel-b",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ]);
      activeRunIds.push(...parallelRuns.map((run) => run.id));
      const allocateParallel = (run: (typeof parallelRuns)[number], index: number) =>
        acquireDedicatedScreenLeaseFence(db, {
          computerId,
          runId: run.id,
          botId: seeded.bot.id,
          workerId: index === 0 ? "worker-parallel-a" : "worker-parallel-b",
          runFence: 1,
        });
      const attempts = await Promise.allSettled(parallelRuns.map(allocateParallel));
      const parallelLeases = [];
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      // Release the winner before retrying a competing worker, irrespective of order.
      for (const attempt of attempts) {
        if (attempt.status === "fulfilled") {
          await releaseComputerExecutionLease(db, attempt.value);
        }
      }
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status === "fulfilled") {
          parallelLeases.push(attempt.value);
        } else {
          expect(attempt.reason).toBeInstanceOf(ComputerBusyError);
          // Match the worker's retry after the competing allocation completes.
          const lease = await allocateParallel(parallelRuns[index]!, index);
          parallelLeases.push(lease);
          await releaseComputerExecutionLease(db, lease);
        }
      }
      expect(parallelLeases.map((lease) => lease.fence).sort((a, b) => a - b)).toEqual([10, 11]);
      await expect(
        db.computerExecutionLease.findUniqueOrThrow({ where: leaseKey }),
      ).resolves.toMatchObject({
        fence: 11,
        expiresAt: new Date(0),
      });
    } finally {
      await db.run.updateMany({
        where: { id: { in: activeRunIds }, status: "running" },
        data: {
          status: "failed",
          error: "test cleanup after dedicated screen-fence regression",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    }
  });

  it("resumes its own dedicated screen and admits other runs only after expiry or pause", async () => {
    const seeded = await seedRun(
      "dedicated-screen-lifetime",
      "exercise lease lifetime",
      {
        status: "running",
        leaseOwner: "worker-first",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
      "dedicated",
    );
    const bot = await db.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;
    const input = {
      computerId,
      botId: bot.id,
      runId: seeded.run.id,
      workerId: "worker-first",
      runFence: 1,
    };
    const first = await acquireDedicatedScreenLeaseFence(db, input);
    const resumed = await acquireDedicatedScreenLeaseFence(db, input);
    expect(resumed.fence).toBe(first.fence + 1);
    const other = await createRunForBot(seeded, "competing-screen", {
      status: "running",
      leaseOwner: "worker-other",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const otherInput = { ...input, runId: other.id, workerId: "worker-other" };
    await expect(acquireDedicatedScreenLeaseFence(db, otherInput)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    await db.computerExecutionLease.updateMany({
      where: { runId: seeded.run.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const reclaimed = await acquireDedicatedScreenLeaseFence(db, otherInput);
    expect(reclaimed.fence).toBe(resumed.fence + 1);
    const attempt = await db.attempt.create({
      data: { runId: other.id, fence: 1, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    await expect(
      runAsSystem("background job run.continue", () =>
        events.pauseRunForInput({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: bot.id,
          runId: other.id,
          attemptId: attempt.id,
          leaseOwner: "worker-other",
          leaseFence: 1,
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
      ),
    ).resolves.toEqual({ continuationRunId: null });
    const afterPause = await acquireDedicatedScreenLeaseFence(db, input);
    expect(afterPause.fence).toBe(reclaimed.fence + 1);
    // A stale cleanup must not expire a successor's lease.
    await releaseComputerExecutionLease(db, reclaimed);
    const held = await db.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId: bot.id } },
    });
    expect(held.fence).toBe(afterPause.fence);
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await releaseComputerExecutionLease(db, afterPause);
    await db.run.update({
      where: { id: seeded.run.id },
      data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
    });
  });

  it("isolates Team leases and rejects unassigned bots and live dedicated lease conflicts on PostgreSQL", async () => {
    const dedicated = await seedRun(
      "dedicated-fence-owner-postgres",
      "exercise dedicated ownership",
      {
        status: "running",
        leaseOwner: "worker-dedicated",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
      "dedicated",
    );
    const team = await seedRun("team-fence-isolation-postgres", "exercise team isolation", {
      status: "running",
      leaseOwner: "worker-team",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const activeRunIds = [dedicated.run.id, team.run.id];
    let teamLease: Awaited<ReturnType<typeof acquireComputerExecutionLease>> = null;
    let conflictingLease: {
      computerId: string;
      botId: string;
      runId: string;
      fence: number;
    } | null = null;

    try {
      const [dedicatedBot, teamBot] = await Promise.all([
        db.bot.findUniqueOrThrow({
          where: { id: dedicated.bot.id },
          select: { computerId: true, computer: { select: { scope: true } } },
        }),
        db.bot.findUniqueOrThrow({
          where: { id: team.bot.id },
          select: { computerId: true, computer: { select: { scope: true } } },
        }),
      ]);
      expect(dedicatedBot.computer?.scope).toBe("dedicated");
      expect(teamBot.computer?.scope).toBe("team");
      if (!dedicatedBot.computerId || !teamBot.computerId)
        throw new Error("Fence fixture bot has no assigned computer");

      await expect(
        acquireDedicatedScreenLeaseFence(db, {
          computerId: dedicatedBot.computerId,
          runId: team.run.id,
          botId: team.bot.id,
          workerId: "worker-team",
          runFence: 1,
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await expect(
        db.computerExecutionLease.findUnique({
          where: { computerId_botId: { computerId: dedicatedBot.computerId, botId: team.bot.id } },
        }),
      ).resolves.toBeNull();

      teamLease = await acquireComputerExecutionLease(db, {
        computerId: teamBot.computerId,
        runId: team.run.id,
        botId: team.bot.id,
      });
      expect(teamLease).not.toBeNull();
      if (!teamLease) throw new Error("Team execution did not receive its lease");
      const teamLeaseBefore = await db.computerExecutionLease.findUniqueOrThrow({
        where: { computerId_botId: { computerId: teamBot.computerId, botId: team.bot.id } },
      });
      await expect(
        acquireDedicatedScreenLeaseFence(db, {
          computerId: teamBot.computerId,
          runId: team.run.id,
          botId: team.bot.id,
          workerId: "worker-team",
          runFence: 1,
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      const teamLeaseAfter = await db.computerExecutionLease.findUniqueOrThrow({
        where: { computerId_botId: { computerId: teamBot.computerId, botId: team.bot.id } },
      });
      expect(teamLeaseAfter).toMatchObject({ runId: teamLease.runId, fence: teamLease.fence });
      expect(teamLeaseAfter.expiresAt).toEqual(teamLeaseBefore.expiresAt);

      conflictingLease = {
        computerId: dedicatedBot.computerId,
        botId: dedicated.bot.id,
        runId: "foreign-live-lease",
        fence: 23,
      };
      const heldUntil = new Date(Date.now() + 60_000);
      await db.computerExecutionLease.create({
        data: { ...conflictingLease, expiresAt: heldUntil },
      });
      await expect(
        acquireDedicatedScreenLeaseFence(db, {
          computerId: dedicatedBot.computerId,
          runId: dedicated.run.id,
          botId: dedicated.bot.id,
          workerId: "worker-dedicated",
          runFence: 1,
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await expect(
        db.computerExecutionLease.findUniqueOrThrow({
          where: {
            computerId_botId: { computerId: dedicatedBot.computerId, botId: dedicated.bot.id },
          },
        }),
      ).resolves.toMatchObject({ ...conflictingLease, expiresAt: heldUntil });
    } finally {
      await releaseComputerExecutionLease(db, teamLease);
      await releaseComputerExecutionLease(db, conflictingLease);
      await db.run.updateMany({
        where: { id: { in: activeRunIds }, status: "running" },
        data: {
          status: "failed",
          error: "test cleanup after Team/dedicated isolation regression",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    }
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
    computerMode?: "team" | "dedicated",
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    if (computerMode) await rpc(cookie, "bots/setComputer", { botId: bot.id, mode: computerMode });
    const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await db.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await db.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function createRunForBot(
    seeded: Awaited<ReturnType<typeof seedRun>>,
    label: string,
    runState: {
      status: string;
      leaseFence: number;
      leaseOwner?: string;
      leaseExpiresAt?: Date;
      completedAt?: Date;
    },
  ) {
    const task = await db.task.create({
      data: {
        spaceId: seeded.me.spaceId,
        botId: seeded.bot.id,
        threadId: seeded.thread.id,
        userId: seeded.me.userId,
        prompt: label,
        status: "queued",
      },
    });
    return db.run.create({
      data: {
        spaceId: seeded.me.spaceId,
        botId: seeded.bot.id,
        threadId: seeded.thread.id,
        taskId: task.id,
        userId: seeded.me.userId,
        trigger: "user",
        ...runState,
      },
    });
  }

  function repliesOf(runId: string) {
    return db.event.count({ where: { runId, type: "thread.message.created" } });
  }

  /**
   * Makes the next write matching `when` fail as a database shutting down for a failover
   * would; later writes go through.
   */
  async function failNext(name: string, operation: string, when: string) {
    const owner = createDb(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!);
    const sql = (statement: string) => owner.prisma.$executeRawUnsafe(statement);
    await sql(`CREATE SEQUENCE ${name}_attempts`);
    await sql(`CREATE FUNCTION ${name}() RETURNS trigger SECURITY DEFINER AS $$
      BEGIN
        IF nextval('${name}_attempts') = 1 THEN
          RAISE EXCEPTION 'the database system is shutting down' USING ERRCODE = '57P01';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await sql(`CREATE TRIGGER ${name} BEFORE ${operation} FOR EACH ROW
      WHEN (${when}) EXECUTE FUNCTION ${name}()`);
    return {
      fired: async () => {
        const [row] = await owner.prisma.$queryRawUnsafe<{ attempts: bigint }[]>(
          `SELECT last_value AS attempts FROM ${name}_attempts`,
        );
        return Number(row?.attempts) > 1;
      },
      drop: async () => {
        await sql(`DROP TRIGGER IF EXISTS ${name} ON ${operation.split(" ").at(-1)}`);
        await sql(`DROP FUNCTION IF EXISTS ${name}()`);
        await sql(`DROP SEQUENCE IF EXISTS ${name}_attempts`);
        await owner.prisma.$disconnect();
        await owner.pool.end();
      },
    };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return discardBotIntroFromCreate(handles, cookie, procedure, payload.json as T);
  }
});
