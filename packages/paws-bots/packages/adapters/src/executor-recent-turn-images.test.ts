import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const lifecycleMocks = vi.hoisted(() => ({
  renewComputerExecutionLease: vi.fn(async () => true),
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({
    computerId: input.computerId,
    botId: input.botId,
    runId: input.runId,
    fence: 7,
  }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: lifecycleMocks.renewComputerExecutionLease,
}));

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const VISION_MODEL = "openai/gpt-4o";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type Gate = { reached: Deferred<void>; release: Deferred<void> };
type RunHooks = {
  computer?: { defaultModelId?: string; checkpoint?: string };
  runtimeGate?: Gate;
  notificationGate?: Gate;
  computerLeaseRenewal?: () => Promise<boolean>;
  /** The model lists the computer's files before answering, which starts the computer. */
  useComputer?: boolean;
  trigger?: string;
  sourceMessageId?: string;
  /** A reply bound to this run as steering, claimed before any tool runs. */
  steeringBlocks?: MessageBlock[];
  /** Run in a group thread with this stored history (newest first) and these bot records. */
  group?: {
    messages: ReturnType<typeof historyMessages>;
    bots: Array<{ id: string; name: string }>;
  };
  /** The newest user message points at this run, sends a picture and may wait for its own run. */
  pictureMessage?: { waiting: boolean };
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function historyMessages(pictureMessage?: { waiting: boolean }): Array<{
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string;
  blocks: MessageBlock[];
  replyToMessageId: null;
  replyQuote: null;
  replyTo: null;
  steeringMessages: Array<{ id: string }>;
}> {
  return [
    {
      id: "current",
      threadId: "thread-1",
      seq: 2,
      role: "user",
      runId: "run-1",
      blocks: [
        { kind: "text", text: "what was in the screenshot?" },
        ...(pictureMessage
          ? [
              {
                kind: "image" as const,
                artifactId: "art-2",
                mimeType: "image/png",
                name: "reply.png",
              },
            ]
          : []),
      ],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
      steeringMessages: pictureMessage?.waiting ? [{ id: "held-steering" }] : [],
    },
    {
      id: "earlier",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      runId: "run-0",
      blocks: [{ kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
      steeringMessages: [],
    },
  ];
}

async function runWithModel(
  modelId: string,
  switchModel?: { provider: string; modelId: string; credentialId?: string },
  backupReadFails = false,
  scripted = false,
  finalizeSuccessfully = true,
  hooks?: RunHooks,
) {
  lifecycleMocks.renewComputerExecutionLease.mockReset();
  lifecycleMocks.renewComputerExecutionLease.mockImplementation(
    hooks?.computerLeaseRenewal ?? (async () => true),
  );
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: hooks?.trigger ?? "user",
    sourceMessageId: hooks?.sourceMessageId ?? null,
    leaseFence: 0,
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  const writeFile = vi.fn(async (..._args: unknown[]) => undefined);
  const exportWorkspace = vi.fn(async function* () {
    yield* [];
  });
  const releaseScreen = vi.fn(async (..._args: unknown[]) => undefined);
  let request: AgentRunRequest | undefined;
  let steering: Awaited<ReturnType<NonNullable<AgentRunRequest["claimSteering"]>>> = [];
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    if (hooks?.runtimeGate) {
      hooks.runtimeGate.reached.resolve(undefined);
      await hooks.runtimeGate.release.promise;
    }
    if (switchModel) {
      const onModelChange = (
        next as AgentRunRequest & {
          onModelChange?: (provider: string, modelId: string) => Promise<void>;
        }
      ).onModelChange;
      await onModelChange?.(switchModel.provider, switchModel.modelId);
    }
    if (hooks?.steeringBlocks) steering = (await next.claimSteering?.([])) ?? [];
    if (hooks?.useComputer) {
      const executeTool = (
        next as AgentRunRequest & {
          executeTool?: (name: string, args: Record<string, unknown>, id: string) => unknown;
        }
      ).executeTool;
      await executeTool?.("list_files", { path: "" }, "list-1");
    }
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: {
      findUnique: vi.fn(async () => ({ id: "member-1" })),
      findMany: vi.fn(async () => [{ userId: "user-1" }]),
    },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: {
          id: run.botId,
          name: "Boris",
          color: "blue",
          avatarSet: "default",
          notifyOnFinish: true,
        },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        name: "Planning",
        members: [{ bot: { id: run.botId, name: "Boris", description: "" } }],
      })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) =>
        (hooks?.group?.bots ?? []).filter((bot) => args?.where?.id?.in?.includes(bot.id)),
      ),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: hooks?.group ? "group-1" : null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    message: {
      findMany: vi.fn(async (args: { where?: { threadId?: string } }) =>
        args.where?.threadId
          ? (hooks?.group?.messages ?? historyMessages(hooks?.pictureMessage))
          : [],
      ),
      findUnique: vi.fn(async () => null),
      // A claimed steering reply looks up the message it quotes; this one quotes nothing.
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })) },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async ({ where }: { where: { role: string } }) => {
        if (where.role !== "main") return [];
        // The run reads its main model first and its fallbacks just before the model call.
        if (backupReadFails && prisma.userModelRoleChoice.findMany.mock.calls.length > 1)
          throw new Error("Backup list unavailable");
        return switchModel
          ? [{ ...switchModel, position: 1, thinkingLevel: null as string | null }]
          : [];
      }),
    },

    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: modelId,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    spaceSettingOverride: { findUnique: async () => null },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: {
      findMany: vi.fn(async () => [
        { id: "art-1", storageKey: "shot.png", size: 4, mimeType: "image/png", name: "shot.png" },
        { id: "art-2", storageKey: "reply.png", size: 4, mimeType: "image/png", name: "reply.png" },
      ]),
    },
  };
  if (hooks?.computer) {
    const computerModelId = hooks.computer.defaultModelId;
    prisma.userModelRoleChoice.findMany.mockImplementation(async ({ where }) =>
      where.role === "main"
        ? [
            {
              provider: "openrouter",
              modelId,
              credentialId: "main-conn",
              position: 0,
              thinkingLevel: "high",
            },
          ]
        : where.role === "computer" && computerModelId
          ? [
              {
                provider: "openrouter",
                modelId: computerModelId,
                credentialId: "main-conn",
                position: 0,
                thinkingLevel: null,
              },
            ]
          : [],
    );
    const credential = {
      id: "main-conn",
      userId: run.userId,
      provider: "openrouter",
      secretId: "test-secret",
      defaultModel: modelId,
      userPreferences: [],
    };
    prisma.userModelPreference.findFirst.mockResolvedValue({
      userId: run.userId,
      credentialId: credential.id,
      modelId,
      thinkingLevel: "high",
      isDefault: true,
      credential,
    });
    prisma.userModelCredential.findFirst.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { where: { id?: string } };
      return (!input.where.id || input.where.id === "main-conn" ? credential : null) as never;
    });
    prisma.secret.findFirst.mockResolvedValue({
      id: "test-secret",
      ciphertext: "encrypted",
    } as never);
    prisma.externalEffect.findMany.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { where: { kind?: string } };
      return (
        input.where.kind === "runtime_checkpoint" && hooks.computer?.checkpoint
          ? [{ result: hooks.computer.checkpoint }]
          : []
      ) as never;
    });
  }
  const finalizeRun = vi.fn(async () =>
    finalizeSuccessfully ? { continuationRunId: null } : null,
  );
  const notificationSend = vi.fn(async () => {
    if (!hooks?.notificationGate) return;
    hooks.notificationGate.reached.resolve(undefined);
    await hooks.notificationGate.release.promise;
  });
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: Boolean(hooks?.computer) } }),
      releaseScreen,
      writeFile,
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace,
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      claimSteering: vi.fn(async ({ seenIds }: { seenIds: string[] }) =>
        hooks?.steeringBlocks && !seenIds.includes("reply-steering")
          ? [
              {
                id: "reply-steering",
                messageId: "reply",
                text: "Here it is",
                blocks: hooks.steeringBlocks,
              },
            ]
          : [],
      ),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: hooks?.notificationGate ? { send: notificationSend } : undefined,
    secrets: [],
    secretStore: { load: async () => "fake-key" },
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const execution = executor.continueRun(run.id, "worker-1");
  if (hooks?.runtimeGate) await hooks.runtimeGate.reached.promise;
  else if (hooks?.notificationGate) await hooks.notificationGate.reached.promise;
  else await execution;
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return {
    request,
    steering,
    get,
    writeFile,
    exportWorkspace,
    prisma,
    run,
    releaseScreen,
    execution,
    notificationSend,
  };
}

