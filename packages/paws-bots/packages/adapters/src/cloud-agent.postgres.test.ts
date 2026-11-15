import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  clearThread,
  createDb,
  RunHistoryWriteError,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CursorCloudAgentEmulator } from "./cloud-agent-emulator.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import {
  cloudAgentForActor,
  executeCloudAgentTool,
  reconcileCloudAgents,
} from "./cloud-agent-service.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { createJobReconciler } from "./job-reconciler.js";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";
import { T3CodeConnections } from "./t3code-connections.js";
import { T3_TOKEN, T3McpEmulator } from "./t3code-mcp-emulator.test-support.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("cloud agent lifecycle and recovery (PostgreSQL + Cursor emulator)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.cloudAgent.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    users.push(id);
    const { bot, thread, run } = await runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Cloud test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Cloud test", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Cloud test", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Cloud test", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Test",
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "user",
        },
      });
      return { bot, thread, run };
    });
    const wire = new CursorCloudAgentEmulator();
    const connection: CloudAgentConnection = {
      key: `test-connection:${id}`,
      spaceId: id,
      provider: new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch }),
    };
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      enqueueIn: async () => undefined,
      cancelIn: async () => undefined,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const deps = {
      prisma,
      jobs,
      events: { notify: vi.fn(async () => undefined) },
      cloudAgent: connection,
    };
    const context: AdapterContext & { botId: string } = {
      operationId: randomUUID(),
      traceId: "test",
      spaceId: id,
      userId: id,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const tool = (
      name: string,
      args: Record<string, unknown>,
      overrides: Partial<typeof context> = {},
    ) =>
      runAsSystem("agent run tool call", () =>
        executeCloudAgentTool(deps, { ...context, ...overrides }, run, `cloud_agent_${name}`, args),
      );
    const launch = async () => {
      const result = await tool("launch", {
        prompt: "Add README",
        repository: "https://github.com/example/demo",
        openPr: true,
      });
      if (!("id" in result)) throw new Error("Launch failed");
      return result.id;
    };
    const state = (agentId: string) =>
      prisma.cloudAgent.findUniqueOrThrow({ where: { id: agentId } });
    const poll = (agentId: string) =>
      runAsSystem("cloud agent poll job", () => pollCloudAgent(deps, { agentId }));
    // Clearing a chat is an API request by its owner.
    const clear = () =>
      runAsTenant({ spaceId: id, userId: id }, () =>
        clearThread(prisma, { spaceId: id, botId: bot.id, threadId: thread.id }),
      );
    const wakes = () =>
      asSystem(prisma).run.findMany({ where: { threadId: thread.id, trigger: "cloud_agent" } });
    const finish = async (agentId: string) => {
      wire.complete((await state(agentId)).remoteId!);
      await poll(agentId);
    };
    // Age an ambiguous follow-up past the window in which a late acceptance could appear.
    const settle = (agentId: string) =>
      prisma.cloudAgent.update({
        where: { id: agentId },
        data: { followupDispatchedAt: new Date(Date.now() - 10 * 60_000) },
      });
    const runs = async (agentId: string) => [
      ...wire.agents.get((await state(agentId)).remoteId!)!.runs.values(),
    ];
    return {
      id,
      bot,
      thread,
      run,
      wire,
      connection,
      enqueue,
      deps,
      context,
      tool,
      launch,
      state,
      poll,
      clear,
      wakes,
      finish,
      settle,
      runs,
    };
  }

  it("launches an agent whose card waited behind a long thread read", async () => {
    const { thread, launch, state } = await setup();
    // A thread snapshot read holds the row FOR SHARE past Prisma's default five seconds.
    const holdMs = 6_000;
    let locked!: (xactId: string) => void;
    const lockTaken = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reader = asSystem(prisma).$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR SHARE`;
        const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
        locked(rows[0]?.xactId ?? "");
        await opened;
      },
      { timeout: 30_000 },
    );
    const xactId = await lockTaken;
    const probe = await runAsSystem("lock probe", () => db.pool.connect());
    let launched: Promise<string> = Promise.resolve("");
    try {
      launched = launch();
      launched.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const result = await probe.query(
            "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
            [xactId],
          );
          expect(result.rows[0].waiting).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 20 },
      );
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      // On Prisma's default budget the launch has already expired here.
      const settled = await Promise.race([
        launched.then(
          () => "committed",
          (error: Error) =>
            `failed: ${error.message.split("\n").find((line) => /expired|timeout/i.test(line)) ?? error.message}`,
        ),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 75)),
      ]);
      expect(settled).toBe("waiting");
      open();
      const agentId = await launched;
      expect(await state(agentId)).toMatchObject({ threadId: thread.id });
    } finally {
      open();
      await reader.catch(() => undefined);
      await launched.catch(() => undefined);
      probe.release();
    }
  }, 30_000);

  it("records a poll's result that waited behind a long thread read", async () => {
    const { thread, launch, poll, state } = await setup();
    const id = await launch();
    let locked!: (xactId: string) => void;
    const lockTaken = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reader = asSystem(prisma).$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR SHARE`;
        const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
        locked(rows[0]?.xactId ?? "");
        await opened;
      },
      { timeout: 30_000 },
    );
    const xactId = await lockTaken;
    const probe = await runAsSystem("lock probe", () => db.pool.connect());
    let polled: Promise<void> = Promise.resolve();
    try {
      polled = poll(id);
      polled.catch(() => undefined);
      // Count from the moment the poll's own write is blocked on the reader.
      await vi.waitFor(
        async () => {
          const result = await probe.query(
            "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
            [xactId],
          );
          expect(result.rows[0].waiting).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 },
      );
      // Past Prisma's default five-second budget for the poll's own write.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      open();
      await polled;
      expect(await state(id)).toMatchObject({ errorCount: 0, remoteId: expect.any(String) });
    } finally {
      open();
      await reader.catch(() => undefined);
      await polled.catch(() => undefined);
      probe.release();
    }
  }, 30_000);

  it("forwards first-response timing when its cloud-agent card is the first output", async () => {
    const h = await setup();
    await h.launch();
    expect(h.deps.events.notify).toHaveBeenCalledWith(h.thread.id, expect.any(Number), h.run.id);
    expect(
      (await asSystem(prisma).run.findUniqueOrThrow({ where: { id: h.run.id } })).firstResponseAt,
    ).not.toBeNull();
  });

  it("persists before remote I/O, launches once, and wakes exactly once per generation", async () => {
    const h = await setup();
    const id = await h.launch();
    expect(h.wire.requests).toHaveLength(0);
    expect(await h.launch()).toBe(id);
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(1);
    await h.poll(id);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({
      status: "finished",
      wakeGeneration: 0,
      nextPollAt: null,
    });
    expect(await h.wakes()).toHaveLength(1);
    await prisma.cloudAgent.update({ where: { id }, data: { nextPollAt: new Date() } });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(1);
  });

  it("recovers an accepted launch whose response was lost without creating a second remote agent", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.loseNextLaunchResponse = true;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      remoteId: null,
      launchDispatched: true,
      status: "running",
    });
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: h.wire.fetch,
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.agents.size).toBe(1);
    expect(h.wire.requests.filter((request) => request.path === "/v1/agents")).toHaveLength(2);
  });

  it("reconciles durable launch and wake intents after queue failure", async () => {
    const h = await setup();
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    const id = await h.launch();
    expect((await h.state(id)).nextPollAt).not.toBeNull();
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await runAsSystem("job reconciler", () => reconcileCloudAgents(h.deps));
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cloud_agent.poll", payload: { agentId: id } }),
    );
    await h.poll(id);
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    await h.finish(id);
    const [wake] = await h.wakes();
    expect(wake?.status).toBe("queued");
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await runAsSystem("job reconciler", () =>
      createJobReconciler({ prisma, jobs: h.deps.jobs }).reconcileOnce(),
    );
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: wake!.id } }),
    );
  });

  it("does not launch from an attempt a newer claim superseded", async () => {
    const h = await setup();
    await asSystem(prisma).run.update({
      where: { id: h.run.id },
      data: { status: "running", leaseOwner: "worker-2", leaseFence: 2 },
    });
    await expect(
      runAsSystem("agent run tool call", () =>
        executeCloudAgentTool(
          { ...h.deps, runLease: { runId: h.run.id, owner: "worker-1", fence: 1 } },
          h.context,
          h.run,
          "cloud_agent_launch",
          { prompt: "Add README" },
        ),
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(0);
    expect(h.wire.requests).toHaveLength(0);
  });

  it("never dispatches a launch whose card transaction fails", async () => {
    const h = await setup();
    // A chat that is gone by the time the card is written fails the card transaction.
    h.run.threadId = "missing-thread";
    await expect(h.tool("launch", { prompt: "Task" })).rejects.toThrow();
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(0);
    expect(h.wire.requests).toHaveLength(0);
  });

  it("cancels locally when chat clears before dispatch, and remotely after dispatch", async () => {
    const before = await setup();
    const beforeId = await before.launch();
    await before.clear();
    await before.poll(beforeId);
    expect((await before.state(beforeId)).status).toBe("cancelled");
    expect(before.wire.requests).toHaveLength(0);
    const after = await setup();
    const afterId = await after.launch();
    await after.poll(afterId);
    await after.clear();
    await after.poll(afterId);
    expect(await after.state(afterId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(
      await runAsSystem("test fixture", () =>
        prisma.message.count({ where: { threadId: after.thread.id } }),
      ),
    ).toBe(0);
    expect(await after.wakes()).toHaveLength(0);
    expect(await after.tool("status", { id: afterId })).toMatchObject({
      id: afterId,
      status: "cancelled",
    });
  });

  it("retains ownership and cancels when the original bot is deleted", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await asSystem(prisma).bot.delete({ where: { id: h.bot.id } });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
  });

  it("does not wake an owner whose membership is revoked during the provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.complete((await h.state(id)).remoteId!);
    const original = h.connection.provider.get.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "get").mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      await prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: h.id, userId: h.id } },
      });
      return snapshot;
    });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(0);
    expect((await h.state(id)).nextPollAt).toBeNull();
  });

  it("isolates users, spaces, and credential bindings before any provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    const requests = h.wire.requests.length;
    expect(await h.tool("cancel", { id }, { userId: "other-user" })).toMatchObject({
      error: "Unknown cloud agent.",
    });
    expect(
      await h.tool("reply", { id, prompt: "Attack" }, { spaceId: "other-space" }),
    ).toHaveProperty("error");
    h.connection.key = "rotated-key";
    expect(await h.tool("status", { id })).toMatchObject({ error: "Unknown cloud agent." });
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
  });

  it("pins a follow-up to its returned run even when agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    expect(newRun).not.toBe(oldRun);
    await h.poll(id);
    expect((await h.state(id)).status).toBe("running");
    expect(await h.wakes()).toHaveLength(1);
    h.wire.complete((await h.state(id)).remoteId!);
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(2);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRun,
      generation: 1,
      wakeGeneration: 1,
    });
  });

  it("cancels the known follow-up run even when latest agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    h.wire.staleLatestRunId = oldRun;
    await h.tool("cancel", { id });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      latestRunId: newRun,
      cancelRequested: false,
    });
  });

  it("reconciles a lost follow-up response without resending or waking on the previous run", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect((await h.state(id)).latestRunId).not.toBe(oldRun);
    expect(await h.wakes()).toHaveLength(1);
    expect(
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ),
    ).toHaveLength(1);
  });

  it("resends a follow-up whose pre-send read failed, since nothing was sent", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followupDispatchedAt: null });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect(await h.runs(id)).toHaveLength(2);
    await h.finish(id);
    expect((await h.state(id)).status).toBe("finished");
  });

  it.each([
    ["never accepted", false],
    ["accepted after the client gave up", true],
  ])("sends an ambiguous follow-up exactly once when it was %s", async (_label, late) => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    const remoteId = (await h.state(id)).remoteId!;
    let failed = false;
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (failed || init?.method !== "POST") return h.wire.fetch(input, init);
        failed = true;
        return new Response(null, { status: 503 });
      },
    });
    await h.poll(id);
    await h.poll(id);
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    expect(await h.runs(id)).toHaveLength(1);
    if (late) {
      await h.wire.fetch(`https://api.cursor.com/v1/agents/${remoteId}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer fake-key" },
        body: JSON.stringify({ prompt: { text: "Add tests" } }),
      });
    } else {
      await h.settle(id);
      await h.poll(id);
      expect((await h.state(id)).followupDispatchedAt).toBeNull();
    }
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect(await h.runs(id)).toHaveLength(2);
    await h.finish(id);
    expect((await h.state(id)).status).toBe("finished");
  });

  it("does not report cancellation success while transport fails or the provider is still running", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.tool("cancel", { id });
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = true;
    await h.poll(id);
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = false;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it.each([
    ["accepted", true],
    ["never accepted", false],
  ])("cancels an ambiguous follow-up that was %s", async (_label, accepted) => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    if (accepted) h.wire.loseNextReplyResponse = true;
    else
      h.connection.provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async (input, init) =>
          init?.method === "POST" ? new Response(null, { status: 503 }) : h.wire.fetch(input, init),
      });
    await h.poll(id);
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    await h.tool("cancel", { id });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    if (!accepted) {
      // A late acceptance could still appear, so cancellation waits for the run list to settle.
      expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
      await h.settle(id);
      await h.poll(id);
    }
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      followup: null,
      followupDispatchedAt: null,
      nextPollAt: null,
    });
    expect((await h.runs(id)).map((run) => run.status)).toEqual(
      accepted ? ["FINISHED", "CANCELLED"] : ["FINISHED"],
    );
  });

  it("cancels a queued follow-up without dispatching it", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Tests" });
    await h.tool("cancel", { id });
    const requests = h.wire.requests.length;
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", followup: null });
  });

  it("recovers remote identity after the database fails following an accepted create", async () => {
    const h = await setup();
    const id = await h.launch();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Database unavailable"));
      return result;
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeNull();
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.agents.size).toBe(1);
  });

  it("fences concurrent pollers and preserves cancellation during launch", async () => {
    const h = await setup();
    const id = await h.launch();
    const entered = deferred();
    const release = deferred();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const polling = h.poll(id);
    await entered.promise;
    await h.poll(id);
    await h.tool("cancel", { id });
    release.resolve();
    await polling;
    await h.poll(id);
    await h.poll(id);
    expect(h.wire.agents.size).toBe(1);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("rejects overlapping follow-ups and preserves remote failure as a terminal result", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    expect(await h.tool("reply", { id, prompt: "Busy" })).toHaveProperty("error");
    h.wire.complete((await h.state(id)).remoteId!, { failed: true });
    await h.poll(id);
    expect((await h.state(id)).status).toBe("failed");
    expect(await h.wakes()).toHaveLength(1);
    await h.tool("reply", { id, prompt: "Try again" });
    expect(await h.tool("reply", { id, prompt: "Duplicate" })).toHaveProperty("error");
  });

  it("marks definitive create rejection failed while retaining retryable network failures", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 1 });
    h.wire.failNextRequest = 400;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(1);
    expect(h.wire.agents.size).toBe(0);
  });

  it("stops polling a remote agent or run that no longer exists", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.agents.delete((await h.state(id)).remoteId!);
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(1);
    const cancelled = await setup();
    const cancelledId = await cancelled.launch();
    await cancelled.poll(cancelledId);
    await cancelled.tool("cancel", { id: cancelledId });
    cancelled.wire.agents.delete((await cancelled.state(cancelledId)).remoteId!);
    await cancelled.poll(cancelledId);
    expect(await cancelled.state(cancelledId)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      nextPollAt: null,
    });
  });

  it("keeps polling through unknown statuses, a rejected key, and rate limits", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", remoteId: null, errorCount: 1 });
    h.wire.apiKey = "fake-key";
    await h.poll(id);
    const remoteId = (await h.state(id)).remoteId!;
    expect(remoteId).toBeTruthy();
    h.wire.setRunStatus(remoteId, "SOME_FUTURE_STATUS");
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 0 });
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 1 });
    h.wire.apiKey = "fake-key";
    h.wire.failNextRequest = 429;
    await h.poll(id);
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 29_000);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({ status: "finished", errorCount: 0 });
  });

  it("leaves a rate-limited agent's scheduled poll alone when its status is read", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.failNextRequest = 429;
    await h.poll(id);
    const before = await h.state(id);
    expect(before.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 29_000);
    h.enqueue.mockClear();
    expect(await h.tool("status", { id })).toMatchObject({ id, status: "running" });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect((await h.state(id)).nextPollAt).toEqual(before.nextPollAt);
  });

  it("keeps a cancel's immediate poll when the status is read afterwards", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.failNextRequest = 429;
    await h.poll(id);
    h.enqueue.mockClear();
    await h.tool("cancel", { id });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]![0].availableAt).toBeUndefined();
    await h.tool("status", { id });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reports a follow-up to an expired agent as expired", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    h.wire.archive((await h.state(id)).remoteId!);
    await h.tool("reply", { id, prompt: "Add tests" });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "expired",
      followup: null,
      followupDispatchedAt: null,
      nextPollAt: null,
    });
    expect(await h.wakes()).toHaveLength(2);
  });

  it("resends a follow-up the provider refused for its key or rate limit", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followupDispatchedAt: null });
    h.wire.apiKey = "fake-key";
    const replies = () =>
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ).length;
    h.wire.requests.length = 0;
    // The pre-read succeeds; the follow-up POST itself is rate limited.
    let limited = false;
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (!limited && init?.method === "POST") {
          limited = true;
          h.wire.failNextRequest = 429;
        }
        return h.wire.fetch(input, init);
      },
    });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ followupDispatchedAt: null });
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 29_000);
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ followup: null, status: "running" });
    expect(replies()).toBe(2);
  });

  describe("on a T3 Code environment the user connected", () => {
    const secrets = new EncryptedSecretStore("test-only-encryption-key");

    /** An MCP server connected over OAuth, as Rakazo stores it after T3 Code's approval. */
    async function connectServer(
      owner: { spaceId: string; userId: string },
      overrides: {
        scope?: string;
        token?: string | null;
        enabled?: boolean;
        secret?: boolean;
        allBots?: boolean;
      } = {},
    ) {
      const slug = `t3-${randomUUID()}`;
      const endpoint = `https://${slug}.example.test/mcp`;
      const material: OAuthMaterial = {
        oauth: {
          ...(overrides.token === null
            ? {}
            : {
                tokens: {
                  access_token: overrides.token ?? T3_TOKEN,
                  token_type: "Bearer",
                  expires_in: 30 * 24 * 3600,
                  scope: overrides.scope ?? "orchestration:read orchestration:operate",
                },
                obtainedAt: Date.now(),
              }),
          clientInformation: { client_id: "client-1" },
          discoveryState: {
            authorizationServerUrl: new URL(endpoint).origin,
            resourceMetadata: { resource: endpoint, resource_name: "T3 Code" },
          },
        },
      };
      return runAsSystem("test fixture", async () => {
        const stored = await secrets.put(JSON.stringify(material), {
          operationId: "test",
          traceId: "test",
          ...owner,
          signal: new AbortController().signal,
        });
        await prisma.secret.create({
          data: { id: stored.id, ...owner, kind: "mcp", ciphertext: stored.ciphertext },
        });
        return prisma.mcpServer.create({
          data: {
            ...owner,
            slug,
            name: slug,
            transport: "streamable_http",
            endpoint,
            enabled: overrides.enabled ?? true,
            allBots: overrides.allBots ?? false,
            secretId: overrides.secret === false ? null : stored.id,
          },
        });
      });
    }

    async function connected() {
      const h = await setup();
      const actor = { spaceId: h.id, userId: h.id };
      const t3 = new T3McpEmulator();
      const broker = new McpOAuthBroker(withSecretPersistence(prisma, secrets), secrets);
      const deps = {
        ...h.deps,
        userCloudAgents: new T3CodeConnections(prisma, broker, {
          fetch: t3.fetch,
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
        }),
      };
      const forActor = () => runAsSystem("agent run", () => cloudAgentForActor(deps, actor));
      // What a run does: its tools act on the connection resolved for its user.
      const tool = async (name: string, args: Record<string, unknown>) =>
        runAsSystem("agent run tool call", async () =>
          executeCloudAgentTool(
            {
              ...deps,
              cloudAgent: await cloudAgentForActor(deps, { ...actor, botIds: [h.bot.id] }),
              deployment: h.connection,
            },
            { ...h.context, operationId: randomUUID() },
            h.run,
            `cloud_agent_${name}`,
            args,
          ),
        );
      const launch = async (args: Record<string, unknown> = {}) => {
        const result = await tool("launch", { prompt: "Add README", ...args });
        if (!("id" in result)) throw new Error("Launch failed");
        return result.id;
      };
      const poll = (agentId: string) =>
        runAsSystem("cloud agent poll job", () => pollCloudAgent(deps, { agentId }));
      return { h, actor, t3, deps, forActor, tool, launch, poll };
    }

    it("returns a retried launch's agent after new agents moved to the deployment's provider", async () => {
      const { h, actor, deps, forActor } = await connected();
      const server = await connectServer(actor);
      const operationId = randomUUID();
      const launch = (cloudAgent: CloudAgentConnection) =>
        runAsSystem("agent run tool call", () =>
          executeCloudAgentTool(
            { ...deps, cloudAgent, deployment: h.connection },
            { ...h.context, operationId },
            h.run,
            "cloud_agent_launch",
            { prompt: "Add README" },
          ),
        );
      const first = await launch((await forActor())!);
      expect(
        await prisma.cloudAgent.findFirst({ where: { operationKey: operationId } }),
      ).toMatchObject({
        providerKey: `mcp:${server.id}`,
      });
      // The run retries the call after the T3 Code grant lapsed: new agents use the deployment's.
      expect(await launch(h.connection)).toMatchObject({ id: (first as { id: string }).id });
    });

    it("offers only the actor's connected T3 Code server in this Space, else the deployment's", async () => {
      const { h, actor, forActor } = await connected();
      const other = await setup();
      const otherSpace = await runAsSystem("test fixture", () =>
        prisma.space.create({
          data: { id: randomUUID(), organizationId: h.id, name: "Other", isDefault: false },
        }),
      );
      await connectServer(actor, { scope: "read write" });
      await connectServer(actor, { enabled: false });
      await connectServer(actor, { secret: false });
      await connectServer(actor, { token: null });
      await connectServer({ spaceId: h.id, userId: other.id });
      await connectServer({ spaceId: otherSpace.id, userId: h.id });
      // Cursor's deployment connection is unchanged while the user has no T3 Code connection.
      expect((await forActor())!.key).toBe(h.connection.key);
      const server = await connectServer(actor);
      expect(await forActor()).toMatchObject({
        key: `mcp:${server.id}`,
        baseUrl: server.endpoint,
        spaceId: h.id,
      });
    });

    it("offers a server only to the agents it is assigned to", async () => {
      const { h, actor, deps } = await connected();
      const forBot = (botId: string) =>
        runAsSystem("agent run", () => cloudAgentForActor(deps, { ...actor, botIds: [botId] }));
      const other = await runAsSystem("test fixture", () =>
        prisma.bot.create({
          data: { spaceId: h.id, userId: h.id, name: "Other", color: "test-color" },
        }),
      );
      const server = await connectServer(actor);
      await runAsSystem("test fixture", () =>
        prisma.botMcpServer.create({
          data: { spaceId: h.id, userId: h.id, botId: other.id, serverId: server.id },
        }),
      );
      expect((await forBot(h.bot.id))!.key).toBe(h.connection.key);
      expect((await forBot(other.id))!.key).toBe(`mcp:${server.id}`);
      const shared = await connectServer(actor, { allBots: true });
      expect((await forBot(h.bot.id))!.key).toBe(`mcp:${shared.id}`);
    });

    it("keeps the deployment's agents reachable once the user connects T3 Code", async () => {
      const { h, actor, tool, forActor } = await connected();
      const cursor = await h.tool("launch", { prompt: "Fix tests" });
      if (!("id" in cursor)) throw new Error("Launch failed");
      await connectServer(actor);
      expect((await forActor())!.key).not.toBe(h.connection.key);
      expect(await tool("status", { id: cursor.id })).toMatchObject({ id: cursor.id });
      await h.poll(cursor.id);
      await tool("cancel", { id: cursor.id });
      await h.poll(cursor.id);
      expect(await h.state(cursor.id)).toMatchObject({
        providerKey: h.connection.key,
        status: "cancelled",
      });
    });

    it("launches, follows, reconciles and cancels an agent through the connection", async () => {
      const { h, actor, t3, deps, tool, launch, poll } = await connected();
      const server = await connectServer(actor, { allBots: true });
      const id = await launch();
      expect(await h.state(id)).toMatchObject({ providerKey: `mcp:${server.id}` });
      h.enqueue.mockClear();
      await runAsSystem("job reconciler", () => reconcileCloudAgents(deps));
      expect(h.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "cloud_agent.poll", payload: { agentId: id } }),
      );
      h.enqueue.mockClear();
      await runAsSystem("job reconciler", () => reconcileCloudAgents(h.deps));
      expect(h.enqueue).not.toHaveBeenCalled();
      await poll(id);
      const { remoteId } = await h.state(id);
      expect(t3.threads.has(remoteId!)).toBe(true);
      // The deployment's tools still reach the user's agents on their own environment.
      expect(await h.tool("status", { id })).toMatchObject({ id, status: "running" });
      await tool("cancel", { id });
      await poll(id);
      // T3 Code ends the run once its agent stops, so the next poll observes it.
      expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
      await poll(id);
      expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
      expect(t3.calls.map((call) => call.tool)).toContain("t3_thread_interrupt");
    });

    it("ends a follow-up T3 Code holds instead of polling it forever", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { h, actor, t3, tool, launch, poll } = await connected();
        await connectServer(actor, { allBots: true });
        const id = await launch({ repository: "https://github.com/example/demo" });
        await poll(id);
        // Stopped while T3 Code set up its worktree, the thread holds what is sent next.
        await tool("cancel", { id });
        await poll(id);
        await poll(id);
        expect(await h.state(id)).toMatchObject({ status: "cancelled" });
        await tool("reply", { id, prompt: "Try again" });
        await poll(id);
        await poll(id);
        expect(await h.state(id)).toMatchObject({ status: "running" });
        vi.setSystemTime(Date.now() + 61_000);
        await poll(id);
        expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
        expect(t3.calls.at(-1)).toMatchObject({ tool: "t3_queue", args: { action: "cancel" } });
        expect(await h.wakes()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles a cancel of an agent whose launch T3 Code refused", async () => {
      const { h, actor, tool, launch, poll } = await connected();
      await connectServer(actor, { allBots: true });
      // T3 Code has no project for this repository, so nothing remote is ever created.
      const id = await launch({ repository: "https://github.com/example/missing" });
      await poll(id);
      expect(await h.state(id)).toMatchObject({
        status: "failed",
        remoteId: null,
        nextPollAt: null,
      });
      expect(await tool("cancel", { id })).toMatchObject({ cancellationPending: true });
      await poll(id);
      expect(await h.state(id)).toMatchObject({
        status: "failed",
        cancelRequested: false,
        nextPollAt: null,
        errorCount: 0,
      });
      expect(await h.wakes()).toHaveLength(1);
    });

    it("keeps status and cancellation usable after revocation without a deployment provider", async () => {
      const { h, actor, deps, launch, poll } = await connected();
      const server = await connectServer(actor, { allBots: true });
      const id = await launch();
      await poll(id);
      await runAsSystem("test fixture", () =>
        prisma.mcpServer.update({
          where: { id: server.id },
          data: { allBots: false },
        }),
      );
      const cleanupDeps = { ...deps, cloudAgent: null };
      expect(
        await runAsSystem("agent run", () =>
          cloudAgentForActor(cleanupDeps, { ...actor, botIds: [h.bot.id] }),
        ),
      ).toBeNull();
      const cleanupTool = (name: string, args: Record<string, unknown>) =>
        runAsSystem("agent run", () =>
          executeCloudAgentTool(cleanupDeps, h.context, h.run, `cloud_agent_${name}`, args),
        );
      expect(await cleanupTool("status", { id })).toMatchObject({ id, status: "running" });
      for (const name of ["launch", "reply"]) {
        expect(await cleanupTool(name, { id, prompt: "Task" })).toEqual({
          error: "Cloud agents are not configured for this space.",
        });
      }
      expect(await cleanupTool("cancel", { id })).toMatchObject({ id, cancellationPending: true });
      await poll(id);
      await poll(id);
      expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
    });

    it.each([
      ["launch", "remove"],
      ["launch", "restrict"],
      ["reply", "remove"],
      ["reply", "restrict"],
    ])("rejects a queued %s after permissions change by %s", async (operation, revoke) => {
      const { h, actor, t3, tool, launch, poll } = await connected();
      const server = await connectServer(actor);
      const assignment = await runAsSystem("test fixture", () =>
        prisma.botMcpServer.create({
          data: { ...actor, botId: h.bot.id, serverId: server.id, allowAllTools: true },
        }),
      );
      const id = await launch();
      if (operation === "reply") {
        await poll(id);
        t3.complete((await h.state(id)).remoteId!);
        await poll(id);
        expect(await tool("reply", { id, prompt: "Continue" })).toMatchObject({ id });
      }
      await runAsSystem("test fixture", async () => {
        if (revoke === "remove") await prisma.botMcpServer.delete({ where: { id: assignment.id } });
        else
          await prisma.botMcpServer.update({
            where: { id: assignment.id },
            data: { allowAllTools: false, allowedTools: ["t3_thread_read"] },
          });
      });
      const calls = t3.calls.length;
      await poll(id);
      expect(await h.state(id)).toMatchObject({ status: "expired", nextPollAt: null });
      expect(t3.calls).toHaveLength(calls);
      expect(await tool("reply", { id, prompt: "Restart" })).toEqual({
        error: "Unknown cloud agent.",
      });
      expect(await tool("status", { id })).toMatchObject({ id, status: "expired" });
    });

    it("ends the card as expired once T3 Code refuses the token or the server is removed", async () => {
      const { h, actor, t3, launch, poll, forActor } = await connected();
      await connectServer(actor, { allBots: true });
      const id = await launch();
      await poll(id);
      t3.token = "revoked";
      await poll(id);
      expect(await h.state(id)).toMatchObject({ status: "expired", nextPollAt: null });
      expect(await h.wakes()).toHaveLength(1);
      // The token is dropped, so MCP servers list it as needing a reconnect.
      expect((await forActor())!.key).toBe(h.connection.key);
      t3.token = T3_TOKEN;
      const removed = await connectServer(actor, { allBots: true });
      const next = await launch();
      expect(await h.state(next)).toMatchObject({ providerKey: `mcp:${removed.id}` });
      await runAsSystem("test fixture", () =>
        prisma.mcpServer.delete({ where: { id: removed.id } }),
      );
      const calls = t3.calls.length;
      await poll(next);
      expect(await h.state(next)).toMatchObject({ status: "expired", nextPollAt: null });
      expect(t3.calls).toHaveLength(calls);
      expect(await h.wakes()).toHaveLength(2);
    });
  });
});
