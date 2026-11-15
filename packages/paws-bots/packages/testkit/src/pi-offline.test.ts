import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import * as Core from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTextTokens } from "../../adapters/src/context-selection.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const writeTool: ConnectorTool = {
  name: "write_file",
  description: "Save a UTF-8 file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

function runRequest(
  model: AgentRunRequest["model"],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Save hello to notes.txt.",
    instructions: "Complete the requested task.",
    history: [],
    tools: [writeTool],
    model,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>, events: AgentRuntimeEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

function latestToolResult(request: ModelEmulatorRequest) {
  return request.messages.findLast((message) => message.role === "tool");
}

describe("real Pi against an offline model HTTP endpoint", () => {
  it("retries a dropped stream and an overloaded provider after tool work without replaying the effect", async () => {
    const delay = vi.spyOn(Core, "abortableDelay").mockResolvedValue(undefined);
    try {
      let retryMessages: ModelEmulatorRequest["messages"] | undefined;
      const assertRetryContext = (request: ModelEmulatorRequest) => {
        expect(latestToolResult(request)?.tool_call_id).toBe("retry-write");
        if (retryMessages) expect(request.messages).toEqual(retryMessages);
        else retryMessages = request.messages;
      };
      const server = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "retry-write",
              name: "write_file",
              arguments: { path: "notes.txt", content: "hello" },
            },
          },
          { expect: assertRetryContext, response: { type: "disconnect" } },
          {
            expect: assertRetryContext,
            response: {
              type: "error",
              status: 503,
              message: "Codex error: Our servers are currently overloaded. Please try again later.",
            },
          },
          { expect: assertRetryContext, response: { type: "text", text: "Saved." } },
        ],
      });
      cleanups.push(() => server.close());
      const executeTool = vi.fn(async () => ({ ok: true }));
      const events = await collect(
        new PiAgentRuntime({
          modelCallObserver: {
            beforeCall: async () => "fixture-reservation",
            afterCall: async () => undefined,
          },
        }).run(runRequest(server.model, { executeTool })),
      ).catch((error) => {
        server.assertComplete();
        throw error;
      });
      server.assertComplete();
      expect(server.requests).toHaveLength(4);
      expect(executeTool).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === "text")).toEqual([
        { type: "text", text: "Saved." },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Saved." });
      expect(delay.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 8_000]);
    } finally {
      delay.mockRestore();
    }
  });

  it.each([undefined, "retrieval", "snapshots", "cache-aware"] as const)(
    "bounds actual initial and tool-loop requests with %s context",
    async (contextStrategy) => {
      const decisions: Array<{ droppedMessages: number; truncatedToolResults: number }> = [];
      const assertBounded = (request: ModelEmulatorRequest) => {
        expect(estimateTextTokens(JSON.stringify(request.messages))).toBeLessThan(7168);
        expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
      };
      const server = await startModelEmulator({
        steps: [
          {
            expect: assertBounded,
            response: {
              type: "tool",
              id: "bounded-tool",
              name: "write_file",
              arguments: { path: "notes.txt", content: "hello" },
            },
          },
          {
            expect(request) {
              assertBounded(request);
              expect(latestToolResult(request)?.tool_call_id).toBe("bounded-tool");
              expect(String(latestToolResult(request)?.content)).toContain("truncated");
              expect(
                request.messages.findLast((message) => message.role === "assistant")
                  ?.tool_calls?.[0]?.id,
              ).toBe("bounded-tool");
            },
            response: { type: "text", text: "Saved." },
          },
        ],
      });
      cleanups.push(() => server.close());
      const events = await collect(
        new PiAgentRuntime({ onContextDecision: (decision) => decisions.push(decision) }).run(
          runRequest(
            { ...server.model, contextWindow: 8192, maxTokens: 1024 },
            {
              contextStrategy,
              history: Array.from({ length: 100 }, (_, index) => ({
                id: `old-${index}`,
                role: "user" as const,
                content: `Old message ${index} ${"filler ".repeat(80)}`,
              })),
              executeTool: async () => ({ original: "0".repeat(90_000) }),
            },
          ),
        ),
      ).catch((error) => {
        server.assertComplete();
        throw error;
      });
      server.assertComplete();
      expect(events.some((event) => event.type === "done")).toBe(true);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]!.droppedMessages).toBeGreaterThan(0);
      expect(decisions[1]!.truncatedToolResults).toBe(1);
    },
  );

  it("sends the same provider context for omitted and explicit retrieval when history tools are usable", async () => {
    let firstMessages: ModelEmulatorRequest["messages"] | undefined;
    let firstTools: ModelEmulatorRequest["tools"] | undefined;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            firstMessages = request.messages;
            firstTools = request.tools;
          },
          response: { type: "text", text: "Done." },
        },
        {
          expect(request) {
            expect(request.messages).toEqual(firstMessages);
            expect(request.tools).toEqual(firstTools);
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: `paired-${index}`,
      role: "user" as const,
      content: `Original ${index}: ${"bounded historical evidence ".repeat(20)}`,
    }));
    const tools = ["read_history", "search_history"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" as const, properties: {} },
    }));
    for (const contextStrategy of [undefined, "retrieval"] as const)
      await collect(
        new PiAgentRuntime().run(
          runRequest(
            { ...server.model, contextWindow: 8192, maxTokens: 1024 },
            { history, tools, executeTool: async () => ({}), contextStrategy },
          ),
        ),
      );
    server.assertComplete();
    expect(JSON.stringify(firstMessages)).not.toContain("Original 0:");
    expect(JSON.stringify(firstMessages)).toContain("Original 39:");
  });

  it("keeps fitting standalone originals under the shared default without unavailable history tools", async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: `short-${index}`,
      role: "user" as const,
      content: `Standalone original ${index}: rare-${index}`,
    }));
    const assertOriginals = (request: ModelEmulatorRequest) => {
      const wire = JSON.stringify(request.messages);
      for (const item of history) expect(wire).toContain(item.content);
      expect(wire).toContain("Save hello to notes.txt.");
      expect(wire).not.toContain("Historical navigation snapshots");
      expect(
        request.tools?.some((tool) =>
          ["read_history", "search_history"].includes(tool.function.name),
        ),
      ).toBe(false);
    };
    const server = await startModelEmulator({
      steps: [
        {
          expect: assertOriginals,
          response: {
            type: "tool",
            id: "standalone-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            assertOriginals(request);
            expect(latestToolResult(request)?.tool_call_id).toBe("standalone-write");
          },
          response: { type: "text", text: "Saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime().run(
        runRequest(
          { ...server.model, contextWindow: 8192, maxTokens: 1024 },
          { history, executeTool: async () => ({ ok: true }) },
        ),
      ),
    );
    server.assertComplete();
  });

  it.each([
    {
      name: "live request",
      overrides: { prompt: "Required user request ".repeat(2000), tools: [] },
      error: "Required context exceeds the model context budget",
    },
    {
      name: "required instructions",
      overrides: { instructions: "Required instructions ".repeat(2000), tools: [] },
      error: "This model's context window is too small. Choose another model.",
    },
    {
      name: "required tools",
      overrides: { tools: [{ ...writeTool, description: "Required tool schema ".repeat(2000) }] },
      error: "This model's context window is too small. Choose another model.",
    },
  ])(
    "rejects oversized $name before invoking the model or reserving spend",
    async ({ overrides, error }) => {
      const server = await startModelEmulator({ steps: [] });
      cleanups.push(() => server.close());
      let reservations = 0;
      const events: AgentRuntimeEvent[] = [];
      await expect(
        collect(
          new PiAgentRuntime({
            modelCallObserver: {
              beforeCall: async () => {
                reservations += 1;
                return "reserved";
              },
              afterCall: async () => undefined,
            },
          }).run(
            runRequest(
              { ...server.model, contextWindow: 4096, maxTokens: 1024 },
              {
                contextStrategy: "retrieval",
                ...overrides,
              },
            ),
          ),
          events,
        ),
      ).rejects.toThrow(error);
      server.assertComplete();
      expect(reservations).toBe(0);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(0);
    },
  );

  it("enforces the same context budget inside a delegated tool loop", async () => {
    const decisions: Array<{ agentId?: string; strategy?: string; truncatedToolResults: number }> =
      [];
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "delegate",
            name: "run_subagent",
            arguments: { name: "helper", task: "Save hello to notes.txt." },
          },
        },
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "run_subagent")).toBe(
              false,
            );
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
          },
          response: {
            type: "tool",
            id: "child-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(estimateTextTokens(JSON.stringify(request.messages))).toBeLessThan(7168);
            expect(latestToolResult(request)?.tool_call_id).toBe("child-write");
            expect(String(latestToolResult(request)?.content)).toContain("truncated");
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
          },
          response: { type: "text", text: "Saved." },
        },
        {
          expect(request) {
            expect(latestToolResult(request)?.tool_call_id).toBe("delegate");
          },
          response: { type: "text", text: "Finished." },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime({ onContextDecision: (decision) => decisions.push(decision) }).run(
        runRequest(
          { ...server.model, contextWindow: 8192, maxTokens: 1024 },
          {
            tools: [
              writeTool,
              {
                name: "run_subagent",
                description: "Delegate a task",
                inputSchema: {
                  type: "object",
                  properties: { name: { type: "string" }, task: { type: "string" } },
                  required: ["task"],
                },
              },
            ],
            executeTool: async () => ({ original: "0".repeat(63_000) }),
          },
        ),
      ),
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(decisions).toHaveLength(4);
    expect(decisions.every((decision) => decision.strategy === "retrieval")).toBe(true);
    expect(decisions.filter((decision) => decision.agentId)).toHaveLength(2);
    expect(
      decisions.some((decision) => decision.agentId && decision.truncatedToolResults === 1),
    ).toBe(true);
  });

  it("assembles fragmented tool arguments, executes the write, and sends its result back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-offline-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
    const server = await startModelEmulator({
      apiKey: "fixture-only-key",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: "Save hello to notes.txt.",
            });
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "write-1",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello\n" },
            argumentChunks: ['{"pa', 'th":"notes.', 'txt","content":"hel', "lo\\", 'n"}'],
          },
        },
        {
          expect(request) {
            expect(
              request.messages.find((message) => message.role === "assistant")?.tool_calls,
            ).toEqual([
              {
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "notes.txt", content: "hello\n" }),
                },
              },
            ]);
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "write-1" });
            expect(JSON.parse(String(latestToolResult(request)?.content))).toEqual({
              path: "notes.txt",
              bytes: 6,
            });
          },
          response: { type: "text", text: "Saved notes.txt." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          async executeTool(name, args, id) {
            calls.push({ name, args, id });
            expect(name).toBe("write_file");
            expect(args.path).toBe("notes.txt");
            await writeFile(path.join(dir, "notes.txt"), String(args.content));
            return { path: "notes.txt", bytes: Buffer.byteLength(String(args.content)) };
          },
        }),
      ),
    ).catch((error) => {
      try {
        server.assertComplete();
      } catch (fixtureError) {
        throw new AggregateError(
          [error, fixtureError],
          "Pi failed and model fixture validation also failed",
        );
      }
      throw error;
    });
    server.assertComplete();
    expect(calls).toEqual([
      {
        name: "write_file",
        args: { path: "notes.txt", content: "hello\n" },
        id: JSON.stringify(["pi-tool", "main", "write-1"]),
      },
    ]);
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("hello\n");
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved notes.txt." });
  });

  it("returns tool failure to the model and continues without claiming a successful write", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "denied-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "denied-write" });
            expect(String(latestToolResult(request)?.content)).toContain("Fixture write denied");
          },
          response: { type: "text", text: "The file could not be saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async () => {
            calls++;
            throw new Error("Fixture write denied");
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", text: "The file could not be saved." });
  });

  it("propagates a provider rejection without dispatching tools or emitting done", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "error", status: 400, message: "Fixture request rejected" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            executeTool: async () => {
              calls++;
              return {};
            },
          }),
        ),
        events,
      ),
    ).rejects.toThrow(/Fixture request rejected/);
    server.assertComplete();
    expect(calls).toBe(0);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects an interrupted SSE response without emitting successful completion", async () => {
    const server = await startModelEmulator({
      // The cut reply is continued once; a continuation that is cut too fails the run.
      steps: [
        { expect() {}, response: { type: "disconnect", text: "Working" } },
        { expect() {}, response: { type: "disconnect", text: " on it" } },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(new PiAgentRuntime().run(runRequest(server.model)), events),
    ).rejects.toThrow();
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("cancels a quiet HTTP stream and closes the provider connection", async () => {
    const opened = deferred();
    const closed = deferred();
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "hold",
            onOpen: opened.resolve,
            onClose: closed.resolve,
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const work = collect(
      new PiAgentRuntime().run(runRequest(server.model), { signal: controller.signal }),
      events,
    );
    // Attach the rejection handler before aborting to avoid an unhandled rejection.
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await closed.promise;
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("keeps two model connections and their responses isolated", async () => {
    const first = await startModelEmulator({
      modelId: "fixture-first",
      apiKey: "first-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "First connection" } }],
    });
    const second = await startModelEmulator({
      modelId: "fixture-second",
      apiKey: "second-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "Second connection" } }],
    });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const runtime = new PiAgentRuntime();
    const results = await Promise.all(
      [first, second].map((server) => collect(runtime.run(runRequest(server.model)))),
    );
    expect(results.map((events) => events.at(-1))).toEqual([
      { type: "done", text: "First connection" },
      { type: "done", text: "Second connection" },
    ]);
    first.assertComplete();
    second.assertComplete();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