describe("computer settings reach the shared API/worker executor", () => {
  it("hands screen work to the chosen model without changing main effort", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, true, {
      computer: { defaultModelId: VISION_MODEL },
    });
    expect(request.model).toMatchObject({
      id: TEXT_ONLY_MODEL,
      connectionId: "main-conn",
      thinkingLevel: "high",
    });
    expect(request.computerModel).toMatchObject({ id: VISION_MODEL, connectionId: "main-conn" });
    expect(request.tools?.some((tool) => tool.name === "computer_observe")).toBe(true);
    expect(request.currentTurnImages).toBeUndefined();
    prisma.run.updateMany.mockClear();
    await expect(
      request.onModelChange?.(request.computerModel!.provider, request.computerModel!.id, true),
    ).resolves.toBeUndefined();
    // Retries and pins rerun the run's model, so computer mode never becomes it.
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
    // The same model reached as a backup outside computer mode does become the run's model.
    await request.onModelChange?.(request.computerModel!.provider, request.computerModel!.id);
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { modelProvider: "openrouter", modelId: VISION_MODEL } }),
    );
    prisma.run.updateMany.mockClear();
    await expect(
      request.onModelChange?.(request.model.provider, request.model.id),
    ).resolves.toBeUndefined();
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { modelProvider: request.model.provider, modelId: TEXT_ONLY_MODEL },
      }),
    );
    await expect(request.onModelChange?.("unselected", "model")).rejects.toThrow(/not selected/);
  });
  it("resumes a turn paused before a computer-use model was set without one", async () => {
    const checkpoint = JSON.stringify({
      version: 1,
      provider: "openrouter",
      model: TEXT_ONLY_MODEL,
      systemPrompt: "fixture",
      messages: [],
      pendingToolCallId: "call",
    });
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, true, {
      computer: { defaultModelId: VISION_MODEL, checkpoint },
    });
    expect(request.computerModel).toBeUndefined();
  });
  it("does not switch when the computer-use model is the main model", async () => {
    const { request } = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      computer: { defaultModelId: VISION_MODEL },
    });
    expect(request.computerModel).toBeUndefined();
    expect(request.tools?.some((tool) => tool.name === "computer_observe")).toBe(true);
  });
  it("resolves resumed pins after settings are cleared and refuses an unpinned account", async () => {
    const pin = {
      provider: "openrouter",
      id: VISION_MODEL,
      connectionId: "main-conn",
      auth: "api-key",
      thinkingLevel: "medium",
    };
    const checkpoint = JSON.stringify({
      version: 1,
      provider: "openrouter",
      model: VISION_MODEL,
      systemPrompt: "fixture",
      messages: [],
      pendingToolCallId: "call",
      computerMode: {
        version: 1,
        mode: "computer",
        main: { ...pin, thinkingLevel: "high" },
        computer: pin,
      },
    });
    const { request } = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      computer: { checkpoint },
    });
    expect(request.computerModel).toMatchObject({
      provider: pin.provider,
      id: pin.id,
      connectionId: pin.connectionId,
    });
    expect(request.turnCheckpoint).toBe(checkpoint);
    await expect(request.onModelChange?.(pin.provider, pin.id)).resolves.toBeUndefined();
    expect(
      await request.resolveFallbackModel?.("openrouter", VISION_MODEL, "main-conn"),
    ).toMatchObject({ connectionId: "main-conn", thinkingLevel: "high" });
    await expect(
      request.resolveFallbackModel?.("openrouter", VISION_MODEL, "other"),
    ).rejects.toThrow();
  });
});

