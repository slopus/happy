import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BackgroundJobHandlers, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { stuckWorkStatusMessage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  appendEventInTransaction,
  asSystem,
  createDb,
  createThreadEvents,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { RunJobPublisher, RunStarter, RunWorkerHost } from "./run-wakeup.js";
import { GraphileJobPublisher } from "./wakeup.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("direct run dispatch (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `dispatch-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("direct dispatch fixture", () =>
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
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function createRun(
    data: { status?: string; wakeAt?: Date; leaseExpiresAt?: Date; trigger?: string } = {},
  ) {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "queued" },
    });
    return system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
        ...data,
      },
    });
  }
  const background = () =>
    ({
      enqueue: vi.fn(async () => {
        throw new Error("scheduler must not receive chat");
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    }) as unknown as JobPublisher;
  const wait = async (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 5_000, interval: 20 });

  it("reports runs left unstarted, not retry backoff, fresh resumes, or waits on the bot's own earlier run", async () => {
    const now = Date.now();
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `queue-age-${randomUUID()}`,
        homeKey: `queue-age-${randomUUID()}`,
        kind: "fake",
      },
    });
    await system.bot.update({ where: { id: identity.botId }, data: { computerId: computer.id } });
    const owner = await createRun({ status: "running" });
    const retry = await createRun({ wakeAt: new Date(now - 5_000) });
    const delayed = await createRun({ wakeAt: new Date(now - 45_000) });
    await system.run.updateMany({
      where: { id: { in: [retry.id, delayed.id] } },
      data: { createdAt: new Date(now - 3_600_000), updatedAt: new Date(now - 3_600_000) },
    });
    const resumed = await createRun();
    await system.run.update({
      where: { id: resumed.id },
      data: { createdAt: new Date(now - 3_600_000) },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: identity.botId,
        runId: owner.id,
        expiresAt: new Date(now + 60_000),
      },
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const realtime = new InMemoryRealtimeFanout();
    const host = () => new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime));
    const waitingOnBot = host();
    const handoff = host();
    const unblocked = host();
    // A queue check that settles only after stop() drops its result without logging,
    // so a fixed sleep cannot prove the quiet phases below stay quiet. The queue
    // check is the host's only raw query; wait for it to settle while its host
    // still runs, then stop and assert.
    const queryRaw = db.prisma.$queryRaw.bind(db.prisma);
    let queueChecksSettled = 0;
    const querySpy = vi.spyOn(db.prisma, "$queryRaw").mockImplementation((async (
      query: unknown,
      ...values: unknown[]
    ) => {
      const result = queryRaw(query as never, ...(values as never[]));
      const settle = () => {
        queueChecksSettled += 1;
      };
      // A failed check counts too, and this side branch must not leave an
      // unhandled rejection: the host catches the error on its own branch.
      void Promise.resolve(result).then(settle, settle);
      return result;
    }) as never);
    const runOneQueueCheck = async (host: RunWorkerHost) => {
      const settled = queueChecksSettled;
      await host.start({} as BackgroundJobHandlers);
      await wait(() => expect(queueChecksSettled).toBeGreaterThan(settled));
      await host.stop();
    };
    try {
      // Waiting for the bot's own earlier run is expected, not a failure to start.
      await runOneQueueCheck(waitingOnBot);
      expect(sink.events.some((event) => event.message === "run.queue_delayed")).toBe(false);

      // A release moments ago is the handoff to the bot's next run.
      await system.computerExecutionLease.update({
        where: { id: lease.id },
        data: { expiresAt: new Date(0) },
      });
      await runOneQueueCheck(handoff);
      expect(sink.events.some((event) => event.message === "run.queue_delayed")).toBe(false);

      await system.computerExecutionLease.update({
        where: { id: lease.id },
        data: { updatedAt: new Date(now - 60_000) },
      });
      await unblocked.start({} as BackgroundJobHandlers);
      await wait(() =>
        expect(sink.events.some((event) => event.message === "run.queue_delayed")).toBe(true),
      );
      const warning = sink.events.find((event) => event.message === "run.queue_delayed")!;
      expect(warning.level).toBe("error");
      expect(warning["queue.delayed_runs"]).toBe(1);
      expect(warning["queue.oldest_run_id"]).toBe(delayed.id);
      expect(warning["queue.oldest_wait_ms"]).toBeGreaterThanOrEqual(45_000);
      expect(warning["queue.oldest_wait_ms"]).toBeLessThan(60_000);
    } finally {
      querySpy.mockRestore();
      await waitingOnBot.stop();
      await handoff.stop();
      await unblocked.stop();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      await system.run.updateMany({
        where: { id: { in: [owner.id, retry.id, delayed.id, resumed.id] } },
        data: { status: "cancelled" },
      });
      await system.computerExecutionLease.delete({ where: { id: lease.id } });
    }
  });

  it("keeps blocked rows unchanged, scans past them, and resumes after release or expiry", async () => {
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `dispatch-busy-${randomUUID()}`,
        homeKey: `dispatch-busy-${randomUUID()}`,
        kind: "fake",
      },
    });
    const bot = await system.bot.update({
      where: { id: identity.botId },
      data: { computerId: computer.id },
    });
    const blocked = await createRun();
    const owner = await createRun();
    const aged = await system.run.update({
      where: { id: blocked.id },
      data: { createdAt: new Date(0), updatedAt: new Date(0) },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const realtime = new InMemoryRealtimeFanout();
    const host = new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime), {
      intervalMs: 25,
      batchSize: 1,
    });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          await system.run.update({ where: { id: runId }, data: { status: "completed" } });
        },
      } as BackgroundJobHandlers);
      // A blocked oldest row must not starve the holder's explicit resume.
      await wait(() => expect(entered).toContain(owner.id));
      expect(entered).not.toContain(blocked.id);
      expect(await system.run.findUniqueOrThrow({ where: { id: blocked.id } })).toMatchObject({
        status: "queued",
        leaseFence: 0,
        startedAt: null,
        updatedAt: aged.updatedAt,
      });
      await system.computerExecutionLease.update({
        where: { id: lease.id },
        data: { expiresAt: new Date(0) },
      });
      await wait(() => expect(entered).toContain(blocked.id));
    } finally {
      await host.stop();
      await system.computerExecutionLease.delete({ where: { id: lease.id } });
    }
  });

  it("ends an untaken takeover wait so chat work for its bot can start", async () => {
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `dispatch-takeover-${randomUUID()}`,
        homeKey: `dispatch-takeover-${randomUUID()}`,
        kind: "fake",
      },
    });
    const bot = await system.bot.update({
      where: { id: identity.botId },
      data: { computerId: computer.id },
    });
    const waiting = await createRun({ status: "waiting_takeover" });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: waiting.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const reply = await createRun();
    const peer = await createRun({ trigger: "bot_message" });
    const routine = await createRun({ trigger: "routine" });
    const fanout = new InMemoryRealtimeFanout();
    const host = new RunWorkerHost(db.prisma, fanout, new RunStarter(fanout), { intervalMs: 25 });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          await system.run.update({ where: { id: runId }, data: { status: "completed" } });
        },
      } as BackgroundJobHandlers);
      await wait(() => expect(entered).toEqual(expect.arrayContaining([reply.id, peer.id])));
      expect(entered).not.toContain(waiting.id);
      expect(await system.run.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({
        status: "cancelled",
        error: stuckWorkStatusMessage("waiting_takeover"),
      });
      expect(
        await system.message.count({
          where: { threadId: identity.threadId, clientNonce: `stuck-expired:${waiting.id}` },
        }),
      ).toBe(1);
    } finally {
      await host.stop();
      await system.run.updateMany({
        where: { id: { in: [waiting.id, reply.id, peer.id, routine.id] } },
        data: { status: "cancelled" },
      });
      await system.computerExecutionLease.delete({ where: { id: lease.id } });
    }
  });

  it("leaves chat work queued behind a takeover the user is on the screen for", async () => {
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `dispatch-held-${randomUUID()}`,
        homeKey: `dispatch-held-${randomUUID()}`,
        kind: "fake",
      },
    });
    const bot = await system.bot.update({
      where: { id: identity.botId },
      data: { computerId: computer.id },
    });
    const waiting = await createRun({ status: "waiting_takeover" });
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlBotId: bot.id,
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: waiting.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const reply = await createRun();
    // Another bot's run shares the reply's scan; once it starts, that scan has decided the wait.
    const other = await system.bot.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, name: "Other", color: "test" },
    });
    const sentinel = await system.run.update({
      where: { id: (await createRun()).id },
      data: { botId: other.id },
    });
    const fanout = new InMemoryRealtimeFanout();
    const host = new RunWorkerHost(db.prisma, fanout, new RunStarter(fanout), { intervalMs: 25 });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          await system.run.update({ where: { id: runId }, data: { status: "completed" } });
        },
      } as BackgroundJobHandlers);
      await wait(() => expect(entered).toContain(sentinel.id));
      expect(entered).not.toContain(reply.id);
      expect(await system.run.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({
        status: "waiting_takeover",
      });
    } finally {
      await host.stop();
      await system.run.updateMany({
        where: { id: { in: [waiting.id, reply.id, sentinel.id] } },
        data: { status: "cancelled" },
      });
      await system.computerExecutionLease.delete({ where: { id: lease.id } });
    }
  });

  it("frees a computer held for a takeover by a run that was deleted or ended", async () => {
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `dispatch-abandoned-${randomUUID()}`,
        homeKey: `dispatch-abandoned-${randomUUID()}`,
        kind: "fake",
      },
    });
    const bot = await system.bot.update({
      where: { id: identity.botId },
      data: { computerId: computer.id },
    });
    const otherBot = (name: string) =>
      system.bot.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          name,
          color: "test",
          computerId: computer.id,
        },
      });
    const ended = await otherBot("Ended");
    const booting = await otherBot("Booting");
    const cancelled = await system.run.update({
      where: { id: (await createRun({ status: "cancelled" })).id },
      data: { botId: ended.id },
    });
    const day = new Date(Date.now() + 24 * 60 * 60_000);
    // Leases name their run without a relation, so deleting the run leaves the hold behind.
    const orphan = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: randomUUID(),
        fence: 4,
        expiresAt: day,
      },
    });
    const stale = await system.computerExecutionLease.create({
      data: { computerId: computer.id, botId: ended.id, runId: cancelled.id, expiresAt: day },
    });
    // A computer operation holds a short lease under an id that is not a run.
    const operation = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: booting.id,
        runId: `boot:${randomUUID()}`,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    const reply = await createRun();
    const endedReply = await system.run.update({
      where: { id: (await createRun()).id },
      data: { botId: ended.id },
    });
    const bootingReply = await system.run.update({
      where: { id: (await createRun()).id },
      data: { botId: booting.id },
    });
    const fanout = new InMemoryRealtimeFanout();
    const host = new RunWorkerHost(db.prisma, fanout, new RunStarter(fanout), { intervalMs: 25 });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          await system.run.update({ where: { id: runId }, data: { status: "completed" } });
        },
      } as BackgroundJobHandlers);
      await wait(() => expect(entered).toEqual(expect.arrayContaining([reply.id, endedReply.id])));
      expect(entered).not.toContain(bootingReply.id);
      // Expired as tombstones, so the next lease on each still raises the fence.
      expect(
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: orphan.id } }),
      ).toMatchObject({ fence: 4, expiresAt: new Date(0) });
      expect(
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: stale.id } }),
      ).toMatchObject({ expiresAt: new Date(0) });
      expect(
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: operation.id } }),
      ).toMatchObject({ expiresAt: operation.expiresAt });
    } finally {
      await host.stop();
      await system.run.updateMany({
        where: { id: { in: [reply.id, endedReply.id, bootingReply.id] } },
        data: { status: "cancelled" },
      });
      await system.computerExecutionLease.deleteMany({
        where: { id: { in: [orphan.id, stale.id, operation.id] } },
      });
    }
  });

  it("recovers an unnotified commit, deduplicates competing workers and drains active runs", async () => {
    const run = await createRun();
    const realtime = new InMemoryRealtimeFanout();
    const scheduler = background();
    const publisher = new RunJobPublisher(db.prisma, scheduler, new RunStarter(realtime));
    const hosts = [
      new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime), { intervalMs: 25 }),
      new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime), { intervalMs: 25 }),
    ];
    const claims: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = {
      "run.continue": async ({ runId }, execution) => {
        if (runId !== run.id) return;
        await runAsTenant(identity, async () => {
          const claimed = await db.prisma.run.updateMany({
            where: { id: runId, status: "queued", leaseFence: 0 },
            data: {
              status: "running",
              leaseFence: 1,
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
          if (!claimed.count) return;
          claims.push(runId);
          execution!.onRunStarted();
          await pending;
          await db.prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
        });
      },
    } as BackgroundJobHandlers;
    try {
      await Promise.all(hosts.map((host) => host.start(handlers)));
      await wait(() => expect(claims).toEqual([run.id]));
      await runAsTenant(identity, () => publisher.enqueue(runContinueJob(run.id)));
      await runAsTenant(identity, () => publisher.cancel(`run:${run.id}`));
      expect(scheduler.enqueue).not.toHaveBeenCalled();
      expect(scheduler.cancel).not.toHaveBeenCalled();
      let stopped = false;
      const stopping = Promise.all(hosts.map((host) => host.stop())).then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(claims).toEqual([run.id]);
    } finally {
      release();
      await Promise.all(hosts.map((host) => host.stop()));
    }
  });

  it("preserves delayed retries, recovers expired leases, and only resumes human waits after an explicit wake", async () => {
    const due = new Date(Date.now() + 60_000);
    const delayed = await createRun({ wakeAt: due });
    const expired = await createRun({ status: "running", leaseExpiresAt: new Date(0) });
    const waiting = await createRun({ status: "waiting_input" });
    const realtime = new InMemoryRealtimeFanout();
    vi.spyOn(realtime, "publish").mockRejectedValue(new Error("fixture notification lost"));
    const starter = new RunStarter(realtime);
    const publisher = new RunJobPublisher(db.prisma, background(), starter);
    const host = new RunWorkerHost(db.prisma, realtime, starter, { intervalMs: 25 });
    const entered: string[] = [];
    const handlers = {
      "run.continue": async ({ runId }) => {
        entered.push(runId);
        await system.run.update({ where: { id: runId }, data: { status: "completed" } });
      },
    } as BackgroundJobHandlers;
    try {
      await runAsTenant(identity, () =>
        publisher.enqueue({ ...runContinueJob(delayed.id), keepExisting: true }),
      );
      expect((await system.run.findUniqueOrThrow({ where: { id: delayed.id } })).wakeAt).toEqual(
        due,
      );
      await host.start(handlers);
      await wait(() => expect(entered).toContain(expired.id));
      expect(entered).not.toContain(waiting.id);
      expect(entered).not.toContain(delayed.id);
      await system.run.update({ where: { id: delayed.id }, data: { wakeAt: new Date(0) } });
      await runAsTenant(identity, () => publisher.enqueue(runContinueJob(waiting.id)));
      await wait(() => {
        expect(entered).toContain(delayed.id);
        expect(entered).toContain(waiting.id);
      });
    } finally {
      await host.stop();
    }
  });

  it("commits first response timing with output, once across retries, and rolls both back on failure", async () => {
    const run = await createRun({ status: "running" });
    const input = {
      ...identity,
      runId: run.id,
      type: "thread.progress" as const,
      payload: { streaming: true, delta: "fixture reply" },
    };
    await expect(
      system.$transaction(async (tx) => {
        await appendEventInTransaction(tx, input);
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
    await appendEvent(system, { ...input, payload: { activity: true, text: "fixture activity" } });
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
    const event = await appendEvent(system, input);
    const stamped = (await system.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt;
    expect(stamped?.toISOString()).toBe(event.createdAt);
    await system.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    await appendEvent(system, input);
    expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt).toEqual(
      stamped,
    );
    await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
  });
  it("logs durable message-tool first response only for the winning commit", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const run = await createRun({ status: "running" });
      const events = createThreadEvents(system);
      const committed = await system.$transaction((tx) =>
        appendEventInTransaction(tx, {
          ...identity,
          runId: run.id,
          type: "thread.message.created",
          payload: { role: "bot", blocks: [{ kind: "text", text: "fixture response" }] },
        }),
      );
      await events.notify(
        identity.threadId,
        committed.seq,
        committed.firstResponse ? run.id : undefined,
      );
      await events.append({
        ...identity,
        runId: run.id,
        type: "thread.progress",
        payload: { streaming: true, delta: "more fixture output" },
      });
      expect(sink.events.filter((event) => event.message === "run.first_response")).toEqual([
        expect.objectContaining({ "run.id": run.id, "run.first_response_ms": expect.any(Number) }),
      ]);
      await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });
  it("logs a final-only reply before its terminal timing record", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const run = await createRun({ status: "running" });
      await system.run.update({
        where: { id: run.id },
        data: { leaseOwner: "fixture-worker", leaseFence: 1, startedAt: new Date() },
      });
      const attempt = await system.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      await finalizeRun(system, {
        ...identity,
        runId: run.id,
        taskId: run.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "fixture final-only reply" }],
      });
      expect(
        sink.events
          .filter((event) => ["run.first_response", "run.finished"].includes(event.message))
          .map((event) => event.message),
      ).toEqual(["run.first_response", "run.finished"]);
      expect(sink.events.find((event) => event.message === "run.finished")).toEqual(
        expect.objectContaining({
          "run.total_ms": expect.any(Number),
          "run.first_response_ms": expect.any(Number),
        }),
      );
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });
  it("preserves legacy retry instants when the migration session uses a non-UTC timezone", async () => {
    const run = await createRun();
    const legacy = new GraphileJobPublisher(db.pool);
    const due = new Date(Date.now() + 60_000);
    const migration = readFileSync(
      new URL(
        "../../db/prisma/migrations/20261023180000_run_dispatch_timing/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    try {
      await legacy.enqueue({ ...runContinueJob(run.id), availableAt: due });
      await system.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'");
        await tx.$executeRawUnsafe(
          migration.slice(
            migration.indexOf("DO $$"),
            migration.indexOf("END $$;") + "END $$;".length,
          ),
        );
      });
      expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).wakeAt).toEqual(due);
    } finally {
      await legacy.cancel(`run:${run.id}`);
      await legacy.close();
      await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
    }
  });
  it("persists backoff when a previous-release worker requeues after the migration", async () => {
    const run = await createRun({ status: "running" });
    await system.run.update({ where: { id: run.id }, data: { leaseFence: 20 } });
    const [clock] = await system.$queryRaw<
      Array<{ at: Date }>
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    await system.run.update({
      where: { id: run.id },
      data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    });
    const queued = await system.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(queued.wakeAt!.getTime()).toBeGreaterThan(clock!.at.getTime());
    const explicit = new Date(Date.now() + 60_000);
    await system.run.update({ where: { id: run.id }, data: { status: "running", wakeAt: null } });
    await system.run.update({
      where: { id: run.id },
      data: { status: "queued", wakeAt: explicit },
    });
    expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).wakeAt).toEqual(
      explicit,
    );
    await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
  });
});
