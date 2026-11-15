import type { AgentRunModel } from "@rakazo/adapter-kit";
import { APPROVED_ACTION_NOT_RUN_ERROR, isConversationalRun } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "../../adapters/src/computer-lifecycle.js";
import { createRunExecutor } from "../../adapters/src/executor.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { startModelEmulator } from "./model-emulator.js";

vi.mock("../../adapters/src/computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  holdComputerExecutionLeaseForTakeover: async () => true,
  provisionComputer: async () => ({
    id: "fixture-computer",
    botId: "fixture-bot",
    kind: "fake",
    providerRef: "fixture-computer",
  }),
}));

function fixture(
  model: AgentRunModel,
  encryptedCheckpoint = false,
  toolName = "fixture_write",
  requireApproval = true,
  /** A confirmed image reply linked to this run, with its real steering row binding. */
  reply?: { steeringRunId: string | null; messageRunId?: string },
  supportsImages = false,
) {
  const run = {
    id: "fixture-run",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    taskId: "fixture-task",
    spaceId: "fixture-space",
    userId: "fixture-owner",
    status: "queued",
    trigger: "routine",
    routineId: null,
    leaseFence: 0,
    checkpoint: null,
    sourceMessageId: null as string | null,
  };
  const task = { id: run.taskId, prompt: "Read evidence then complete the fixture." };
  const replyBlocks = [
    {
      kind: "image",
      artifactId: "fixture-image",
      name: "reply.png",
      mimeType: "image/png",
      size: 4,
      imageHandling: "confirm",
    },
  ];
  // Like a send during active work, the message is linked to the run for display either way.
  const replyMessage = {
    id: "resumed-reply",
    threadId: run.threadId,
    runId: reply?.messageRunId ?? run.id,
    role: "user",
    seq: 2,
    createdAt: new Date(),
    blocks: replyBlocks,
    steeringMessages: [],
  };
  const steering: Array<{ id: string; messageId: string; runId: string | null }> = reply
    ? [{ id: "reply-steering", messageId: replyMessage.id, runId: reply.steeringRunId }]
    : [];
  const effects: Record<string, unknown>[] = [];
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma = new Proxy(
    {
      $contentEncryption: () =>
        encryptedCheckpoint
          ? {
              ring: {
                encryptWrites: true,
                byId: async () => ({
                  id: "fixture-key",
                  spaceId: "fixture-space",
                  version: 1,
                  key: new Uint8Array(32).fill(7),
                }),
              },
            }
          : undefined,
      spaceSettingOverride: { findUnique: async () => null },
      userActionApprovalRule: {
        findMany: async () => [
          {
            effect: requireApproval ? "require_approval" : "allow",
            matchKind: "tool",
            matchValue: toolName,
          },
        ],
      },
      artifact: {
        ...empty,
        findMany: async () => [{ id: "fixture-image", storageKey: "fixture-image-key" }],
      },
      message: {
        ...empty,
        findMany: async ({ where }: { where?: { OR?: Record<string, unknown>[] } } = {}) =>
          (reply ? [replyMessage] : []).filter(
            (message) =>
              !where?.OR ||
              where.OR.some((match) =>
                "id" in match
                  ? message.id === match.id
                  : "runId" in match
                    ? message.runId === match.runId
                    : steering.some(
                        (row) =>
                          row.messageId === message.id &&
                          row.runId ===
                            (match as { steeringMessages: { some: { runId: string } } })
                              .steeringMessages.some.runId,
                      ),
              ),
          ),
        create: async ({ data }: { data: object }) => ({ id: "fixture-message", ...data }),
      },
      event: { ...empty, create: async ({ data }: { data: object }) => ({ seq: 1, ...data }) },
      usageRecord: { createMany: async () => ({ count: 1 }) },
      run: {
        findUnique: async () => ({ ...run }),
        findUniqueOrThrow: async () => ({ ...run }),
        findFirst: async () => null,
        updateMany: async ({ data }: { data: object }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      task: { findUniqueOrThrow: async () => task, updateMany: async () => ({ count: 1 }) },
      bot: {
        ...empty,
        update: async () => ({}),
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Fixture",
          title: "Fixture",
          description: "Fixture",
          modelProvider: model.provider,
          modelId: model.id,
          computerId: "fixture-computer",
          computerSwitching: false,
          memoryScope: null,
          computer: {
            id: "fixture-computer",
            scope: "dedicated",
            kind: "fake",
            homeKey: "fixture-home",
          },
        }),
      },
      attempt: {
        ...empty,
        create: async () => ({ id: "fixture-attempt" }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        count: async () => 2,
      },
      thread: {
        update: async () => ({ nextEventSeq: 1, nextMessageSeq: 1 }),
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          nextMessageSeq: 1,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
        }),
      },
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: model.provider,
          defaultModelId: model.id,
        }),
      },
      userModelCredential: {
        ...empty,
        findMany: async () => [
          {
            id: "fixture-credential",
            provider: model.provider,
            defaultModel: model.id,
            secretId: "fixture-key",
          },
        ],
      },
      secret: {
        ...empty,
        findFirst: async () => ({ id: "fixture-key", ciphertext: "fixture-ciphertext" }),
      },
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(prisma),
      externalEffect: {
        ...empty,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          ),
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          effects.find((effect) => effect.idempotencyKey === where.idempotencyKey) ?? null,
        create: async ({ data }: { data: object }) => {
          const effect = { id: `fixture-effect-${effects.length}`, ...data };
          effects.push(effect);
          return effect;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
          const matching = effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          );
          for (const effect of matching) Object.assign(effect, data);
          return { count: matching.length };
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { idempotencyKey: string };
          create: object;
          update: object;
        }) => {
          const previous = effects.find((effect) => effect.idempotencyKey === where.idempotencyKey);
          if (previous) {
            Object.assign(previous, update);
            return previous;
          }
          const effect = { id: `fixture-effect-${effects.length}`, ...create };
          effects.push(effect);
          return effect;
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          for (let i = effects.length - 1; i >= 0; i--)
            if (
              Object.entries(where).every(
                ([key, value]) => typeof value === "object" || effects[i]![key] === value,
              )
            )
              effects.splice(i, 1);
          return { count: 1 };
        },
      },
    },
    {
      get(target, key) {
        return key in target ? target[key as keyof typeof target] : empty;
      },
    },
  );
  const finalizeRun = vi.fn(async (input) => {
    run.status = input.outcome;
    await prisma.externalEffect.deleteMany({
      where: { runId: run.id, kind: "runtime_checkpoint" },
    });
    return { continuationRunId: null };
  });
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return { continuationRunId: null };
  });
  const pauseRunForTakeover = vi.fn(async () => {
    run.status = "waiting_takeover";
    return { continuationRunId: null };
  });
  const writes = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
  const reads = vi.fn(async (_computer: unknown, _path: string) =>
    new TextEncoder().encode("unique-executor-evidence"),
  );
  const executor = createRunExecutor({
    prisma,
    artifacts: { get: async () => new Uint8Array([137, 80, 78, 71]) },
    runtime: new PiAgentRuntime(),
    mcpAllowPrivateEndpoint: true,
    deploymentModelKey: "fixture-key",
    secretStore: {
      load: async () =>
        JSON.stringify({
          kind: "openai_compatible",
          apiKey: "local",
          baseUrl: model.baseUrl,
          allowPrivateEndpoint: true,
          contextWindow: 160000,
          maxTokens: 1024,
          visionModelIds: supportsImages ? [model.id] : [],
        }),
    },
    connector: {
      discoverTools: async () => [
        {
          name: toolName,
          description: "Write the fixture",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      ],
      async *execute(call: { args: Record<string, unknown> }) {
        writes(call.args);
        yield { type: "result", data: { ok: true, result: "fixture-approved-result" } };
      },
    },
    sandbox: {
      describe: () => ({ id: "fake", capabilities: { graphical: true } }),
      readFile: reads,
      writeFile: writes,
      async *exportWorkspace() {},
      releaseScreen: async () => undefined,
    },
    home: { commit: async () => "fixture-revision" },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      notify: vi.fn(async () => undefined),
      append: vi.fn(async () => undefined),
      // Production claim rule: routine turns take only rows bound to them; pending rows wait.
      claimSteering: async (input: { runId: string; seenIds: string[] }) =>
        steering
          .filter(
            (row) =>
              !input.seenIds.includes(row.id) &&
              (row.runId === input.runId ||
                (row.runId === null && isConversationalRun(run.trigger))),
          )
          .map((row) => {
            row.runId = input.runId;
            return {
              id: row.id,
              messageId: row.messageId,
              text: "Read this image",
              blocks: replyBlocks,
            };
          }),
      finalizeRun,
      pauseRunForInput,
      pauseRunForTakeover,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    executor,
    prisma,
    run,
    task,
    effects,
    finalizeRun,
    pauseRunForInput,
    pauseRunForTakeover,
    writes,
    reads,
  };
}

describe("executor paused transcript", () => {
  it.each(["user", "routine"])(
    "delivers a resumed %s reply image through bounded recent history",
    async (trigger) => {
      const model = await startModelEmulator({
        steps: [
          {
            expect(request) {
              expect(
                JSON.stringify(request.messages).match(/data:image\/png;base64,iVBORw==/g),
              ).toHaveLength(1);
            },
            response: { type: "text", text: "Read the image." },
          },
        ],
      });
      try {
        const state = fixture(
          model.model,
          false,
          "fixture_write",
          false,
          { steeringRunId: "fixture-run" },
          true,
        );
        state.run.trigger = trigger;
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
      } finally {
        await model.close();
      }
    },
  );
  it.each(["user", "routine"])(
    "guards a resumed %s run's confirmed reply after a late text-only model change",
    async (trigger) => {
      const model = await startModelEmulator({
        steps: [{ expect() {}, response: { type: "text", text: "Must not call" } }],
      });
      try {
        const state = fixture(model.model, false, "fixture_write", false, {
          steeringRunId: "fixture-run",
        });
        state.run.trigger = trigger;
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed", error: expect.stringMatching(/image/i) }),
        );
        expect(model.requests).toHaveLength(0);
      } finally {
        await model.close();
      }
    },
  );
  it("finishes a text-only background routine while its continuation owns the image", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain("data:image");
          },
          response: { type: "text", text: "Routine done." },
        },
      ],
    });
    try {
      // A send during routine work links the message to the routine but leaves steering pending.
      const state = fixture(model.model, false, "fixture_write", false, { steeringRunId: null });
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      await model.close();
    }
  });
  it("guards the continuation that owns an image sent during background work", async () => {
    const model = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Must not call" } }],
    });
    try {
      const state = fixture(model.model, false, "fixture_write", false, {
        steeringRunId: "fixture-run",
        messageRunId: "finished-routine",
      });
      state.run.trigger = "follow_up";
      state.run.sourceMessageId = "resumed-reply";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", error: expect.stringMatching(/image/i) }),
      );
      expect(model.requests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });
  it.each(["allow", "deny"])(
    "%s keeps checkpoint storage separate from action effects",
    async (answer) => {
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "pending-action",
              name: "fixture_write",
              arguments: { content: "approved-fixture" },
            },
          },
          {
            expect(request) {
              const result = request.messages.find((m) => m.tool_call_id === "pending-action");
              expect(result).toBeDefined();
              if (answer === "allow") expect(result?.content).toContain("fixture-approved-result");
              else expect(result?.content).toContain("denied");
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      try {
        const state = fixture(model.model);
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(state.writes).not.toHaveBeenCalled();
        expect(state.effects).toHaveLength(2);
        expect(state.effects.map((effect) => [effect.kind, effect.status])).toEqual([
          ["fixture_write", "intended"],
          ["runtime_checkpoint", "runtime_checkpoint"],
        ]);
        for (const effect of state.effects)
          if (effect.status === "intended")
            effect.status = answer === "allow" ? "approved" : "denied";
        state.run.status = "queued";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(state.writes).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        expect(state.effects).toHaveLength(1);
        expect(state.effects[0]).toMatchObject({
          kind: "fixture_write",
          status: answer === "allow" ? "completed" : "denied",
        });
      } finally {
        await model.close();
      }
    },
  );
  it.each([false, true])(
    "executes identical writes with a reused provider call ID once each (approval pauses: %s)",
    async (approvalPauses) => {
      const args = { content: "same-fixture" };
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: { type: "tool", id: "reused", name: "fixture_write", arguments: args },
          },
          {
            expect(request) {
              expect(request.messages.filter((m) => m.tool_call_id === "reused")).toHaveLength(1);
            },
            response: { type: "tool", id: "reused", name: "fixture_write", arguments: args },
          },
          {
            expect(request) {
              // The repeated id is renamed so each result stays paired with its own call.
              const results = request.messages.filter(
                (m) => m.tool_call_id === "reused" || m.tool_call_id === "reused_1",
              );
              expect(results.map((m) => m.tool_call_id)).toEqual(["reused", "reused_1"]);
              for (const result of results)
                expect(result.content).toContain("fixture-approved-result");
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      try {
        const state = fixture(model.model, false, "fixture_write", approvalPauses);
        await state.executor.continueRun(state.run.id, "fixture-worker");
        if (approvalPauses) {
          for (let occurrence = 0; occurrence < 2; occurrence++) {
            expect(state.run.status).toBe("waiting_input");
            expect(state.writes).toHaveBeenCalledTimes(occurrence);
            expect(state.pauseRunForInput).toHaveBeenCalledTimes(occurrence + 1);
            const pending = state.effects.filter((effect) => effect.status === "intended");
            expect(pending).toHaveLength(1);
            pending[0]!.status = "approved";
            // Neither restored arguments nor continuation text may replace approval.
            const checkpoint = state.effects.find(
              (effect) => effect.kind === "runtime_checkpoint",
            )!;
            const saved = JSON.parse(String(checkpoint.result));
            const pendingMessage = saved.messages.findLast(
              (message: { role: string }) => message.role === "assistant",
            );
            pendingMessage.content.find(
              (call: { type: string }) => call.type === "toolCall",
            ).arguments = { content: "different-content" };
            checkpoint.result = JSON.stringify(saved);
            state.task.prompt = "Write different-content instead.";
            state.run.status = "queued";
            await state.executor.continueRun(state.run.id, "fixture-worker");
          }
        }
        model.assertComplete();
        expect(state.writes.mock.calls).toEqual([[args], [args]]);
        const actions = state.effects.filter((effect) => effect.kind === "fixture_write");
        expect(actions).toHaveLength(2);
        expect(new Set(actions.map((effect) => effect.idempotencyKey)).size).toBe(2);
        expect(actions.every((effect) => effect.status === "completed")).toBe(true);
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
      } finally {
        await model.close();
      }
    },
  );
  it.each([
    ["fixture_write", false],
    ["fixture.write", false],
    ["fixture_write", true],
  ] as const)(
    "runs an approved later identical occurrence once with %s (legacy snapshot: %s)",
    async (toolName, legacy) => {
      const wireName = toolName.replace(".", "_");
      const args = { content: "same-fixture" };
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: { type: "tool", id: "earlier", name: wireName, arguments: args },
          },
          { expect() {}, response: { type: "tool", id: "later", name: wireName, arguments: args } },
          {
            expect(request) {
              expect(request.messages.find((m) => m.tool_call_id === "earlier")).toBeDefined();
              expect(request.messages.find((m) => m.tool_call_id === "later")?.content).toContain(
                "fixture-approved-result",
              );
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      try {
        const state = fixture(model.model, false, toolName);
        // The first call also pauses; approve it, then pause on the identical second call.
        await state.executor.continueRun(state.run.id, "fixture-worker");
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(state.writes).toHaveBeenCalledTimes(1);
        expect(state.pauseRunForInput).toHaveBeenCalledTimes(2);
        if (legacy) {
          const checkpoint = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
          const saved = JSON.parse(String(checkpoint.result));
          delete saved.effectOccurrences;
          checkpoint.result = JSON.stringify(saved);
        }
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(state.writes).toHaveBeenCalledTimes(2);
        expect(state.effects.filter((effect) => effect.kind === toolName)).toHaveLength(2);
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
      } finally {
        await model.close();
      }
    },
  );
  it("keeps parallel checkpoint captures bound to the pausing call on resume", async () => {
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tools",
            calls: [
              { id: "finished-read", name: "read_file", arguments: { path: "finished.txt" } },
              {
                id: "pending-write",
                name: "fixture_write",
                arguments: { content: "approved-fixture" },
              },
              { id: "late-read", name: "read_file", arguments: { path: "late.txt" } },
            ],
          },
        },
        {
          expect(request) {
            const results = request.messages.filter((message) => message.role === "tool");
            expect(
              results.find((message) => message.tool_call_id === "late-read")?.content,
            ).toContain("outcome is unknown");
            expect(
              results.find((message) => message.tool_call_id === "pending-write")?.content,
            ).toContain("fixture-approved-result");
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    try {
      const state = fixture(model.model);
      state.reads.mockImplementation(async (_computer, path) => {
        if (path === "late.txt") await late;
        return new TextEncoder().encode("unique-executor-evidence");
      });
      state.pauseRunForInput.mockImplementation(async () => {
        state.run.status = "waiting_input";
        releaseLate();
        return { continuationRunId: null };
      });
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.reads).toHaveBeenCalledTimes(2);
      const saved = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
      expect(model.requests).toHaveLength(1);
      expect(JSON.parse(String(saved.result)).pendingToolCallId).toBe("pending-write");
      for (const effect of state.effects)
        if (effect.status === "intended") effect.status = "approved";
      state.run.status = "queued";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.reads).toHaveBeenCalledTimes(2);
      expect(state.writes).toHaveBeenCalledExactlyOnceWith({ content: "approved-fixture" });
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      releaseLate();
      await model.close();
    }
  });
  it("resumes the approved call when parallel calls need approval at once", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tools",
            calls: [
              { id: "first-write", name: "fixture_write", arguments: { content: "first" } },
              { id: "second-write", name: "fixture_write", arguments: { content: "second" } },
            ],
          },
        },
        {
          expect(request) {
            const result = request.messages.find((m) => m.tool_call_id === "first-write");
            expect(result?.content).toContain("fixture-approved-result");
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    try {
      const state = fixture(model.model);
      // The store pauses only a running run, and the pause commits after a delay, so both
      // calls reach the approval step before either pause lands.
      state.pauseRunForInput.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (state.run.status !== "running") return false as never;
        state.run.status = "waiting_input";
        return { continuationRunId: null };
      });
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.pauseRunForInput).toHaveBeenCalledOnce();
      const card = JSON.stringify(state.pauseRunForInput.mock.calls[0]);
      const approved = state.effects.find(
        (effect) => effect.kind === "fixture_write" && card.includes(String(effect.id)),
      )!;
      expect(approved.request).toEqual({ content: "first" });
      const checkpoint = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
      expect(JSON.parse(String(checkpoint.result)).pendingToolCallId).toBe("first-write");

      approved.status = "approved";
      state.run.status = "queued";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.writes).toHaveBeenCalledExactlyOnceWith({ content: "first" });
      expect(approved.status).toBe("completed");
      expect(state.pauseRunForInput).toHaveBeenCalledOnce();
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      await model.close();
    }
  });
  it("claims the approved row when a resumed call counts its occurrence differently", async () => {
    const args = { content: "same-fixture" };
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "tool", id: "earlier", name: "fixture_write", arguments: args },
        },
        {
          expect() {},
          response: { type: "tool", id: "later", name: "fixture_write", arguments: args },
        },
        // The saved turn is unusable, so the model is asked in text and calls again.
        {
          expect() {},
          response: { type: "tool", id: "repeat", name: "fixture_write", arguments: args },
        },
        {
          expect(request) {
            const result = request.messages.find((m) => m.tool_call_id === "repeat");
            expect(result?.content).toContain("fixture-approved-result");
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    try {
      const state = fixture(model.model);
      const approvePending = () => {
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
      };
      await state.executor.continueRun(state.run.id, "fixture-worker");
      approvePending();
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.writes).toHaveBeenCalledOnce();
      expect(state.pauseRunForInput).toHaveBeenCalledTimes(2);
      const checkpoint = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
      checkpoint.result = JSON.stringify({ ...JSON.parse(String(checkpoint.result)), version: 99 });
      approvePending();
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.writes.mock.calls).toEqual([[args], [args]]);
      const writes = state.effects.filter((effect) => effect.kind === "fixture_write");
      expect(writes.map((effect) => effect.status)).toEqual(["completed", "completed"]);
      expect(state.pauseRunForInput).toHaveBeenCalledTimes(2);
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      await model.close();
    }
  });
  it("drops an earlier saved turn when a helper pauses for approval", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "earlier",
            name: "fixture_write",
            arguments: { content: "main" },
          },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "delegate",
            name: "run_subagent",
            arguments: { name: "helper", task: "Write the helper fixture." },
          },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "helper-write",
            name: "fixture_write",
            arguments: { content: "helper" },
          },
        },
      ],
    });
    try {
      const state = fixture(model.model);
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(true);
      for (const effect of state.effects)
        if (effect.status === "intended") effect.status = "approved";
      state.run.status = "queued";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.pauseRunForInput).toHaveBeenCalledTimes(2);
      expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(false);
    } finally {
      await model.close();
    }
  });
  it("fails with a clear message when the model does not repeat an approved call", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "pending",
            name: "fixture_write",
            arguments: { content: "approved-fixture" },
          },
        },
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
    });
    try {
      const state = fixture(model.model);
      await state.executor.continueRun(state.run.id, "fixture-worker");
      const checkpoint = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
      checkpoint.result = JSON.stringify({ ...JSON.parse(String(checkpoint.result)), version: 99 });
      for (const effect of state.effects)
        if (effect.status === "intended") effect.status = "approved";
      state.run.status = "queued";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.writes).not.toHaveBeenCalled();
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", error: APPROVED_ACTION_NOT_RUN_ERROR }),
      );
    } finally {
      await model.close();
    }
  });
  it.each([false, true])(
    "fails closed on an unreadable encrypted checkpoint before opening the model (key available: %s)",
    async (keyAvailable) => {
      const model = await startModelEmulator({ steps: [] });
      try {
        const state = fixture(model.model, keyAvailable);
        state.effects.push({
          kind: "runtime_checkpoint",
          status: "runtime_checkpoint",
          runId: state.run.id,
          spaceId: state.run.spaceId,
          idempotencyKey: JSON.stringify(["runtime_checkpoint", state.run.id]),
          result: "rkz1:fixture-key:invalid:invalid:invalid",
        });
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed" }),
        );
        expect(model.requests).toHaveLength(0);
        expect(state.writes).not.toHaveBeenCalled();
        model.assertComplete();
      } finally {
        await model.close();
      }
    },
  );
  it.each(["version", "missing-tool"])(
    "falls back safely for a checkpoint with %s",
    async (failure) => {
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "pending",
              name: "fixture_write",
              arguments: { content: "approved-fixture" },
            },
          },
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("fixture_write");
            },
            response: {
              type: "tool",
              id: "new-choice",
              name: "fixture_write",
              arguments: { content: "changed-fixture" },
            },
          },
          { expect() {}, response: { type: "text", text: "Done." } },
        ],
      });
      try {
        const state = fixture(model.model);
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(state.pauseRunForInput).toHaveBeenCalledOnce();
        const checkpoint = state.effects.find((effect) => effect.kind === "runtime_checkpoint")!;
        const saved = JSON.parse(String(checkpoint.result));
        if (failure === "version") saved.version = 99;
        else
          saved.messages.find(
            (message: { role: string }) => message.role === "assistant",
          ).content[0].name = "removed_fixture_tool";
        checkpoint.result = JSON.stringify(saved);
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(state.writes).toHaveBeenCalledExactlyOnceWith({ content: "approved-fixture" });
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
        expect(state.pauseRunForInput).toHaveBeenCalledOnce();
      } finally {
        await model.close();
      }
    },
  );
  it.each(["ask_user", "approval", "normalized-approval", "request_takeover"])(
    "restores %s through the real executor before opening the model",
    async (pause) => {
      const approval = pause === "approval" || pause === "normalized-approval";
      const toolName = pause === "normalized-approval" ? "fixture.write" : "fixture_write";
      const name = approval ? "fixture_write" : pause;
      const args = approval
        ? { content: "exact-approved-content" }
        : pause === "request_takeover"
          ? { reason: "Complete the fixture step" }
          : { question: "Which fixture?", options: ["One", "Two"] };
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "evidence",
              name: "read_file",
              arguments: { path: "fixture.txt" },
            },
          },
          {
            expect(request) {
              expect(request.tools?.map((tool) => tool.function.name)).toContain(name);
            },
            response: { type: "tool", id: "pending", name, arguments: args },
          },
          {
            expect(request) {
              const evidence = request.messages.find(
                (message) => message.role === "tool" && message.tool_call_id === "evidence",
              );
              expect(JSON.stringify(evidence)).toContain("unique-executor-evidence");
              const result = request.messages.find(
                (message) => message.role === "tool" && message.tool_call_id === "pending",
              );
              expect(result).toBeDefined();
              if (approval) expect(JSON.stringify(result)).toContain("fixture-approved-result");
              if (pause === "ask_user") expect(JSON.stringify(result)).toContain("Two");
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      try {
        const state = fixture(model.model, false, toolName);
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(
          pause === "request_takeover" ? state.pauseRunForTakeover : state.pauseRunForInput,
          JSON.stringify(state.finalizeRun.mock.calls),
        ).toHaveBeenCalledOnce();
        expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(true);
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
        if (pause === "request_takeover") state.run.checkpoint = "takeover" as never;
        state.task.prompt = "Two";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(model.requests).toHaveLength(3);
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
        expect(
          pause === "request_takeover" ? state.pauseRunForTakeover : state.pauseRunForInput,
          JSON.stringify(state.finalizeRun.mock.calls),
        ).toHaveBeenCalledOnce();
        expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(false);
        if (approval) {
          expect(state.writes).toHaveBeenCalledOnce();
          expect(state.writes.mock.calls[0]).toEqual([{ content: "exact-approved-content" }]);
        }
      } finally {
        await model.close();
      }
    },
  );
  it("gates a deferred built-in run through use_tool like a direct call", async () => {
    const args = { title: "Call the dentist" };
    const toolResult = (
      request: { messages: { role: string; tool_call_id?: string }[] },
      id: string,
    ) =>
      JSON.stringify(
        request.messages.find((message) => message.role === "tool" && message.tool_call_id === id),
      );
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            const names = request.tools?.map((tool) => tool.function.name);
            expect(names).toEqual(expect.arrayContaining(["find_tool", "use_tool"]));
            expect(names).not.toContain("scratchpad_add");
          },
          response: {
            type: "tool",
            id: "find",
            name: "find_tool",
            arguments: { query: "scratchpad add" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request, "find")).toContain("Short title for the item.");
          },
          response: {
            type: "tool",
            id: "unoffered",
            name: "use_tool",
            arguments: { name: "call_user", arguments: { reason: "Fixture" } },
          },
        },
        {
          expect(request) {
            expect(toolResult(request, "unoffered")).toContain("call_user is not available");
          },
          response: {
            type: "tool",
            id: "pending",
            name: "use_tool",
            arguments: { name: "scratchpad_add", arguments: args },
          },
        },
        {
          expect(request) {
            expect(toolResult(request, "pending")).toBeDefined();
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    try {
      const state = fixture(model.model, false, "scratchpad_add");
      state.run.trigger = "user";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      expect(state.pauseRunForInput).toHaveBeenCalledOnce();
      const pending = state.effects.filter((effect) => effect.status === "intended");
      expect(pending.map((effect) => effect.kind)).toEqual(["scratchpad_add"]);
      expect(pending[0]!.request).toEqual(args);
      expect(state.effects.some((effect) => effect.kind === "call_user")).toBe(false);
      for (const effect of pending) effect.status = "approved";
      state.run.status = "queued";
      await state.executor.continueRun(state.run.id, "fixture-worker");
      model.assertComplete();
      expect(state.pauseRunForInput).toHaveBeenCalledOnce();
      expect(state.effects.find((effect) => effect.kind === "scratchpad_add")?.status).not.toBe(
        "intended",
      );
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      await model.close();
    }
  });
});