describe("recent turn images follow model vision", () => {
  it("does not send history images to a text-only model", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL);

    expect(request.model.id).toBe(TEXT_ONLY_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
  });

  it("lists an earlier turn's image without starting the computer for it", async () => {
    const { request, writeFile, releaseScreen } = await runWithModel(TEXT_ONLY_MODEL);

    expect(writeFile).not.toHaveBeenCalled();
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(request.prompt).toContain(
      'Files attached earlier in this conversation are also on your computer:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
  });

  it("puts an earlier turn's image on the computer once the bot uses it", async () => {
    const { request, writeFile, exportWorkspace } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      true,
      { useComputer: true },
    );

    expect(writeFile.mock.calls.map(([, file]) => file)).toEqual([
      { path: "attachments/art-1.png", content: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(request.prompt).toContain(
      'Files attached earlier in this conversation are also on your computer:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
    expect(exportWorkspace).not.toHaveBeenCalled();
  });

  it("lists and copies a file reply bound to a resumed routine", async () => {
    // "Send as file" stores the picture as a file block; a routine reads no thread history.
    const { request, steering, writeFile } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      true,
      {
        useComputer: true,
        trigger: "routine",
        steeringBlocks: [
          { kind: "text", text: "Here it is" },
          { kind: "file", artifactId: "art-2", name: "reply.png", mimeType: "image/png", size: 4 },
        ],
      },
    );

    expect(request.currentRunRequiresImageInput).toBeFalsy();
    expect(steering).toHaveLength(1);
    expect(steering[0]?.text).toContain('"attachments/art-2.png"');
    expect(steering[0]?.images).toBeUndefined();
    expect(writeFile.mock.calls.map(([, file]) => file)).toContainEqual({
      path: "attachments/art-2.png",
      content: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("attaches an earlier turn's image for a model that can see it", async () => {
    const { request, get } = await runWithModel(VISION_MODEL);

    expect(request.model.id).toBe(VISION_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images?.[0]).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(request.history.find((entry) => entry.id === "current")?.images).toBeUndefined();
    expect(get).toHaveBeenCalledWith("shot.png", expect.anything());
  });

  it("does not take a chat message waiting for its own run as a sourceless app run's turn", async () => {
    // An app run with no source message, like the one queued after an MCP server connects.
    const held = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      pictureMessage: { waiting: true },
    });
    expect(held.request.currentTurnImages).toBeUndefined();

    const bound = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      pictureMessage: { waiting: false },
    });
    expect(bound.request.currentTurnImages).toEqual([
      { name: "reply.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
  });

  it("continues with no backups when the indexed lookup fails", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, true);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", role: "main" } }),
    );
  });

  it("does not read or configure backups for scripted runs", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, true);
    // Only the main model itself is read.
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledTimes(1);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
  });

  it("does not recover a backup's missing secret with a deployment key", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.model.apiKey).toBe("fake-deployment-key");
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.userModelPreference.findFirst.mockResolvedValue({
      modelId: backup.modelId,
      thinkingLevel: null,
      credential: {
        id: "backup-credential",
        userId: "user-1",
        provider: backup.provider,
        label: "Backup",
        secretId: "missing-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    vi.stubEnv("OPENROUTER_API_KEY", "fake-deployment-key");
    try {
      await expect(resolve(backup.provider, backup.modelId)).rejects.toThrow(
        "Backup model credential is no longer available",
      );
      expect(prisma.userModelPreference.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            modelId: backup.modelId,
            credential: { provider: backup.provider },
          },
        }),
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { id: "missing-secret", userId: "user-1", spaceId: null },
      });
      await expect(resolve("openai", "gpt-4o")).rejects.toThrow("Backup model is not selected");
      expect(prisma.secret.findFirst).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves a backup pinned to a connection on that connection only", async () => {
    const backup = {
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      credentialId: "work-credential",
    };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.fallbackModels).toEqual([
      { provider: backup.provider, id: backup.modelId, connectionId: "work-credential" },
    ]);
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.userModelCredential.findFirst.mockResolvedValue({
      id: "work-credential",
      userId: "user-1",
      provider: backup.provider,
      label: "Work",
      secretId: "work-secret",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [],
    } as never);
    prisma.userModelPreference.findFirst.mockClear();
    // The same model without its connection is not a configured backup.
    await expect(resolve(backup.provider, backup.modelId)).rejects.toThrow(
      "Backup model is not selected",
    );
    await expect(resolve(backup.provider, backup.modelId, "work-credential")).rejects.toThrow(
      "Backup model credential is no longer available",
    );
    expect(prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "work-credential", userId: "user-1", provider: backup.provider },
      }),
    );
    expect(prisma.userModelPreference.findFirst).not.toHaveBeenCalled();
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "work-secret", userId: "user-1", spaceId: null },
    });
  });

  it("persists the switched model against the current run lease", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request, run } = await runWithModel(TEXT_ONLY_MODEL, backup);

    expect(request?.model.id).toBe(TEXT_ONLY_MODEL);
    expect(run).toMatchObject({ modelProvider: backup.provider, modelId: backup.modelId });
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: expect.any(Number),
      },
      data: { modelProvider: backup.provider, modelId: backup.modelId },
    });
  });
});

