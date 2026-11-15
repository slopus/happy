import type {
  AgentRunRequest,
  BackgroundJob,
  MemoryCommitRequest,
  MemoryReadRequest,
  MemorySnapshot,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";

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

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(runId = "run-1") {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const media = new FakeMediaGenerationProvider();
  const artifactRows: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  const artifactPut = vi.fn();
  const messageCreate = vi.fn(async ({ data }: { data: unknown }) => ({
    id: "message-1",
    ...(data as object),
  }));
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
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
  const memoryCommit = vi.fn(async (_request: MemoryCommitRequest) => ({ revision: "rev-1" }));
  const memoryDocuments: MemorySnapshot["documents"] = [];
  const externalEffect = {
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
  const prisma = {
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    $transaction: vi.fn(async (write: (tx: unknown) => unknown) => write(prisma)),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
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
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 1),
    },
    steeringMessage: {
      findFirst: vi.fn(async () => null),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
    },
    message: { findMany: vi.fn(async () => []), create: messageCreate },
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
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    secret: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    spaceSettingOverride: { findUnique: async () => null },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma: {
      ...prisma,
      $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    },
    mediaGeneration: media,
    artifacts: { put: artifactPut, get: vi.fn() },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async (request: MemoryReadRequest) => ({
        documents: memoryDocuments.filter((doc) => !request.path || doc.path === request.path),
      }),
      search: async () => [],
      commit: memoryCommit,
      remove: vi.fn(async () => ({ removed: false })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput,
      finalizeRun,
    },
    jobs: { enqueue },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    enqueue,
    media,
    artifactRows,
    artifactPut,
    messageCreate,
    results,
    scratchpadRows,
    memoryCommit,
    memoryDocuments,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("mutating tool effect idempotency keys", () => {
  it.each(["generate_image", "generate_video"] as const)(
    "recovers interrupted %s through the executor with a changed tool-call ID",
    async (name) => {
      const runId = `run-recover-${name}`;
      const f = fixture(runId);
      const args = { prompt: "create a landscape" };
      f.effects.push({
        id: "wrapper",
        spaceId: "space-1",
        runId,
        kind: name,
        idempotencyKey: toolEffectIdempotencyKey(runId, name, args),
        status: "executing",
        request: args,
      });
      f.effects.push({
        id: "saved-media",
        spaceId: "space-1",
        runId,
        kind: "media_generation_job",
        idempotencyKey: `media:${runId}:0`,
        status: name === "generate_image" ? "media_polling" : "media_pending",
        request: { prompt: args.prompt, executionId: "wrapper" },
        result: {
          provider: "fake",
          ...(name === "generate_video"
            ? { jobId: "remote-video" }
            : { artifactId: "saved-image" }),
        },
      });
      f.artifactRows.push({
        id: "saved-image",
        name: "generated.png",
        mimeType: "image/png",
        size: 4,
      });
      const image = vi.spyOn(f.media, "generateImage");
      const video = vi.spyOn(f.media, "generateVideo");
      const poll = vi.spyOn(f.media, "pollVideo");
      f.setCalls([{ name, args, executionId: "new-call-after-restart" }]);
      await f.run();
      expect(f.results[0]).toEqual(
        name === "generate_video"
          ? { jobId: "saved-media", status: "queued" }
          : { status: "completed", artifactId: "saved-image" },
      );
      expect(f.effects[0]?.status).toBe("completed");
      f.setCalls([{ name, args, executionId: "another-call-after-restart" }]);
      await f.run();
      expect(f.results[1]).toEqual(f.results[0]);
      expect(image).not.toHaveBeenCalled();
      expect(video).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(f.artifactPut).not.toHaveBeenCalled();
      if (name === "generate_image") expect(f.messageCreate).toHaveBeenCalledTimes(1);
      else expect(f.messageCreate).not.toHaveBeenCalled();
    },
  );
  it("keys a new video job by the stable approved effect instead of the model call ID", async () => {
    const f = fixture("run-media-submit");
    const args = { prompt: "create a landscape" };
    f.effects.push({
      id: "wrapper",
      spaceId: "space-1",
      runId: "run-media-submit",
      kind: "generate_video",
      idempotencyKey: toolEffectIdempotencyKey("run-media-submit", "generate_video", args),
      status: "approved",
      request: args,
    });
    const submit = vi.spyOn(f.media, "generateVideo");
    f.setCalls([{ name: "generate_video", args, executionId: "model-call-id" }]);
    await f.run();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      f.effects.find((effect) => effect.kind === "media_generation_job")?.request,
    ).toMatchObject({ executionId: "wrapper" });
    expect(f.results[0]).toMatchObject({ status: "queued" });
  });
  it("leaves a queued video to background delivery when the run ends before it finishes", async () => {
    const f = fixture("run-video-handoff");
    const args = { prompt: "a landscape" };
    f.effects.push({
      id: "approved-video",
      spaceId: "space-1",
      runId: "run-video-handoff",
      kind: "generate_video",
      idempotencyKey: toolEffectIdempotencyKey("run-video-handoff", "generate_video", args),
      status: "approved",
      request: args,
    });
    f.setCalls([{ name: "generate_video", args, executionId: "call-1" }]);
    await f.run();
    const job = f.effects.find((effect) => effect.kind === "media_generation_job");
    expect(f.results[0]).toEqual({ jobId: job?.id, status: "queued", progress: 0 });
    // The run is over, so only durable work can still bring the finished video to the chat.
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "media.poll", payload: { jobId: job?.id } }),
    );
  });
  it("keeps interrupted media with no saved result uncertain instead of submitting again", async () => {
    const f = fixture("run-unknown-media");
    const args = { prompt: "create a landscape" };
    f.effects.push({
      id: "wrapper",
      spaceId: "space-1",
      runId: "run-unknown-media",
      kind: "generate_video",
      idempotencyKey: toolEffectIdempotencyKey("run-unknown-media", "generate_video", args),
      status: "executing",
      request: args,
    });
    const submit = vi.spyOn(f.media, "generateVideo");
    f.setCalls([{ name: "generate_video", args, executionId: "changed-call-id" }]);
    await f.run();
    expect(f.results[0]).toMatchObject({ uncertain: true });
    expect(submit).not.toHaveBeenCalled();
  });
  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("appends a remembered fact to the bot's existing memory", async () => {
    const f = fixture("run-append");
    f.memoryDocuments.push({
      id: "doc-1",
      path: "MEMORY.md",
      content: "Save trip files to Drive.\n",
      revision: 2,
      updatedAt: new Date(0).toISOString(),
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "The client is Combient." },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.memoryCommit.mock.calls[0]?.[0]).toMatchObject({
      path: "MEMORY.md",
      content: "Save trip files to Drive.\nThe client is Combient.\n",
      expectedRevision: 2,
    });
    expect(f.results[0]).toEqual({ ok: true });
  });

  it.each(["", "  MEMORY.md  ", "other.md", "bot"])(
    "writes MEMORY.md whatever path %j the model passes",
    async (path) => {
      const f = fixture("run-path");
      f.memoryDocuments.push(
        { id: "other", path: "other.md", content: "unrelated\n", revision: 7 },
        { id: "memory", path: "MEMORY.md", content: "existing\n", revision: 2 },
      );
      f.setCalls([
        { name: "remember", args: { path, content: "new fact" }, executionId: "call_0" },
      ]);

      await f.run();

      expect(f.memoryCommit).toHaveBeenCalledOnce();
      expect(f.memoryCommit.mock.calls[0]?.[0]).toMatchObject({
        path: "MEMORY.md",
        content: "existing\nnew fact\n",
        expectedRevision: 2,
      });
      expect(f.results[0]).toEqual({ ok: true });
    },
  );

  it("does not save a fact the bot's memory already holds", async () => {
    const f = fixture("run-known");
    f.memoryDocuments.push({
      id: "doc-1",
      path: "MEMORY.md",
      content: "The client is Combient.\n",
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "The client is Combient." },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("re-reads and appends again when another save wins the race", async () => {
    const f = fixture("run-race");
    f.memoryCommit.mockImplementationOnce(async () => {
      f.memoryDocuments.push({
        id: "doc-1",
        path: "MEMORY.md",
        content: "another writer fact\n",
        revision: 1,
        updatedAt: new Date(0).toISOString(),
      });
      throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.memoryCommit.mock.calls[0]?.[0]).toMatchObject({
      content: "durable fact\n",
      expectedRevision: 0,
    });
    expect(f.memoryCommit.mock.calls[1]?.[0]).toMatchObject({
      content: "another writer fact\ndurable fact\n",
      expectedRevision: 1,
    });
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      spaceId: "space-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      spaceId: "space-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      spaceId: "space-1",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      spaceId: "space-1",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});

describe("add_mcp_server", () => {
  it("never adds a local (stdio) server", async () => {
    const f = fixture();
    f.setCalls([
      {
        name: "add_mcp_server",
        args: { name: "Files", transport: "stdio", command: "npx" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.results[0]).toEqual({
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    });
  });
});
