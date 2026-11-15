import type { ComputerRef } from "@rakazo/adapter-kit";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { prepareRequestSecretArguments } from "./pi-runtime-tools.js";
import { EncryptedSecretStore } from "./secrets.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

const CANARIES = [
  "canary-user-4Kq",
  "canary-pass-8Zt",
  "canary-path-2Vm",
  "canary-query-6Rb",
  "canary-hash-9Lw",
];
const PAGE_URL = `https://${CANARIES[0]}:${CANARIES[1]}@www.example.test/${CANARIES[2]}/sign-in?next=${CANARIES[3]}#${CANARIES[4]}`;

/** Every database call, by model and method, so a test can check what was written anywhere. */
function recordingPrisma(models: Record<string, Record<string, unknown>>, calls: unknown[]) {
  const fallback: Record<string, (...args: unknown[]) => unknown> = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(prisma);
        }
        if (model === "$queryRaw") return async () => [];
        const methods = models[model] ?? {};
        return new Proxy(methods, {
          get: (target, method: string) => {
            const impl = (target[method] ?? fallback[method]) as
              | ((...args: unknown[]) => unknown)
              | undefined;
            return async (...args: unknown[]) => {
              calls.push([model, method, args]);
              return impl ? impl(...args) : null;
            };
          },
        });
      },
    },
  );
  return prisma;
}

async function requestSecretWith(origin: string, extra: Record<string, unknown> = {}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "message",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const calls: unknown[] = [];
  const toolResults: unknown[] = [];
  // The model's arguments, prepared the way the agent runtime prepares them for the executor.
  const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
    const args = prepareRequestSecretArguments({
      label: "Sign in",
      purpose: "password",
      credential: { name: "site_login", origin, auth: { type: "login" } },
      ...extra,
    });
    toolResults.push(await request.executeTool?.("request_secret", args, "exec-1"));
    yield { type: "done" as const, text: "" };
  });
  const prisma = recordingPrisma(
    {
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: async () => run,
        findUniqueOrThrow: async () => run,
        findFirst: async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      bot: {
        findUniqueOrThrow: async () => ({
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
          computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
        }),
        findMany: async () => [],
      },
      attempt: {
        create: async () => ({ id: "attempt-1" }),
        updateMany: async () => ({ count: 1 }),
      },
      thread: {
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 1,
        }),
      },
      task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in to the site" }) },
      computer: { updateMany: async () => ({ count: 1 }) },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: "openrouter",
          defaultModelId: "openai/gpt-4o",
        }),
      },
      externalEffect: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: `effect-${data.idempotencyKey}`,
          ...data,
        }),
        updateMany: async () => ({ count: 1 }),
      },
    },
    calls,
  );
  const events = {
    append: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    pauseRunForTakeover: vi.fn(async () => false),
    pauseRunForInput: vi.fn(async () => true),
  };
  const logged: unknown[] = [];
  const logger = new Proxy(
    {},
    {
      get:
        () =>
        (...args: unknown[]) =>
          logged.push(args),
    },
  ) as ReturnType<typeof Logging.getLogger>;
  vi.spyOn(Logging, "getLogger").mockReturnValue(logger);
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    secretStore: new EncryptedSecretStore("test-only-encryption-key"),
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return {
    toolResults,
    events,
    everything: JSON.stringify([calls, events, logged, toolResults], (_key, value) =>
      typeof value === "function" && "mock" in value ? value.mock.calls : value,
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request_secret with a page URL", () => {
  it("asks for the login under the page's site and records nothing else from the URL", async () => {
    const { toolResults, everything } = await requestSecretWith(PAGE_URL);
    // The card is open and waiting, for the page's site only.
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
    expect(everything).toContain(
      '"credential":{"name":"site_login","origin":"https://www.example.test","auth":{"type":"login"}}',
    );
    for (const canary of CANARIES) expect(everything).not.toContain(canary);
  });

  it("turns down a page URL on another scheme without repeating it", async () => {
    const { toolResults, everything } = await requestSecretWith(
      `blob:https://www.example.test/${CANARIES[2]}?q=${CANARIES[3]}`,
    );
    expect(JSON.stringify(toolResults)).toMatch(/Invalid credential destination — origin:/);
    for (const canary of CANARIES) expect(everything).not.toContain(canary);
  });
});

describe("request_secret for a login's fields", () => {
  it("asks for the named fields and never lets the bot choose which are visible", async () => {
    const { toolResults, events, everything } = await requestSecretWith(
      "https://bank.example.test",
      {
        fields: [{ label: "ID number", hidden: false }, "Phone number"],
      },
    );
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
    expect(events.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [expect.objectContaining({ loginFields: ["ID number", "Phone number"] })],
      }),
    );
    expect(everything).not.toContain('"hidden"');
  });

  it("turns down fields it can't ask for", async () => {
    const { toolResults, events } = await requestSecretWith("https://bank.example.test", {
      fields: ["Code", "code"],
    });
    expect(JSON.stringify(toolResults)).toContain("fields must list 1 to 8 different labels");
    expect(events.pauseRunForInput).not.toHaveBeenCalled();
  });
});