describe("screen lifecycle after run completion", () => {
  it("keeps only a successfully finalized run's screen warm and uses a dedicated screen fence", async () => {
    const completed = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      useComputer: true,
    });
    expect(completed.releaseScreen).toHaveBeenCalledOnce();
    expect(completed.releaseScreen.mock.calls[0]?.[1]).toMatchObject({
      keepScreenWarm: true,
      screenLeaseId: "run-1:7",
    });

    const unfinished = await runWithModel(VISION_MODEL, undefined, false, false, false, {
      useComputer: true,
    });
    expect(unfinished.releaseScreen).toHaveBeenCalledOnce();
    expect(unfinished.releaseScreen.mock.calls[0]?.[1]).not.toHaveProperty("keepScreenWarm");
    expect(unfinished.releaseScreen.mock.calls[0]?.[1]).toMatchObject({ screenLeaseId: "run-1:7" });
  });

  it("ignores in-flight lease renewal after successful completion", async () => {
    vi.useFakeTimers();
    const runtimeGate = { reached: deferred<void>(), release: deferred<void>() };
    const notificationGate = { reached: deferred<void>(), release: deferred<void>() };
    const renewalStarted = deferred<void>();
    const renewalResult = deferred<boolean>();
    let completed: Awaited<ReturnType<typeof runWithModel>> | undefined;

    try {
      completed = await runWithModel(VISION_MODEL, undefined, false, false, true, {
        runtimeGate,
        notificationGate,
        useComputer: true,
        computerLeaseRenewal: () => {
          renewalStarted.resolve(undefined);
          return renewalResult.promise;
        },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await renewalStarted.promise;
      expect(lifecycleMocks.renewComputerExecutionLease).toHaveBeenCalledOnce();

      runtimeGate.release.resolve(undefined);
      await notificationGate.reached.promise;
      await vi.advanceTimersByTimeAsync(120_000);

      renewalResult.resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      notificationGate.release.resolve(undefined);
      await completed.execution;

      const releaseContext = completed.releaseScreen.mock.calls[0]?.[1] as {
        keepScreenWarm?: boolean;
        signal: AbortSignal;
      };
      expect({
        renewals: lifecycleMocks.renewComputerExecutionLease.mock.calls.length,
        signalAborted: releaseContext.signal.aborted,
        keepScreenWarm: releaseContext.keepScreenWarm,
      }).toEqual({ renewals: 1, signalAborted: false, keepScreenWarm: true });
    } finally {
      runtimeGate.release.resolve(undefined);
      renewalResult.resolve(false);
      notificationGate.release.resolve(undefined);
      if (completed) await completed.execution;
      vi.useRealTimers();
    }
  });
});

