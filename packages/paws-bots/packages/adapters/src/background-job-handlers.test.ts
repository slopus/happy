import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJob,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { memoryRetainTurnJob, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import type * as ComputerControl from "./computer-control.js";
import { expireComputerControl } from "./computer-control.js";
import {
  abandonRetainedConversation,
  retainRunConversation,
  settleRetainedConversation,
} from "./conversation-memory.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./conversation-memory.js", () => ({
  abandonRetainedConversation: vi.fn(async () => undefined),
  retainRunConversation: vi.fn(async () => ({})),
  settleRetainedConversation: vi.fn(async () => ({ settled: true })),
}));
vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./computer-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerControl>()),
  expireComputerControl: vi.fn(async () => false),
}));

const owner = { spaceId: "space-1", userId: "user-1" };
const owned = () => ({ findUnique: vi.fn(async () => owner) });

it("runs post-clear memory purge as its captured tenant after source rows are deleted", async () => {
  const purgeHistory = vi.fn(async () => {
    expect(currentDbContext()).toEqual({ kind: "tenant", ...owner });
    return { ok: true };
  });
  const handlers = createBackgroundJobHandlers({
    memoryProviders: {
      resolve: vi.fn(async () => ({
        provider: { connectionIdentity: "connection-1", purgeHistory },
      })),
    },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  await handlers["memory.purge-history"]({
    ...owner,
    botId: "bot-1",
    threadId: "deleted-thread",
    generations: [2, 3],
    connectionIdentity: "connection-1",
  });
  expect(purgeHistory).toHaveBeenCalledOnce();
});

describe("createBackgroundJobHandlers", () => {
  function chatHandlers() {
    const order: string[] = [];
    const continueRun = vi.fn(async () => {
      order.push("continue");
    });
    const delivery = {
      deliverRun: vi.fn(async (runId: string, _options?: { progress?: boolean }) => {
        order.push(`deliver:${runId}`);
      }),
      sendJob: vi.fn(async () => undefined),
      drainAll: vi.fn(async () => {
        order.push("drain");
      }),
      reportFailure: vi.fn(),
    };
    const teamChat = {
      engageJob: vi.fn(async () => undefined),
      ambientJob: vi.fn(async () => undefined),
    };
    const handlers = createBackgroundJobHandlers({
      executor: { continueRun },
      prisma: { run: owned() },
      workerId: "worker-1",
      messagingDelivery: delivery,
      teamChat,
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    return { handlers, delivery, teamChat, order };
  }

  it("sends what a run said once its turn ends, without failing the run when sending fails", async () => {
    const { handlers, delivery, order } = chatHandlers();
    await handlers["run.continue"]({ runId: "run-1" });
    expect(order).toEqual(["continue", "deliver:run-1"]);

    const failure = new Error("chat app unavailable");
    delivery.deliverRun.mockRejectedValueOnce(failure);
    await expect(handlers["run.continue"]({ runId: "run-2" })).resolves.toBeUndefined();
    expect(delivery.reportFailure).toHaveBeenCalledExactlyOnceWith(
      "messaging reply delivery error",
      failure,
    );
  });

  it("sends a recorded chat message from its backup job with the job's attempt", async () => {
    const { handlers, delivery } = chatHandlers();
    await handlers["messaging.send"]({ outboundId: "outbound-1" }, undefined, {
      number: 2,
      max: 5,
    });
    expect(delivery.sendJob).toHaveBeenCalledExactlyOnceWith("outbound-1", { number: 2, max: 5 });
  });

  it("sends an ended run's reply from its backup job", async () => {
    const { handlers, delivery } = chatHandlers();
    await handlers["messaging.reply"]({ runId: "run-1" });
    expect(delivery.deliverRun).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("drains the previous release's delivery jobs through the new path", async () => {
    const { handlers, delivery, order } = chatHandlers();
    await handlers["messaging.deliver"]({ runId: "run-1" });
    await handlers["messaging.deliver"]({});
    expect(order).toEqual(["deliver:run-1", "drain", "drain"]);

    await handlers["messaging.progress"]({ runId: "run-2" });
    expect(delivery.deliverRun).toHaveBeenLastCalledWith("run-2", { progress: true });
  });

  it("hands team-chat engagement and ambient decisions to team chat", async () => {
    const { handlers, teamChat } = chatHandlers();
    await handlers["team_chat.engage"]({ externalMessageId: "external-1" });
    await handlers["team_chat.ambient"]({ conversationId: "conversation-1" });
    expect(teamChat.engageJob).toHaveBeenCalledExactlyOnceWith("external-1");
    expect(teamChat.ambientJob).toHaveBeenCalledExactlyOnceWith("conversation-1");
  });

  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = { thread: owned() } as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel, contextStrategy: "current" } as unknown as ReturnType<
        typeof createRunExecutor
      >,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      artifacts: {} as unknown as ArtifactStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memoryProviders,
      deploymentModelKey: "openrouter-key",
      deploymentModelConfigured: true,
    });

    await handlers["history.compact"]({ threadId: "thread-1", userId: "user-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        runtime,
        jobs,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        deploymentModelConfigured: true,
        resolveModel,
      },
      "thread-1",
      "user-1",
    );
  });

  it.each([undefined, "retrieval", "snapshots", "cache-aware"] as const)(
    "does not spend on a queued legacy compaction after switching to %s",
    async (contextStrategy) => {
      vi.mocked(compactHistory).mockClear();
      const runtime = { run: vi.fn() } as unknown as AgentRuntime;
      const handlers = createBackgroundJobHandlers({
        executor:
          contextStrategy === undefined
            ? createRunExecutor({ prisma: {} as PrismaClient } as Parameters<
                typeof createRunExecutor
              >[0])
            : ({ contextStrategy } as ReturnType<typeof createRunExecutor>),
        prisma: { thread: owned() } as unknown as PrismaClient,
        sandbox: {} as unknown as SandboxProvider,
        home: {} as unknown as AgentHomeStore,
        artifacts: {} as unknown as ArtifactStore,
        jobs: {} as unknown as JobPublisher,
        events: {} as unknown as ThreadEvents,
        workerId: "worker-fixture",
        runtime,
        secretStore: {} as unknown as EncryptedSecretStore,
        memoryProviders: { resolve: vi.fn(async () => null) },
      });

      await handlers["history.compact"]({ threadId: "thread-fixture" });

      expect(compactHistory).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();
    },
  );

  it("runs a job as the tenant of the row it acts for, and skips one whose row is gone", async () => {
    const seen: unknown[] = [];
    const continueRun = vi.fn(async () => {
      seen.push(currentDbContext());
    });
    const lookups = { findUnique: vi.fn(async () => owner) };
    const handlers = createBackgroundJobHandlers({
      executor: { continueRun } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: { run: lookups } as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      artifacts: {} as unknown as ArtifactStore,
      jobs: {} as unknown as JobPublisher,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });

    await handlers["run.continue"]({ runId: "run-1" });
    expect(seen).toEqual([{ kind: "tenant", ...owner }]);
    expect(lookups.findUnique).toHaveBeenCalledWith({
      where: { id: "run-1" },
      select: { spaceId: true, userId: true },
    });

    const onRunStarted = vi.fn();
    await handlers["run.continue"]({ runId: "run-1" }, { onRunStarted });
    expect(continueRun).toHaveBeenLastCalledWith("run-1", "worker-1", onRunStarted);

    lookups.findUnique.mockResolvedValueOnce(null as never);
    await handlers["run.continue"]({ runId: "run-gone" });
    expect(continueRun).toHaveBeenCalledTimes(2);
  });

  it("tries a control release again later when the computer provider is unreachable", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    vi.mocked(expireComputerControl).mockRejectedValueOnce(
      new SandboxUnresponsiveError("Boat could not be reached"),
    );
    const enqueue = vi.fn(async () => undefined);
    const handlers = createBackgroundJobHandlers({
      executor: {} as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {
        computer: owned(),
        taughtSkill: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      artifacts: {} as unknown as ArtifactStore,
      jobs: { enqueue } as unknown as JobPublisher,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });

    await handlers["computer.control-expire"]({ computerId: "computer-1", leaseId: "lease-1" });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "computer.control-expire",
        payload: { computerId: "computer-1", leaseId: "lease-1" },
      }),
    );
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "computer.control_expire_deferred"],
    ]);
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      userModelPreference: { findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
      deploymentModelConfigured: true,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "anthropic/claude-haiku-5.5",
      apiKey: "deployment-key",
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      userModelPreference: { findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });
});

