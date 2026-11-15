import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { PINNED_COMPUTER_MODEL_LOST_RUN_ERROR } from "./computer-model-settings.js";
import { createRunExecutor } from "./executor.js";
import type * as ModelRolesModule from "./model-roles.js";
import type * as ModelSelectionModule from "./model-selection.js";
import { findConnectedModelCredential } from "./model-selection.js";
import type * as RunModelModule from "./run-model.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelectionModule>()),
  findConnectedModelCredential: vi.fn(async (_prisma, _secrets, _scope, provider) => ({
    id: "main-account",
    provider,
  })),
}));

vi.mock("./model-roles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelRolesModule>()),
  resolveMemberMainModel: async ({
    prisma,
  }: {
    prisma: { deploymentSettings: { findUnique: () => Promise<{ defaultModelId: string }> } };
  }) => ({
    provider: "openrouter",
    modelId: (await prisma.deploymentSettings.findUnique()).defaultModelId,
    credentialId: "main-account",
    credential: { id: "main-account" },
    thinkingLevel: "high",
  }),
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import {
  resolveConnectedModelKey,
  resolveConnectedRunModel,
  resolveModelKey,
} from "./run-model.js";

const fake = vi.hoisted(() => ({ stream: vi.fn(), unavailable: new Set<string>() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({
      provider,
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://models.invalid/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    streamSimple: (...args: unknown[]) => fake.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));
vi.mock("./run-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunModelModule>()),
  resolveModelKey: vi.fn(async (_deps, _user, _space, _credential, _provider, id) => {
    if (fake.unavailable.has(id)) throw new Error(`Unavailable model ${id}`);
    return { apiKey: "fixture-key", redact: [], acceptsImages: true };
  }),
  resolveConnectedRunModel: vi.fn(
    async (_deps, _scope, provider, id, _register, _required, thinkingLevel, connectionId) => {
      if (fake.unavailable.has(id)) throw new Error(`Unavailable model ${id}`);
      return {
        provider,
        id,
        connectionId,
        thinkingLevel,
        apiKey: "fixture-key",
        acceptsImages: true,
      };
    },
  ),
  resolveConnectedModelKey: vi.fn(
    async (_deps, _scope, _provider, id, _register, _required, connectionId) => {
      if (fake.unavailable.has(id)) throw new Error(`Unavailable model ${id}`);
      return {
        credential: { id: connectionId },
        resolved: { apiKey: "fixture-key", redact: [], acceptsImages: true },
      };
    },
  ),
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

function fixture(runId = "run-1") {
  const effects: Effect[] = [];
  const artifactRows: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  const artifactPut = vi.fn();
  const messageCreate = vi.fn(async ({ data }: { data: unknown }) => ({
    id: "message-1",
    ...(data as object),
  }));
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const externalEffect = {
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { idempotencyKey: string };
        create: Omit<Effect, "id">;
        update: Partial<Effect>;
      }) => {
        const existing = effects.find((effect) => effect.idempotencyKey === where.idempotencyKey);
        if (existing) Object.assign(existing, update);
        else effects.push({ ...create, id: `effect-${effects.length + 1}` });
      },
    ),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: { runId?: string; kind?: string; request?: { equals: string } };
      }) =>
        effects.find(
          (effect) =>
            (!where.runId || effect.runId === where.runId) &&
            (!where.kind || effect.kind === where.kind) &&
            (!where.request ||
              (effect.request as { executionId?: string }).executionId === where.request.equals),
        ) ?? null,
    ),
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; spaceId?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.spaceId && effect.spaceId !== where.spaceId) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status?: string | { not: string } };
        data: Partial<Effect>;
      }) => {
        const effect = effects.find(
          (effect) =>
            effect.id === where.id &&
            (!where.status ||
              (typeof where.status === "string"
                ? effect.status === where.status
                : effect.status !== where.status.not)),
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const choice = { modelId: "main-a" };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    space: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    usageRecord: {
      createMany: vi.fn(async (_input: { data: Array<{ model: string }> }) => ({ count: 1 })),
    },
    modelCreditEntry: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: { findMany: vi.fn(async () => []) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: "openrouter",
        modelId: choice.modelId,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: messageCreate,
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    artifact: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          artifactRows.find((row) => row.id === where.id) ?? null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async ({ where }: { where: { role?: string } }) =>
        where.role === "computer"
          ? [
              {
                position: 0,
                provider: "anthropic",
                modelId: "computer-c",
                credentialId: "computer-account",
                thinkingLevel: null,
              },
            ]
          : [],
      ),
    },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: choice.modelId,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    computer: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    secret: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    spaceSettingOverride: { findUnique: async () => null },
    userActionApprovalRule: {
      findMany: vi.fn(async () => [
        { effect: "require_approval", matchKind: "tool", matchValue: "browser_act" },
      ]),
    },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const runtime = new PiAgentRuntime();
  const runtimeRun = vi.fn(runtime.run.bind(runtime));
  const browserAct = vi.fn(async () => ({ ok: true }));
  const browserPage = { available: true };
  const shutdown = new AbortController();
  const executor = createRunExecutor({
    shutdownSignal: shutdown.signal,
    deploymentModelKey: "fixture-model-key",
    prisma: {
      ...prisma,
      $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    },
    artifacts: { put: artifactPut, get: vi.fn() },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
    },
    browser: {
      describe: () => ({ capabilities: { page: browserPage.available } }),
      act: browserAct,
    },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      claimSteering: vi.fn(async () => []),
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput,
      finalizeRun,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    choice,
    browserAct,
    browserPage,
    runtimeRun,
    finalizeRun,
    prisma,
    shutdown,
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

function respond(target: Model<"openai-completions">, calls: ToolCall[] = []) {
  const message: AssistantMessage = {
    role: "assistant",
    api: target.api,
    provider: target.provider,
    model: target.id,
    content: calls.length ? calls : [{ type: "text", text: "Done" }],
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: 1,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
  stream.end(message);
  return stream;
}
const click = {
  type: "toolCall" as const,
  id: "click",
  name: "browser_act",
  arguments: { actions: [{ kind: "click", ref: "button-1" }] },
};
const leave = {
  type: "toolCall" as const,
  id: "leave",
  name: "leave_computer_mode",
  arguments: { summary: "Clicked" },
};
function script(tail: ToolCall[] = []) {
  const steps = [
    [
      {
        type: "toolCall" as const,
        id: "enter",
        name: "enter_computer_mode",
        arguments: { goal: "Click" },
      },
    ],
    [click, ...tail],
  ];
  fake.stream.mockImplementation((target: Model<"openai-completions">) =>
    respond(target, steps.shift()),
  );
}
beforeEach(() => {
  fake.stream.mockReset();
  fake.unavailable.clear();
  vi.mocked(resolveModelKey).mockClear();
  vi.mocked(resolveConnectedModelKey).mockClear();
  vi.mocked(resolveConnectedRunModel).mockClear();
  vi.mocked(findConnectedModelCredential).mockClear();
});

async function paused(tail: ToolCall[] = []) {
  const f = fixture();
  script(tail);
  await f.run();
  const effect = f.effects.find((entry) => entry.kind === "browser_act");
  expect(effect?.status).toBe("intended");
  expect(f.browserAct).not.toHaveBeenCalled();
  const checkpoint = f.effects.find((entry) => entry.kind === "runtime_checkpoint");
  expect(checkpoint?.result).toEqual(expect.any(String));
  fake.stream.mockReset();
  return { ...f, effect: effect!, checkpoint: checkpoint! };
}
it("resumes an approved browser action followed by leave in the same assistant batch", async () => {
  const f = await paused([leave]);
  const key = f.effect.idempotencyKey;
  f.effect.status = "approved";
  fake.stream.mockImplementation((target: Model<"openai-completions">) => respond(target));
  await f.run();
  expect(f.finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(f.browserAct).toHaveBeenCalledTimes(1);
  expect(f.effect).toMatchObject({ status: "completed", idempotencyKey: key });
  expect(f.effects.filter((entry) => entry.kind === "browser_act")).toHaveLength(1);
  expect(fake.stream.mock.calls.map((call) => call[0].id)).toEqual(["main-a"]);
});
it("resolves saved A/C before unavailable current B and executes the pending effect once", async () => {
  const f = await paused();
  const key = f.effect.idempotencyKey;
  f.effect.status = "approved";
  f.choice.modelId = "main-b";
  fake.unavailable.add("main-b");
  vi.mocked(resolveModelKey).mockClear();
  vi.mocked(resolveConnectedRunModel).mockClear();
  vi.mocked(findConnectedModelCredential).mockClear();
  fake.stream.mockImplementation((target: Model<"openai-completions">) =>
    respond(target, target.id === "computer-c" ? [leave] : []),
  );
  await f.run();
  expect(vi.mocked(resolveModelKey).mock.calls.some((call) => call[5] === "main-b")).toBe(false);
  expect(f.browserAct).toHaveBeenCalledTimes(1);
  expect(f.effect).toMatchObject({ status: "completed", idempotencyKey: key });
  expect(f.effects.filter((entry) => entry.kind === "browser_act")).toHaveLength(1);
  expect(fake.stream.mock.calls.map((call) => call[0].id)).toEqual(["computer-c", "main-a"]);
  expect(findConnectedModelCredential).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(resolveConnectedRunModel)
      .mock.calls.every((call) => ["main-a", "computer-c"].includes(call[3])),
  ).toBe(true);
  expect(f.runtimeRun.mock.calls.at(-1)?.[0].model).toMatchObject({
    id: "main-a",
    connectionId: "main-account",
    thinkingLevel: "high",
  });
  expect(
    f.prisma.usageRecord.createMany.mock.calls.slice(-2).map((call) => call[0].data[0]?.model),
  ).toEqual(["computer-c", "main-a"]);
});
it("resumes a denied browser action plus leave without dispatching the denied effect", async () => {
  const f = await paused([leave]);
  const key = f.effect.idempotencyKey;
  f.effect.status = "rejected";
  fake.stream.mockImplementation((target: Model<"openai-completions">) => respond(target));
  await f.run();
  expect(f.finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(f.browserAct).not.toHaveBeenCalled();
  expect(f.effect).toMatchObject({ status: "rejected", idempotencyKey: key });
  expect(f.effects.filter((entry) => entry.kind === "browser_act")).toHaveLength(1);
  expect(fake.stream.mock.calls.map((call) => call[0].id)).toEqual(["main-a"]);
});
it("does not dispatch an approved pending action or transition after cancellation", async () => {
  const f = await paused([leave]);
  f.effect.status = "approved";
  f.shutdown.abort();
  await f.run();
  expect(f.browserAct).not.toHaveBeenCalled();
  expect(fake.stream).not.toHaveBeenCalled();
  expect(f.effect.status).toBe("approved");
});
it("retries without an error report while the paused action's tool is offline", async () => {
  const f = await paused();
  f.effect.status = "approved";
  f.browserPage.available = false;
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  try {
    await expect(f.run()).rejects.toMatchObject({
      cause: { name: "PausedTurnToolsUnavailableError" },
    });
  } finally {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  }
  expect(sink.events.filter((event) => event.message === "run setup failed")).toEqual([
    expect.objectContaining({ level: "warn" }),
  ]);
  expect(fake.stream).not.toHaveBeenCalled();
  expect(f.browserAct).not.toHaveBeenCalled();
});
it.each([
  { provider: "anthropic" },
  { id: "other-model" },
  { connectionId: "other-account" },
  {
    oauth: {
      credential: { type: "oauth" as const, access: "fixture", refresh: "fixture", expires: 1 },
    },
  },
])(
  "fails the run once for mismatched saved credentials %j without consulting current B",
  async (override) => {
    const f = await paused();
    f.effect.status = "approved";
    f.choice.modelId = "main-b";
    vi.mocked(resolveModelKey).mockClear();
    vi.mocked(resolveConnectedRunModel).mockResolvedValueOnce({
      provider: "openrouter",
      id: "main-a",
      connectionId: "main-account",
      apiKey: "fixture-key",
      ...override,
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: PINNED_COMPUTER_MODEL_LOST_RUN_ERROR }),
    );
    expect(resolveModelKey).not.toHaveBeenCalled();
    expect(fake.stream).not.toHaveBeenCalled();
    expect(f.browserAct).not.toHaveBeenCalled();
  },
);
it.each(["main-a", "computer-c"])(
  "fails closed when saved %s is unavailable even though current B is valid",
  async (id) => {
    const f = await paused();
    f.effect.status = "approved";
    f.choice.modelId = "main-b";
    fake.unavailable.add(id);
    vi.mocked(resolveModelKey).mockClear();
    await expect(f.run()).rejects.toMatchObject({ cause: { message: `Unavailable model ${id}` } });
    expect(vi.mocked(resolveModelKey).mock.calls.some((call) => call[5] === "main-b")).toBe(false);
    expect(fake.stream).not.toHaveBeenCalled();
    expect(f.browserAct).not.toHaveBeenCalled();
  },
);