describe("group history speakers", () => {
  const row = (
    seq: number,
    role: string,
    text: string,
    botId?: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `m${seq}`,
    threadId: "thread-1",
    seq,
    role,
    botId,
    runId: "run-0",
    blocks: [{ kind: "text" as const, text }] as MessageBlock[],
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
    steeringMessages: [],
    ...extra,
  });
  // Newest first, as the history query returns them. The run's own bot is "bot-1".
  const stored = [
    row(5, "user", "@Boris who named it?"),
    row(4, "bot", "Bluebird."),
    row(3, "bot", "Half an ans", "bot-2", { clientNonce: "partial-reply:run-9" }),
    row(2, "bot", "Mystery.", "bot-gone"),
    row(1, "bot", "Bluebird.", "bot-3"),
    row(0, "user", "Name our project."),
  ];
  const bots = [
    { id: "bot-2", name: "Anya" },
    // Archived bots are still found: the lookup does not filter on archivedAt.
    { id: "bot-3", name: "Renamed Anya" },
  ];

  it("labels the user and the other bots, and leaves this bot's own replies plain", async () => {
    const { request, prisma } = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      group: { messages: stored, bots },
    });
    expect(
      request.history.map(({ role, speaker, content }) => ({ role, speaker, content })),
    ).toEqual([
      { role: "user", speaker: "User", content: "Name our project." },
      { role: "assistant", speaker: "Renamed Anya", content: "Bluebird." },
      { role: "assistant", speaker: "another bot", content: "Mystery." },
      {
        role: "assistant",
        speaker: "Anya",
        content: expect.stringMatching(/^Half an ans\n\n.+/s),
      },
      { role: "assistant", speaker: undefined, content: "Bluebird." },
      { role: "user", speaker: "User", content: "@Boris who named it?" },
    ]);
    // One lookup for every other bot; the receiving bot's own id is not asked for.
    const lookups = prisma.bot.findMany.mock.calls.filter(
      ([args]) => (args as { where?: { id?: { in?: unknown } } } | undefined)?.where?.id?.in,
    );
    expect(lookups).toHaveLength(1);
    expect((lookups[0]![0] as { where: { id: { in: string[] } } }).where.id.in.sort()).toEqual([
      "bot-2",
      "bot-3",
      "bot-gone",
    ]);
    expect(request.promptSpeaker).toBe("User");
    expect(request.instructions).toContain('messages from other members start with "[Name]:"');
  });

  it("adds no speakers or prompt label in a direct chat", async () => {
    const { request, prisma } = await runWithModel(VISION_MODEL);
    expect(request.history.some((entry) => "speaker" in entry)).toBe(false);
    expect(request.promptSpeaker).toBeUndefined();
    expect(
      prisma.bot.findMany.mock.calls.some(
        ([args]) => (args as { where?: { id?: { in?: unknown } } } | undefined)?.where?.id?.in,
      ),
    ).toBe(false);
  });

  const file = {
    kind: "file",
    artifactId: "art-2",
    name: "reply.png",
    mimeType: "image/png",
    size: 4,
  } as const;
  it.each([
    {
      via: "message",
      trigger: "bot_message",
      role: "user",
      block: {
        kind: "bot_message_received",
        fromBotId: "bot-2",
        fromBotName: "Anya",
        text: "Deploy this",
        hop: 1,
      },
    },
    {
      via: "handoff",
      trigger: "follow_up",
      role: "bot",
      block: { kind: "handoff", fromBotId: "bot-2", toBotId: "bot-1", text: "Deploy this", hop: 1 },
    },
  ] as const)("puts files another bot sent by $via onto this bot's computer", async (sent) => {
    const delivered = row(6, sent.role, "", sent.role === "bot" ? "bot-2" : undefined, {
      id: "delivered",
      blocks: [sent.block, file] as MessageBlock[],
    });
    const { request, writeFile } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      true,
      {
        group: { messages: [delivered, ...stored], bots },
        trigger: sent.trigger,
        sourceMessageId: "delivered",
        useComputer: true,
      },
    );
    expect(request.prompt).toContain(
      "Attachments will be copied to these paths when a tool needs the computer.",
    );
    expect(request.prompt).toContain('"attachments/art-2.png"');
    expect(writeFile.mock.calls.map(([, file]) => file)).toContainEqual({
      path: "attachments/art-2.png",
      content: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("labels the prompt only for runs the user started", async () => {
    const { request } = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      group: { messages: stored, bots },
      trigger: "bot_message",
    });
    expect(request.promptSpeaker).toBeUndefined();
  });
});
