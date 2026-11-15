import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { createRunExecutor, createWebProvider, PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "../../adapters/src/computer-lifecycle.js";
import { parallelMcpFixture } from "../../adapters/src/parallel-web.test-support.js";
import { resolveRuntimeModel } from "../../adapters/src/pi-runtime-models.js";
import { startModelEmulator } from "./model-emulator.js";

vi.mock("../../adapters/src/computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer", kind: "desktop" }),
}));

afterEach(() => vi.unstubAllEnvs());

/** Exercise the deployment-selected provider through ordinary executor dispatch. */
function executorFixture(
  runtime: AgentRuntime,
  disabledBuiltinTools: string[] = [],
  result?: unknown,
) {
  const peer = parallelMcpFixture({ result });
  const run = {
    id: "run",
    botId: "bot",
    threadId: "thread",
    taskId: "task",
    spaceId: "space",
    userId: "user",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    user: {
      findUnique: vi.fn<
        (args: { select?: Record<string, boolean> }) => Promise<{ timezone: string } | null>
      >(async () => null),
    },
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    run: {
      findUnique: async () => run,
      findUniqueOrThrow: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    bot: {
      findUniqueOrThrow: async () => ({
        id: "bot",
        name: "Researcher",
        title: "Researcher",
        description: "Research public sources",
        computerId: "computer",
        computer: { id: "computer", scope: "dedicated" },
        disabledBuiltinTools,
      }),
      findMany: async () => [],
    },
    attempt: {
      create: async () => ({ id: "attempt" }),
      update: vi.fn(),
      updateMany: async () => ({ count: 1 }),
    },
    thread: { findUniqueOrThrow: async () => ({ id: "thread", groupId: null }) },
    message: { findMany: async () => [] },
    task: {
      findUniqueOrThrow: async () => ({
        id: "task",
        prompt: "Research the question and read its source",
      }),
    },
    connection: { findMany: async () => [] },
    chatGroup: { findMany: async () => [] },
    userModelPreference: { findFirst: async () => null },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: async () => [] },
    userModelCredential: { findFirst: async () => null },
    deploymentSettings: {
      findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }),
    },
    taughtSkill: { findMany: async () => [] },
    agentSecret: { findMany: async () => [] },
    secret: { findMany: async () => [] },
    vaultCredential: { findMany: async () => [] },
    agentSkill: { findMany: async () => [] },
    scratchpadItem: { findMany: async () => [] },
    userActionApprovalRule: { findMany: async () => [] },
    userActionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    externalEffect: { findMany: async () => [] },
    usageRecord: { createMany: async () => ({ count: 1 }) },
    modelCreditEntry: { findUnique: async () => null },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  vi.stubEnv("WEB_PROVIDER", "parallel");
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-openrouter-key");
  const executor = createRunExecutor({
    prisma,
    runtime,
    web: createWebProvider(undefined, peer.network),
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: async () => undefined, claimSteering: async () => [], finalizeRun },
    jobs: { enqueue: async () => undefined },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    peer,
    prisma,
    finalizeRun,
    resolveModel: () => executor.resolveModel({ userId: run.userId, spaceId: run.spaceId }),
    execute: () => executor.continueRun("run", "worker"),
  };
}

