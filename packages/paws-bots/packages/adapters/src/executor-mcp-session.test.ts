import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { RemoteConnectorDependencies } from "./installed-connectors.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

/**
 * Streamable HTTP server that keeps its state per mcp-session-id, like a stateful
 * executor: `get_pause` stores a paused execution under the calling session and
 * `get_resume` only knows it in that same session. A resume in a fresh session is
 * answered with the JSON-RPC error a real server sends: "Paused execution is unknown".
 */
function statefulMcpServer() {
  const sessions = new Set<string>();
  const paused = new Map<string, string>();
  const toolCalls: Array<{ session: string | null; tool: string }> = [];
  const deletes: Array<string | null> = [];
  let initializations = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const session = request.headers.get("mcp-session-id");
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") {
      deletes.push(session);
      if (session) sessions.delete(session);
      return new Response(null, { status: 202 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const respond = (body: Record<string, unknown>, responseInit?: ResponseInit) =>
      Response.json({ jsonrpc: "2.0", id: message.id, ...body }, responseInit);
    if (message.method === "initialize") {
      initializations += 1;
      const id = `session-${initializations}`;
      sessions.add(id);
      return respond(
        {
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "stateful", version: "1" },
          },
        },
        { headers: { "mcp-session-id": id } },
      );
    }
    if (!session || !sessions.has(session)) return new Response(null, { status: 404 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      return respond({
        result: {
          tools: [
            {
              name: "get_pause",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "get_resume",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }
    if (message.method === "tools/call") {
      const tool = message.params?.name ?? "";
      toolCalls.push({ session, tool });
      if (tool === "get_pause") {
        const executionId = `exec-of-${session}`;
        paused.set(session, executionId);
        return respond({
          result: {
            content: [{ type: "text", text: "waiting for interaction" }],
            structuredContent: { status: "waiting_for_interaction", executionId },
          },
        });
      }
      if (tool === "get_resume") {
        if (paused.get(session) !== message.params?.arguments?.executionId) {
          return respond({
            error: {
              code: -32000,
              message: `Paused execution is unknown: ${String(
                message.params?.arguments?.executionId,
              )}`,
            },
          });
        }
        paused.delete(session);
        return respond({
          result: { content: [{ type: "text", text: "resumed" }] },
        });
      }
    }
    return new Response(null, { status: 202 });
  });
  const install = {
    id: "mcp-stateful",
    kind: "mcp",
    name: "Stateful MCP",
    source: "https://mcp.example.test/mcp",
    secretId: null,
    createdAt: new Date(0),
    config: { preset: "custom", auth: { type: "none" } },
  };
  return {
    fetch,
    install,
    toolCalls,
    deletes,
    initializations: () => initializations,
  };
}

/** One scripted attempt of the fake runtime; swapped between continueRun passes. */
type AttemptScript = (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;

async function executorHarness(server: ReturnType<typeof statefulMcpServer>) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: null,
    leaseFence: 0,
    leaseOwner: null,
    checkpoint: null,
  };
  const attempts: AttemptScript[] = [];
  const toolResults: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    const script = attempts.shift();
    if (script) yield* script(request);
  });
  const events: AppendEventInput[] = [];
  const prisma = {
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      update: vi.fn(async () => run),
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
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: 1,
        nextEventSeq: events.length + 1,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        events.push(data);
        return { ...data, seq: events.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Pause and resume",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    steeringMessage: { findFirst: vi.fn(async () => null) },
    capabilityInstall: {
      findMany: vi.fn(async () => [server.install]),
      findFirst: vi.fn(async () => server.install),
    },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${data.idempotencyKey}`,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  const remote: RemoteConnectorDependencies = {
    fetch: server.fetch as unknown as typeof globalThis.fetch,
    resolveHostname: publicResolver,
  };
  const connector = new InstalledConnectorProvider(prisma as never, {} as never, remote);
  // Like the real finalizeRun's lease fence: only the attempt that still owns
  // the run row finalizes it; a stale attempt's finalisation returns false.
  const finalizeRun = vi.fn(async (input: { leaseOwner?: string; leaseFence?: number }) =>
    input.leaseFence === run.leaseFence && input.leaseOwner === run.leaseOwner
      ? { continuationRunId: null }
      : false,
  );
  const pauseRunForInput = vi.fn(async () => {
    // The real pause releases the lease: waiting_input with no owner.
    run.status = "waiting_input";
    run.leaseOwner = null;
    return { continuationRunId: null };
  });
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    connector,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async (event: AppendEventInput) =>
        appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event),
      ),
      finalizeRun,
      pauseRunForInput,
      notify: vi.fn(async () => undefined),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    executor,
    run,
    attempts,
    toolResults,
    pauseRunForInput,
    finalizeRun,
    connector,
    prisma,
  };
}

describe("run-scoped MCP sessions across attempts", () => {
  it("keeps the session when the attempt ends on an ask, so the resumed attempt resumes the paused execution", async () => {
    const server = statefulMcpServer();
    const { executor, run, attempts, toolResults, pauseRunForInput } =
      await executorHarness(server);

    attempts.push(async function* pauseAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
      const result = await request.executeTool?.("get_pause", {}, "call-1");
      toolResults.push(result);
      // The real cleanup path: consumeRunEvents returns on the ask and
      // withRuntimeCleanup aborts this attempt's signal on the way out.
      yield { type: "ask", text: "Continue with the recorded change?" };
    });
    await executor.continueRun(run.id, "worker-1");

    expect(pauseRunForInput).toHaveBeenCalledTimes(1);
    expect(toolResults[0]).toMatchObject({
      structuredContent: { status: "waiting_for_interaction" },
    });
    const executionId = (toolResults[0] as { structuredContent: { executionId: string } })
      .structuredContent.executionId;
    // The aborted attempt must not have closed the run's session.
    expect(server.deletes).toEqual([]);
    expect(server.initializations()).toBe(1);

    attempts.push(async function* resumeAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_resume", args: { executionId }, executionId: "call-2" };
      const result = await request.executeTool?.("get_resume", { executionId }, "call-2");
      toolResults.push(result);
      yield { type: "done", text: "Resumed and finished." };
    });
    await executor.continueRun(run.id, "worker-1");

    expect(toolResults[1]).toMatchObject({ content: [{ text: "resumed" }] });
    expect(server.initializations()).toBe(1);
    expect(server.toolCalls.map((call) => call.session)).toEqual(["session-1", "session-1"]);
    // The completed run ends its lifetime, which closes the session.
    expect(server.deletes).toEqual(["session-1"]);
  });

  it("closes the session when the run is cancelled while the attempt runs", async () => {
    const server = statefulMcpServer();
    const { executor, run, attempts } = await executorHarness(server);

    attempts.push(async function* workingAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
      await request.executeTool?.("get_pause", {}, "call-1");
      // Keep events flowing so the consumer's lease check sees the cancellation.
      for (let index = 0; index < 80; index += 1) {
        yield { type: "progress", text: "working" };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const cancelled = executor.continueRun(run.id, "worker-1");
    await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
    run.status = "cancelled";
    run.leaseOwner = null;
    await cancelled;

    await vi.waitFor(() => expect(server.deletes).toEqual(["session-1"]));
  });

  it("ends the paused run's sessions through the connector when it finalized elsewhere", async () => {
    const server = statefulMcpServer();
    const { executor, run, attempts, connector } = await executorHarness(server);
    const endRun = vi.spyOn(connector, "endRun");

    attempts.push(async function* pauseAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
      await request.executeTool?.("get_pause", {}, "call-1");
      yield { type: "ask", text: "Continue with the recorded change?" };
    });
    await executor.continueRun(run.id, "worker-1");
    expect(server.deletes).toEqual([]);

    // The run was cancelled (or finished) while it waited; another worker owns
    // its finalisation. This worker's next touch must release its run state.
    run.status = "cancelled";
    run.leaseOwner = null;
    await executor.continueRun(run.id, "worker-1");

    expect(endRun).toHaveBeenCalledWith("run-1");
    await vi.waitFor(() => expect(server.deletes).toEqual(["session-1"]));
  });

  it("keeps the recovered attempt's session when a stale attempt's finalisation is fenced out", async () => {
    const server = statefulMcpServer();
    const { executor, run, attempts, toolResults, finalizeRun } = await executorHarness(server);

    let releaseStale: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    attempts.push(async function* staleAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
      toolResults.push(await request.executeTool?.("get_pause", {}, "call-1"));
      // The lease expires under this attempt; it learns that only after unwinding.
      await stalled;
      throw new Error("stale attempt unwinds");
    });
    const stale = executor.continueRun(run.id, "worker-1");
    await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
    const executionId = (toolResults[0] as { structuredContent: { executionId: string } })
      .structuredContent.executionId;

    // The same process recovered the run under a newer fence while the stale
    // attempt hung; the recovered attempt owns the run and its session now.
    run.leaseFence += 1;
    let openResume: (() => void) | undefined;
    const resumeGate = new Promise<void>((resolve) => {
      openResume = resolve;
    });
    attempts.push(async function* recoveredAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_resume", args: { executionId }, executionId: "call-2" };
      await resumeGate;
      toolResults.push(await request.executeTool?.("get_resume", { executionId }, "call-2"));
      yield { type: "done", text: "Recovered." };
    });
    const recovered = executor.continueRun(run.id, "worker-1");

    releaseStale?.();
    await stale;
    // The stale attempt's fenced-out finalisation returned false and must not
    // close the session the recovered attempt is about to use.
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(await finalizeRun.mock.results[0]?.value).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.deletes).toEqual([]);

    openResume?.();
    await recovered;
    expect(toolResults[1]).toMatchObject({ content: [{ text: "resumed" }] });
    expect(server.initializations()).toBe(1);
    expect(server.toolCalls.map((call) => call.session)).toEqual(["session-1", "session-1"]);
    // The recovered attempt's own finalisation ends the run's session.
    expect(server.deletes).toEqual(["session-1"]);
  });

  it("keeps the session when a stale attempt observes lease loss after the recovered attempt paused", async () => {
    const server = statefulMcpServer();
    const { executor, run, attempts, toolResults } = await executorHarness(server);

    let releaseStale: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    attempts.push(async function* staleAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
      toolResults.push(await request.executeTool?.("get_pause", {}, "call-1"));
      await stalled;
      // Wait out the consumer's once-a-second lease check, so the next event
      // observes the recovered attempt's pause instead of skipping the check.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      yield { type: "progress", text: "working" };
    });
    const stale = executor.continueRun(run.id, "worker-1");
    await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
    const executionId = (toolResults[0] as { structuredContent: { executionId: string } })
      .structuredContent.executionId;

    // The same process recovered the run under a newer fence, and that attempt
    // paused for input: the row is waiting_input with no lease owner, holding
    // the session for the resume that answers it.
    attempts.push(async function* recoveredPause() {
      yield { type: "ask", text: "Check the recorded change?" };
    });
    await executor.continueRun(run.id, "worker-1");
    expect(run.status).toBe("waiting_input");
    expect(run.leaseOwner).toBeNull();

    releaseStale?.();
    await stale;
    // The stale attempt saw a run it no longer owns; the paused, ownerless row
    // must keep the session for the resume.
    expect(server.deletes).toEqual([]);

    attempts.push(async function* resumeAttempt(request: AgentRunRequest) {
      yield { type: "tool", name: "get_resume", args: { executionId }, executionId: "call-2" };
      toolResults.push(await request.executeTool?.("get_resume", { executionId }, "call-2"));
      yield { type: "done", text: "Resumed after recovery." };
    });
    await executor.continueRun(run.id, "worker-1");

    expect(toolResults[1]).toMatchObject({ content: [{ text: "resumed" }] });
    expect(server.initializations()).toBe(1);
    expect(server.toolCalls.map((call) => call.session)).toEqual(["session-1", "session-1"]);
    expect(server.deletes).toEqual(["session-1"]);
  });

  it("ends the session when the heartbeat detects the cancellation before the event consumer does", async () => {
    vi.useFakeTimers();
    try {
      const server = statefulMcpServer();
      const { executor, run, attempts, finalizeRun, prisma } = await executorHarness(server);

      let sessionReady: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        sessionReady = resolve;
      });
      let releaseStream: (() => void) | undefined;
      const gated = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      attempts.push(async function* workingAttempt(request: AgentRunRequest) {
        yield { type: "tool", name: "get_pause", args: {}, executionId: "call-1" };
        await request.executeTool?.("get_pause", {}, "call-1");
        sessionReady?.();
        // No further events flow, so the consumer cannot observe the
        // cancellation itself; only the heartbeat can.
        await gated;
        yield { type: "progress", text: "working" };
      });
      const attempt = executor.continueRun(run.id, "worker-1");
      await opened;

      // The run is cancelled elsewhere. The heartbeat's next renewal must fail,
      // so let it see the row the way the real database would.
      run.status = "cancelled";
      run.leaseOwner = null;
      const updateMany = prisma.run.updateMany;
      prisma.run.updateMany = vi.fn(
        async (args: { where?: { status?: string }; data?: Record<string, unknown> }) =>
          args.where?.status === "running" && run.status !== "running"
            ? { count: 0 }
            : updateMany(args as { data: Record<string, unknown> }),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      releaseStream?.();
      await attempt;
      // The consumer exits on the invalidated lease before its own check marks
      // anything; the row the attempt leaves behind must still end the session.
      expect(finalizeRun).not.toHaveBeenCalled();
      expect(server.toolCalls.map((call) => call.session)).toEqual(["session-1"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(server.deletes).toEqual(["session-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
