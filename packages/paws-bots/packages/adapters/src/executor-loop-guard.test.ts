import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { isLoopGuardStopText, MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS } from "./tool-loop.js";

const provisionComputer = vi.hoisted(() => vi.fn());

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const REFUSAL =
  "computer_act accepts at most 24 actions but got 30; none ran. Send the first 24 or fewer now, then the rest in a separate call.";
// Past this many requests the fake model gives up, so a missing guard fails the test instead of hanging it.
const REQUEST_CAP = 40;
const REPORT = { path: "downloads/report.csv", kind: "file", size: 1024 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(() => {
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue({
    id: "sandbox-1",
    botId: "home-1",
    kind: "e2b",
    providerRef: "sandbox-1",
  });
});

/** Coordinates change on every request, so the identical-input guards never see a repeat. */
function clickBatch(size: number, request: number, vary = true) {
  return {
    actions: Array.from({ length: size }, (_, index) => ({
      kind: "click",
      x: 100 + (vary ? request * 7 : 0) + index,
      y: 200 + (vary ? request * 3 : 0) + index * 2,
    })),
  };
}

function toolResultTexts(messages: Array<Record<string, unknown>>): string[] {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
}

type Answer = { text?: string; calls?: Array<{ name: string; args: object }> };

/**
 * One real executor turn: real PiAgentRuntime and run loop against a fake OpenAI-compatible
 * server that gives `answer(request)` for each request; an answer without calls ends the turn.
 * `listing(call)` gives what each listing of `downloads` finds; by default one unchanged file.
 */
async function runLoop(
  answer: (request: number) => Answer,
  { listing = (_call: number) => [REPORT], learning = false, finalized = true } = {},
) {
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "example-model");
  vi.stubEnv("RAKAZO_LOCAL_VISION_MODELS", "example-model");
  vi.stubEnv("RAKAZO_LOCAL_CONTEXT_WINDOW", "120000");
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const n = requests.length;
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: `fixture-${n}`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const { text, calls = [] } = n > REQUEST_CAP ? { text: "Cap reached" } : answer(n);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls.length === 0) {
        response.end(
          `${chunk({ role: "assistant", content: text ?? "Done." }, "stop")}data: [DONE]\n\n`,
        );
        return;
      }
      response.end(
        (text ? chunk({ role: "assistant", content: text }) : "") +
          chunk({
            role: "assistant",
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call-${n}-${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", `http://127.0.0.1:${address.port}/v1`);
  vi.resetModules();
  const { PiAgentRuntime } = await import("./pi-runtime.js");
  const { createRunExecutor } = await import("./executor.js");

  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued" as string,
    trigger: "user",
    sourceMessageId: "message-1",
    routineId: null,
    retryOfRunId: null,
    leaseOwner: null as string | null,
    leaseFence: 0,
    leaseExpiresAt: null as Date | null,
    wakeAt: null as Date | null,
  };
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
    create: async () => ({}),
    upsert: async () => ({}),
    update: async () => ({}),
  };
  // The run records each computer action as an effect so a crashed one is never replayed.
  type Effect = { id: string; status: string; idempotencyKey?: string } & Record<string, unknown>;
  const effects: Effect[] = [];
  const externalEffect = {
    findMany: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      effects.filter((e) =>
        ["id", "runId", "status", "kind"].every((key) => !where[key] || e[key] === where[key]),
      ),
    findFirst: async () => null,
    findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
      effects.find((e) =>
        where.id ? e.id === where.id : e.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` } as Effect;
      effects.push(effect);
      return { ...effect };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(effects.find((e) => e.id === where.id) ?? {}, data),
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string };
      data: Record<string, unknown>;
    }) => {
      const effect = effects.find(
        (e) => e.id === where.id && (!where.status || e.status === where.status),
      );
      if (effect) Object.assign(effect, data);
      return { count: effect ? 1 : 0 };
    },
  };
  let answeredMessageIds = ["steer-1"];
  const prisma = {
    externalEffect,
    steeringMessage: {
      findMany: vi.fn(async () => answeredMessageIds.map((messageId) => ({ messageId }))),
    },
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    $transaction: async (work: unknown): Promise<unknown> =>
      typeof work === "function" ? work(proxied) : Promise.all(work as unknown[]),
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async (args?: { where?: { status?: unknown } }) =>
        args?.where?.status === "queued"
          ? null
          : { bot: { notifyOnFinish: false }, thread: { groupId: null } },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: { status?: unknown; leaseOwner?: unknown; leaseFence?: unknown };
          data: Record<string, unknown>;
        }) => {
          if (typeof where?.status === "string" && where.status !== run.status) return { count: 0 };
          if (typeof where?.leaseOwner === "string" && where.leaseOwner !== run.leaseOwner)
            return { count: 0 };
          if (typeof where?.leaseFence === "number" && where.leaseFence !== run.leaseFence)
            return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: "local",
        modelId: "example-model",
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        botId: run.botId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 2,
      })),
    },
    message: {
      findMany: vi.fn(async () => [
        {
          id: "message-1",
          role: "user",
          runId: run.id,
          seq: 1,
          blocks: [{ kind: "text", text: "Click through the form" }],
          steeringMessages: [],
        },
      ]),
      findUnique: vi.fn(async () => ({
        clientNonce: null,
        role: "user",
        blocks: [{ kind: "text", text: "Click through the form" }],
        threadId: run.threadId,
      })),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Click through the form" })),
    },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "local",
        defaultModelId: "example-model",
      })),
    },
  };
  // Models and methods the run touches but this test does not care about behave as empty tables.
  const table = (model: object) =>
    new Proxy(model, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : emptyMethod(key)),
    });
  const emptyMethod = (key: string | symbol) =>
    empty[key as keyof typeof empty] ?? (async () => ({}));
  const proxied: object = new Proxy(prisma, {
    get: (target, key) =>
      typeof key === "string" && key.startsWith("$") && !(key in target)
        ? async () => []
        : table(key in target ? target[key as keyof typeof target] : empty),
  });
  const act = vi.fn(async (_computer: unknown, request: { actions: unknown[] }) => ({
    completed: request.actions.length,
  }));
  let listings = 0;
  const listFiles = vi.fn(async (_computer: unknown, path: string) =>
    path.endsWith("downloads") ? listing(++listings) : [],
  );
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
    act,
    listFiles,
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      yield* [];
    }),
  };
  const finalizeRun = vi.fn(async () => {
    answeredMessageIds = [];
    return finalized ? { continuationRunId: null } : false;
  });
  const enqueue = vi.fn(async () => undefined);
  const events = {
    append: vi.fn(async () => undefined),
    claimSteering: vi.fn(async () => []),
    notify: vi.fn(async () => undefined),
    finalizeRun,
    pauseRunForTakeover: vi.fn(async () => false),
  };
  const executor = createRunExecutor({
    prisma: proxied,
    deploymentModelKey: "fake-deployment-key",
    runtime: new PiAgentRuntime(),
    sandbox,
    // A real save takes a while, and the model must not keep going while it runs.
    home: { commit: vi.fn(() => delay(200, "fixture-revision")) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () =>
        learning
          ? {
              defaultScope: "isolated",
              provider: {
                describe: () => ({ id: "fixture", capabilities: {} }),
                retainConversation: async () => undefined,
              },
            }
          : null,
    },
    artifacts: { get: vi.fn(async () => new Uint8Array()) },
    events,
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
    // Ends the run if the guard is missing, instead of letting the fake server answer forever.
    shutdownSignal: AbortSignal.timeout(20_000),
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  try {
    await executor.continueRun(run.id, "worker-1");
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
  const finalBlocks = (
    finalizeRun.mock.calls as unknown as Array<[{ blocks?: unknown[] }]>
  ).flatMap(([call]) => call.blocks ?? []);
  const finalText = finalBlocks
    .map((block) => (block as { kind: string; text?: string }).text ?? "")
    .join("");
  return { requests, act, finalizeRun, finalText, enqueue };
}

/** Every answer is a computer_act call. `sizes` gives the batch size per request; the last repeats. */
const runWithBatches = (sizes: number[], vary = true) =>
  runLoop((n) => ({
    calls: [
      {
        name: "computer_act",
        args: clickBatch(sizes[Math.min(n - 1, sizes.length - 1)]!, n, vary),
      },
    ],
  }));

const LISTING = { name: "list_files", args: { path: "downloads" } };
const unreadable = () => {
  throw new Error("permission denied");
};

function expectStoppedAt(calls: number, run: { requests: unknown[]; finalText: string }) {
  // The stop lands while the runtime may already be sending the next request.
  expect(run.requests.length).toBeGreaterThanOrEqual(calls);
  expect(run.requests.length).toBeLessThanOrEqual(calls + 1);
  expect(run.finalText).toMatch(
    new RegExp(`^I got stuck calling List files with the same input ${calls} times`),
  );
  expect(isLoopGuardStopText(run.finalText)).toBe(true);
}

describe("over-limit computer_act batches through the run loop", () => {
  it.each([true, false])(
    "retains a loop-stopped turn only after successful finalization (%s)",
    async (finalized) => {
      const { enqueue, finalizeRun } = await runLoop(
        (n) => ({ calls: [{ name: "computer_act", args: clickBatch(30, n) }] }),
        { learning: true, finalized },
      );
      expect(finalizeRun).toHaveBeenCalledTimes(1);
      const job = expect.objectContaining({
        name: "memory.retain-turn",
        payload: { runId: "run-1", messageIds: ["steer-1"] },
      });
      if (finalized) expect(enqueue).toHaveBeenCalledWith(job);
      else
        expect(enqueue).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: "memory.retain-turn" }),
        );
    },
    30_000,
  );

  it("ends the run after four refused batches in a row", async () => {
    const { requests, act, finalizeRun, finalText, enqueue } = await runWithBatches([30]);

    expect(requests).toHaveLength(MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS);
    expect(act).not.toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory.retain-turn" }),
    );
    expect(finalText).toMatch(
      /^I got stuck calling Computer act with too many actions 4 times in a row without making progress, so I stopped early\./,
    );
    expect(isLoopGuardStopText(finalText)).toBe(true);
    for (const request of requests.slice(1)) {
      expect(toolResultTexts(request.messages).at(-1)).toContain(REFUSAL);
    }
    expect(toolResultTexts(requests[3]!.messages)).toHaveLength(3);
  }, 30_000);

  it("starts the count over after a batch within the limit", async () => {
    // over, over, in-limit, then over until the run is stopped.
    const { requests, act, finalText } = await runWithBatches([30, 30, 24, 30]);

    // Not stopped by the first two, nor by the three after the reset: the fourth ends it, and no
    // more requests go out while the executed batch is saved. The stop lands while the runtime
    // may already be sending the next request.
    const stoppedAt = 2 + 1 + MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS;
    expect(requests.length).toBeGreaterThanOrEqual(stoppedAt);
    expect(requests.length).toBeLessThanOrEqual(stoppedAt + 1);
    expect(act).toHaveBeenCalledTimes(1);
    expect(act.mock.calls[0]![1].actions).toHaveLength(24);
    expect(finalText).toContain("with too many actions 4 times in a row");
    expect(isLoopGuardStopText(finalText)).toBe(true);
  }, 30_000);

  it("ends an identical refused batch at the fourth, before the same-input guard", async () => {
    const { requests, act, finalText } = await runWithBatches([30], false);

    expect(requests).toHaveLength(MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS);
    expect(act).not.toHaveBeenCalled();
    expect(finalText).toContain("with too many actions 4 times in a row");
    expect(finalText).not.toContain("the same input");
  }, 30_000);
});

describe("repeated identical tool calls through the run loop", () => {
  it("ends the run at the sixth call that fails the same way", async () => {
    expectStoppedAt(6, await runLoop(() => ({ calls: [LISTING] }), { listing: unreadable }));
  }, 30_000);

  it("lets the bot wait on an unchanged answer until it changes", async () => {
    const { requests, finalText } = await runLoop(
      (n) => (n <= 9 ? { calls: [LISTING] } : { text: "The report is ready." }),
      { listing: (call) => (call <= 8 ? [] : [REPORT]) },
    );

    expect(requests).toHaveLength(10);
    expect(finalText).toBe("The report is ready.");
  }, 30_000);

  it("ends an unchanged answer at the 25th call, not the sixth", async () => {
    expectStoppedAt(25, await runLoop(() => ({ calls: [LISTING] })));
  }, 30_000);

  it("keeps polling while the result changes", async () => {
    const { requests, finalText } = await runLoop(() => ({ calls: [LISTING] }), {
      listing: (call) => [{ ...REPORT, size: call * 1024 }],
    });

    expect(requests).toHaveLength(REQUEST_CAP + 1);
    expect(isLoopGuardStopText(finalText)).toBe(false);
  }, 30_000);

  it("keeps going when the model writes before each repeat", async () => {
    const { requests, finalText } = await runLoop(
      () => ({ text: "Checking the download again.", calls: [LISTING] }),
      { listing: unreadable },
    );

    expect(requests).toHaveLength(REQUEST_CAP + 1);
    expect(isLoopGuardStopText(finalText)).toBe(false);
  }, 30_000);

  it("counts identical calls in one answer once", async () => {
    const batch = await runLoop((n) => (n === 1 ? { calls: Array(6).fill(LISTING) } : {}), {
      listing: unreadable,
    });
    expect(batch.requests).toHaveLength(2);
    expect(batch.finalText).toBe("Done.");

    expectStoppedAt(
      6,
      await runLoop(() => ({ calls: [LISTING, LISTING] }), { listing: unreadable }),
    );
  }, 30_000);
});