it("retries retired messaging credentials without deleting a currently referenced credential", async () => {
  const remove = vi.fn(async () => undefined);
  const findUnique = vi.fn(async () => ({ ciphertext: "active-ref" }));
  const handlers = createBackgroundJobHandlers({
    prisma: { messagingInstallation: { findUnique } },
    secretStore: { delete: remove },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  await handlers["messaging.credential-cleanup"]({
    installationId: "install-a",
    ref: "active-ref",
  });
  expect(remove).not.toHaveBeenCalled();
  await handlers["messaging.credential-cleanup"]({
    installationId: "install-a",
    ref: "retired-ref",
  });
  expect(remove).toHaveBeenCalledWith(
    "retired-ref",
    expect.objectContaining({ recordId: "install-a" }),
  );
  remove.mockRejectedValueOnce(new Error("secret store temporarily unavailable") as never);
  await expect(
    handlers["messaging.credential-cleanup"]({ installationId: "install-a", ref: "retired-ref" }),
  ).rejects.toThrow("temporarily unavailable");
});

describe("memory.retain-turn", () => {
  const identity = {
    connectionIdentity: "connection-1",
    source: { ...owner, botId: "bot-1", threadId: "thread-1" },
  };
  const retainTurn = (runExists = true) => {
    const jobs = {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      cancel: vi.fn(async (_key: string) => undefined),
    };
    const run = { findUnique: vi.fn(async () => (runExists ? owner : null)) };
    const handlers = createBackgroundJobHandlers({
      executor: {} as unknown as ReturnType<typeof createRunExecutor>,
      prisma: { run } as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      artifacts: {} as unknown as ArtifactStore,
      jobs: jobs as unknown as JobPublisher,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });
    return { jobs, run, handle: handlers["memory.retain-turn"] };
  };

  it("uses the captured source tenant when group deletion removed the run", async () => {
    const { handle, run } = retainTurn(false);
    const seen: unknown[] = [];
    vi.mocked(settleRetainedConversation).mockImplementationOnce(async () => {
      seen.push(currentDbContext());
      return { settled: true };
    });
    await handle({
      runId: "run-1",
      pending: {
        ...identity,
        token: "op-1",
        generation: 3,
        checks: 1,
        source: { ...owner, botId: "bot-1", threadId: "thread-1" },
      },
    });
    expect(run.findUnique).not.toHaveBeenCalled();
    expect(seen).toEqual([{ kind: "tenant", ...owner }]);
  });

  it("checks again later when the provider is still storing a new turn", async () => {
    vi.mocked(retainRunConversation).mockResolvedValueOnce({
      pending: { ...identity, token: "op-1", generation: 3 },
    });
    const { jobs, handle } = retainTurn();
    const before = Date.now();
    await handle({ runId: "run-1", messageIds: ["m-1"] });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "memory.retain-turn",
        payload: {
          runId: "run-1",
          messageIds: ["m-1"],
          pending: { ...identity, token: "op-1", generation: 3, checks: 0 },
        },
        replaceKey: "memory.retain-turn:run-1:settle",
      }),
    );
    const [job] = jobs.enqueue.mock.calls[0] as unknown as [{ availableAt: Date }];
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before + 5_000);
  });

  it("polls a pending turn without resubmitting it", async () => {
    vi.mocked(retainRunConversation).mockClear();
    vi.mocked(settleRetainedConversation).mockResolvedValueOnce({ settled: false });
    const { jobs, handle } = retainTurn();
    const pending = { ...identity, token: "op-1", generation: 3, checks: 2 };
    await handle({ runId: "run-1", pending });
    expect(retainRunConversation).not.toHaveBeenCalled();
    expect(settleRetainedConversation).toHaveBeenCalledWith(expect.anything(), "run-1", pending);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "run-1", pending: { ...pending, checks: 3 } } }),
    );
  });

  it("keeps the confirmed token when a canceled slow recovery requeues itself", async () => {
    const { jobs, handle } = retainTurn();
    const durable = new Map<string, BackgroundJob>();
    jobs.enqueue.mockImplementation(async (job) => {
      durable.set(job.replaceKey!, job);
    });
    jobs.cancel.mockImplementation(async (key) => {
      durable.delete(key);
    });
    const pending = { ...identity, generation: 3, checks: 0, unconfirmed: true as const };
    const recovery = memoryRetainTurnJob("run-1", [], { pending });
    durable.set(recovery.replaceKey!, recovery);
    let entered!: () => void;
    let finish!: (result: { settled: boolean }) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = new Promise<{ settled: boolean }>((resolve) => {
      finish = resolve;
    });
    vi.mocked(settleRetainedConversation).mockImplementationOnce(async () => {
      entered();
      return slow;
    });
    const running = handle({ runId: "run-1", pending });
    await started;
    vi.mocked(retainRunConversation).mockResolvedValueOnce({
      pending: { ...identity, generation: 3, token: "op-1" },
    });
    await handle({ runId: "run-1" });
    expect(jobs.cancel).toHaveBeenCalledWith(recovery.replaceKey);
    expect(durable.has(recovery.replaceKey!)).toBe(false);
    finish({ settled: false });
    await running;
    expect(durable.get("memory.retain-turn:run-1:settle")).toMatchObject({
      payload: { pending: { token: "op-1" } },
    });
    expect(durable.get(recovery.replaceKey!)).toMatchObject({
      payload: { pending: { unconfirmed: true, checks: 1 } },
    });
  });

  it("preserves recovery when the confirmed handoff cannot be queued", async () => {
    const { jobs, handle } = retainTurn();
    vi.mocked(retainRunConversation).mockResolvedValueOnce({
      pending: { ...identity, generation: 3, token: "op-1" },
    });
    jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(handle({ runId: "run-1" })).rejects.toThrow("queue unavailable");
    expect(jobs.cancel).not.toHaveBeenCalled();
  });

  it("bounds a recovery that resumed after cancellation", async () => {
    const { jobs, handle } = retainTurn();
    const pending = { ...identity, generation: 3, checks: 149, unconfirmed: true as const };
    vi.mocked(settleRetainedConversation).mockResolvedValueOnce({ settled: false });
    await handle({ runId: "run-1", pending });
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(abandonRetainedConversation).toHaveBeenCalledWith(expect.anything(), "run-1", {
      ...pending,
      checks: 150,
    });
  });

  it("keeps failed post-clear cleanup on the bounded polling backoff", async () => {
    vi.mocked(settleRetainedConversation).mockRejectedValueOnce(new Error("purge unavailable"));
    const { jobs, handle } = retainTurn();
    const pending = { ...identity, token: "op-1", generation: 3, checks: 6 };
    await expect(handle({ runId: "run-1", pending })).resolves.toBeUndefined();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { runId: "run-1", pending: { ...pending, checks: 7 } },
      }),
    );
  });

  it.each([
    ["a new turn is stored at once", {}],
    [
      "a pending turn settles",
      { pending: { ...identity, token: "op-1", generation: 3, checks: 4 } },
    ],
  ])("stops once %s", async (_case, extra) => {
    const { jobs, handle } = retainTurn();
    await handle({ runId: "run-1", ...extra });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [2, 40_000],
    [5, 320_000],
    [6, 600_000],
    [120, 600_000],
  ])(
    "waits longer after each check, at most 10 minutes (after %i checks)",
    async (checks, delay) => {
      vi.mocked(settleRetainedConversation).mockResolvedValueOnce({ settled: false });
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const { jobs, handle } = retainTurn();
        await handle({
          runId: "run-1",
          pending: { ...identity, token: "op-1", generation: 3, checks },
        });
        const [job] = jobs.enqueue.mock.calls[0] as unknown as [{ availableAt: Date }];
        expect(job.availableAt.getTime()).toBe(1_000_000 + delay);
      } finally {
        now.mockRestore();
      }
    },
  );

  it("gives up after about a day of checks, purging the turn if its chat was cleared", async () => {
    vi.mocked(settleRetainedConversation).mockResolvedValueOnce({ settled: false });
    const { jobs, handle } = retainTurn();
    await expect(
      handle({
        runId: "run-1",
        pending: { ...identity, token: "op-1", generation: 3, checks: 149 },
      }),
    ).resolves.toBeUndefined();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(abandonRetainedConversation).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      expect.objectContaining({ generation: 3 }),
    );
  });
});
