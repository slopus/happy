import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { runWithLogContext } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MISSING_TOOL_FINAL_RESPONSE_ERROR, PiAgentRuntime } from "./pi-runtime.js";
import {
  recordPiTelemetryContent,
  shutdownPiTelemetry,
  withPiTelemetry,
  withPiTelemetrySpan,
} from "./pi-telemetry.js";
import { otelPiContext } from "./pi-telemetry-otel.js";
import { observedPiStream } from "./pi-usage.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("./pi-telemetry-otel.js", async (original) => ({
  ...(await original()),
  createPiTelemetryExporter: factory,
}));

const ids = { botId: "bot-fixture", runId: "run-fixture", routineId: "routine-fixture" };
function setup(captureContent = false) {
  const output = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: output })],
  });
  factory.mockReturnValue({
    context: otelPiContext(provider.getTracer("fixture"), captureContent),
    shutdown: () => provider.shutdown(),
  });
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example.test:4318");
  return { output, provider };
}

afterEach(async () => {
  await shutdownPiTelemetry();
  vi.unstubAllEnvs();
  factory.mockReset();
  vi.restoreAllMocks();
});

describe("Pi OpenTelemetry", () => {
  it("continues the request/job trace instead of starting an unrelated trace", async () => {
    const { output, provider } = setup();
    await runWithLogContext({ "trace.id": "a".repeat(32), "span.id": "b".repeat(16) }, () =>
      withPiTelemetry(ids, async () => undefined),
    );
    await provider.forceFlush();
    const [span] = output.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe("a".repeat(32));
    expect(span?.parentSpanContext?.spanId).toBe("b".repeat(16));
  });

  it.each([undefined, "", "  "])(
    "does not initialize or create spans with endpoint %j",
    async (endpoint) => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      vi.stubEnv("OTEL_CAPTURE_CONTENT", "true");
      expect(
        await withPiTelemetry(ids, () =>
          withPiTelemetrySpan("pi.ai.request", {}, async (span) => {
            expect(span).toBeUndefined();
            return "unchanged";
          }),
        ),
      ).toBe("unchanged");
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("isolates concurrent runs, inherits ids and maps tokens and tool outcomes", async () => {
    const { output, provider } = setup();
    await Promise.all(
      ["first", "second"].map((runId) =>
        withPiTelemetry({ ...ids, runId }, () =>
          withPiTelemetrySpan("pi.agent.tool", { "pi.agent.tool.name": "helper" }, async (tool) => {
            await Promise.resolve();
            await withPiTelemetrySpan(
              "pi.ai.request",
              { "pi.ai.model": "fixture" },
              async (model) => {
                model?.setAttributes({
                  "pi.ai.usage.input_tokens": 12,
                  "pi.ai.usage.output_tokens": 3,
                });
              },
            );
            tool?.setAttributes({ "pi.agent.tool.success": true });
          }),
        ),
      ),
    );
    await provider.forceFlush();
    const spans = output.getFinishedSpans();
    expect(spans).toHaveLength(6);
    for (const runId of ["first", "second"]) {
      const run = spans.find(
        (s) => s.name === "rakazo.agent.run" && s.attributes["rakazo.run.id"] === runId,
      )!;
      const children = spans.filter(
        (s) => s.name !== run.name && s.attributes["rakazo.run.id"] === runId,
      );
      expect(children).toHaveLength(2);
      for (const span of children) {
        expect(span.spanContext().traceId).toBe(run.spanContext().traceId);
        expect(span.attributes).toMatchObject({
          "rakazo.bot.id": ids.botId,
          "rakazo.routine.id": ids.routineId,
        });
      }
      const tool = children.find((s) => s.name === "pi.agent.tool")!;
      const model = children.find((s) => s.name === "pi.ai.request")!;
      expect(model.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
      expect(model.attributes).toMatchObject({
        "pi.ai.usage.input_tokens": 12,
        "pi.ai.usage.output_tokens": 3,
      });
      expect(tool.attributes["pi.agent.tool.success"]).toBe(true);
    }
  });

  it.each([false, true])("filters content and unknown metadata (capture=%s)", async (capture) => {
    const { output, provider } = setup(capture);
    vi.stubEnv("OTEL_CAPTURE_CONTENT", String(capture));
    await withPiTelemetry(ids, () =>
      withPiTelemetrySpan(
        "pi.ai.request",
        {
          "pi.ai.prompt": "private prompt",
          authorization: "fake-private-key",
        },
        async (span) => {
          span?.setAttributes({
            "pi.ai.response": "private response",
            "pi.agent.tool.arguments": "private args",
          });
          span?.addEvent("fixture", {
            "pi.agent.tool.result": "private result",
            "unknown.content": "private",
          });
          recordPiTelemetryContent(span, "pi.ai.response", "private response");
          const circular: { self?: unknown } = {};
          circular.self = circular;
          expect(() =>
            recordPiTelemetryContent(span, "pi.agent.tool.result", circular),
          ).not.toThrow();
        },
      ),
    );
    await provider.forceFlush();
    const span = output.getFinishedSpans()[0]!;
    expect(span.attributes.authorization).toBeUndefined();
    expect(span.attributes["pi.ai.prompt"]).toBe(capture ? "private prompt" : undefined);
    expect(span.attributes["pi.ai.response"]).toBe(capture ? '"private response"' : undefined);
    expect(span.attributes["pi.agent.tool.arguments"]).toBe(capture ? "private args" : undefined);
    expect(span.events[0]?.attributes).toEqual(
      capture ? { "pi.agent.tool.result": "private result" } : {},
    );
  });

  it("marks failures without exporting exception content and preserves the exception", async () => {
    const { output, provider } = setup();
    const error = new Error("private error with fake credential");
    await expect(
      withPiTelemetry(ids, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await provider.forceFlush();
    const span = output.getFinishedSpans()[0]!;
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span.events).toEqual([]);
    expect(JSON.stringify(span.attributes)).not.toContain(error.message);
  });

  it("keeps runs working when optional SDK initialization fails", async () => {
    setup();
    factory.mockImplementation(() => {
      throw new Error("invalid exporter config");
    });
    expect(await withPiTelemetry(ids, async () => "done")).toBe("done");
  });

  it("maps a real Pi model stream's usage without exporting prompt or response", async () => {
    const { output, provider } = setup();
    const model: Model<Api> = {
      provider: "openrouter",
      id: "fixture",
      api: "openai-completions",
      name: "fixture",
      baseUrl: "https://model.example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    };
    await withPiTelemetry(ids, async () => {
      const stream = observedPiStream(
        builtinModels(),
        model,
        { messages: [{ role: "user", content: "private prompt", timestamp: 1 }] },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(
              `${[
                {
                  choices: [
                    { index: 0, delta: { content: "private response" }, finish_reason: null },
                  ],
                },
                {
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                },
              ]
                .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
                .join("")}data: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        },
        () => {},
      );
      for await (const _event of stream) {
        /* Consume synthetic SSE through Pi. */
      }
    });
    await provider.forceFlush();
    const span = output.getFinishedSpans().find((s) => s.name === "pi.ai.request")!;
    expect(span.attributes).toMatchObject({
      "pi.ai.model": "fixture",
      "pi.ai.usage.input_tokens": 10,
      "pi.ai.usage.output_tokens": 2,
      "pi.ai.usage.total_tokens": 12,
    });
    expect(JSON.stringify(span.attributes)).not.toMatch(/private|fake-fixture-key/);
  });
  it.each(["provider", "missing final answer"])("marks caught %s run failures", async (failure) => {
    const { output, provider } = setup();
    const server = createServer(async (request, response) => {
      // A local tool can probe any listening loopback port; only model calls are counted.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      for await (const _chunk of request) {
        /* Drain request body. */
      }
      if (failure === "provider") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "private provider failure" } }));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      const delta =
        calls++ === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "fixture-call",
                  type: "function",
                  function: {
                    name: "fixture_tool",
                    arguments: "{}",
                  },
                },
              ],
            }
          : {};
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    let calls = 0;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const runtime = new PiAgentRuntime();
      const consume = async () => {
        for await (const _event of runtime.run({
          ...ids,
          threadId: "thread-fixture",
          prompt: "private prompt",
          instructions: "fixture",
          history: [],
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            allowPrivateEndpoint: true,
            apiKey: "fake-fixture-key",
            maxTokens: 256,
            contextWindow: 4096,
          },
          tools: [
            {
              name: "fixture_tool",
              description: "fixture",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          executeTool: async () => ({ result: "done" }),
        })) {
          /* Consume the queue, including its failure. */
        }
      };
      await expect(consume()).rejects.toThrow(
        failure === "provider" ? "private provider failure" : MISSING_TOOL_FINAL_RESPONSE_ERROR,
      );
      await provider.forceFlush();
      const run = output.getFinishedSpans().find((span) => span.name === "rakazo.agent.run")!;
      expect(run.status.code).toBe(SpanStatusCode.ERROR);
      expect(run.events).toEqual([]);
      expect(JSON.stringify(run.attributes)).not.toContain("private");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    { capture: false, details: { error: "private tool failure" }, failed: true },
    { capture: true, details: { error: "private tool failure" }, failed: true },
    { capture: false, details: { isError: true }, failed: true },
    { capture: false, details: { error: "" }, failed: true },
    { capture: false, details: { error: false }, failed: true },
    { capture: false, details: { error: null, isError: false }, failed: false },
  ])("exports real Agent model/tool steps with %j", async ({ capture, details, failed }) => {
    const { output, provider } = setup(capture);
    vi.stubEnv("OTEL_CAPTURE_CONTENT", String(capture));
    let calls = 0;
    const server = createServer(async (request, response) => {
      // A local tool can probe any listening loopback port; only model calls are counted.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      for await (const _chunk of request) {
        /* Drain request body. */
      }
      response.setHeader("content-type", "text/event-stream");
      calls += 1;
      const delta =
        calls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "fixture-call",
                  type: "function",
                  function: {
                    name: "fixture_tool",
                    arguments: JSON.stringify({ query: "private args" }),
                  },
                },
              ],
            }
          : { content: "private response" };
      response.end(
        `${[
          { id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("")}data: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const executeTool = vi.fn(async () => ({
        kind: "agent_tool_result" as const,
        content: [{ type: "text" as const, text: "private result" }],
        details,
      }));
      const runtime = new PiAgentRuntime();
      for await (const _event of runtime.run({
        ...ids,
        threadId: "thread-fixture",
        prompt: "private prompt",
        instructions: "fixture",
        history: [],
        model: {
          provider: "openai-compatible",
          id: "fixture",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          allowPrivateEndpoint: true,
          apiKey: "fake-fixture-key",
          maxTokens: 256,
          contextWindow: 4096,
        },
        tools: [
          {
            name: "fixture_tool",
            description: "fixture",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        executeTool,
      })) {
        /* Exercise real Pi Agent model and tool lifecycle. */
      }
      await provider.forceFlush();
      expect(executeTool).toHaveBeenCalledOnce();
      const spans = output.getFinishedSpans();
      expect(spans.filter((span) => span.name === "pi.ai.request")).toHaveLength(2);
      const tool = spans.find((span) => span.name === "pi.agent.tool")!;
      expect(tool.attributes).toMatchObject({
        "rakazo.bot.id": ids.botId,
        "rakazo.run.id": ids.runId,
        "rakazo.routine.id": ids.routineId,
        "pi.agent.tool.name": "fixture_tool",
        "pi.agent.tool.success": !failed,
      });
      expect(tool.status.code).toBe(failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
      const data = JSON.stringify(spans.map((span) => span.attributes));
      expect(data).not.toContain("fake-fixture-key");
      if (capture) {
        for (const content of [
          "private prompt",
          "private response",
          "private args",
          "private result",
        ])
          expect(data).toContain(content);
      } else expect(data).not.toContain("private");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