describe("Parallel through the ordinary bot caller", () => {
  it.each(
    ["scripted", "openrouter", "anthropic"].flatMap((provider) =>
      [undefined, "", "   ", "fixture-openrouter-key"].map((key) => ({ provider, key })),
    ),
  )(
    "checks runtime environment credentials for $provider with key '$key'",
    async ({ provider, key }) => {
      vi.stubEnv("PI_DEFAULT_PROVIDER", provider);
      const runtime = {
        describe: () => ({ capabilities: { scripted: false } }),
      } as unknown as AgentRuntime;
      const fixture = executorFixture(runtime);
      vi.stubEnv("OPENROUTER_API_KEY", key);
      vi.spyOn(fixture.prisma.deploymentSettings, "findUnique").mockResolvedValue({
        defaultModelProvider: provider,
        defaultModelId: provider === "scripted" ? "scripted" : "fixture-model",
      });
      if (provider !== "anthropic" && key?.trim()) {
        const model = await fixture.resolveModel();
        expect(model).toBeDefined();
        expect(resolveRuntimeModel(model!).apiKey).toBe(key);
      } else {
        await expect(fixture.resolveModel()).rejects.toThrow(
          "Connect a model in Settings before running bots.",
        );
      }
    },
  );

  it.each(["missing", "failure", "saved"])("uses optional timezone context (%s)", async (state) => {
    let prompt = "";
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      run: async function* (request: AgentRunRequest) {
        prompt = request.prompt;
        yield { type: "done" as const, text: "Done." };
      },
    } as unknown as AgentRuntime;
    const fixture = executorFixture(runtime);
    // Only the timezone lookup varies; the run's account is always active.
    fixture.prisma.user.findUnique.mockImplementation(async ({ select }) => {
      if (!select?.timezone) return null;
      if (state === "failure") throw new Error("lookup unavailable");
      return state === "saved" ? { timezone: "Pacific/Auckland" } : null;
    });
    await fixture.execute();
    expect(prompt).toContain(state === "saved" ? "(Pacific/Auckland)" : "Current date and time:");
    expect(prompt).toContain("(UTC)");
  });

  it.each([false, true])(
    "passes large MCP envelopes through executor dispatch into real Pi's next model steps (text-only=%s)",
    async (textOnly) => {
      const model = await startModelEmulator({
        steps: [
          {
            expect: (request) => {
              expect(request.tools?.some((tool) => tool.function.name === "web_search")).toBe(true);
            },
            response: {
              type: "tool",
              id: "search",
              name: "web_search",
              arguments: { query: "current question", maxResults: 1 },
            },
          },
          {
            expect: (request) => {
              expect(
                JSON.stringify(request.messages.findLast((message) => message.role === "tool")),
              ).toContain("Useful evidence");
            },
            response: {
              type: "tool",
              id: "fetch",
              name: "web_fetch",
              arguments: { url: "https://example.test/page", maxChars: 100 },
            },
          },
          {
            expect: (request) => {
              const result = JSON.stringify(
                request.messages.findLast((message) => message.role === "tool"),
              );
              expect(result).toContain("Page text");
              expect(result).toContain("[Content truncated;");
              expect(result).not.toContain("Invalid Parallel MCP response");
              expect(result.length).toBeLessThan(1_000);
            },
            response: { type: "text", text: "The source supports the answer." },
          },
        ],
      });
      try {
        const pi = new PiAgentRuntime();
        const runtime: AgentRuntime = {
          describe: () => pi.describe(),
          abort: (id) => pi.abort(id),
          run: (request, context) =>
            pi.run(
              { ...request, model: { ...model.model, contextWindow: 200_000, maxTokens: 2048 } },
              context,
            ),
        };
        const data = {
          results: [
            {
              url: "https://example.test/page",
              title: "Source",
              excerpts: ["Useful evidence"],
              full_content: "Page text ".repeat(120_000),
            },
          ],
        };
        const result = {
          content: [{ type: "text", text: JSON.stringify(data) }],
          ...(textOnly ? {} : { structuredContent: data }),
        };
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1_000_000);
        const fixture = executorFixture(runtime, [], result);
        await fixture.execute();
        expect(fixture.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
        model.assertComplete();
        expect(fixture.peer.calls.map((call) => call.name)).toEqual(["web_search", "web_fetch"]);
        expect(
          fixture.peer.requests.every(
            (request) =>
              request.url === "https://search.parallel.ai/mcp" &&
              request.headers.get("user-agent")?.startsWith("Rakazo/") &&
              !request.headers.has("authorization"),
          ),
        ).toBe(true);
      } finally {
        await model.close();
      }
    },
  );

  it("refuses disabled builtin calls before reaching the MCP transport", async () => {
    const results: unknown[] = [];
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      run: async function* (request: AgentRunRequest) {
        expect(request.tools.some((tool) => tool.name === "web_search")).toBe(false);
        results.push(
          await request.executeTool!("web_search", { query: "must not leave" }, "blocked"),
        );
        yield { type: "done" as const, text: "Search is disabled." };
      },
    } as unknown as AgentRuntime;
    const fixture = executorFixture(runtime, ["web_search", "web_fetch"]);
    await fixture.execute();
    expect(results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(fixture.peer.fetch).not.toHaveBeenCalled();
  });
});
