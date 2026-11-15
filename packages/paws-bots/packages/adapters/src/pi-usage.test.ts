import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRuntimeEvent, AgentUsage } from "@rakazo/adapter-kit";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { estimateTextTokens, lowTextTokens } from "./context-selection.js";
import {
  createOpenAiCompatibleFetch,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { normalizePiUsage, observedPiStream, usageReportingFetch } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "openrouter",
  id: "fixture",
  api: "openai-completions",
  name: "fixture",
  baseUrl: "https://model.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};
const sse = (usage?: object) =>
  `${[
    {
      id: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }],
    },
    { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ id: "test", choices: [], usage }] : []),
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("")}data: [DONE]\n\n`;

async function run(usage?: object) {
  const events: AgentRuntimeEvent[] = [];
  const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
  const afterCall = vi.fn();
  const stream = await observedPiStream(
    builtinModels(),
    model,
    { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
    {
      apiKey: "fake-fixture-key",
      fetch: async () =>
        new Response(sse(usage), { headers: { "content-type": "text/event-stream" } }),
    },
    (event) => events.push(event),
    { beforeCall, afterCall },
  );
  for await (const _event of stream) {
    /* Real Pi provider parser consumes synthetic endpoint. */
  }
  return { events, beforeCall, afterCall, result: await stream.result() };
}

describe("Pi usage accounting", () => {
  it.each([false, true])(
    "acknowledges a producer sink only after successful accounting (fails=%s)",
    async (fails) => {
      const sink = vi.fn(async () => {
        if (fails) throw new Error("Synthetic ledger unavailable");
      });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        undefined,
        { recordUsage: sink },
      );
      for await (const _event of stream) {
      }
      expect(sink).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 2 });
      expect(events[0]?.type === "usage" ? events[0].accounted : undefined).toBe(
        fails ? undefined : true,
      );
    },
  );
  it.each([
    { kind: "answer", afterUser: false, expected: "retrieval" },
    { kind: "answer", afterUser: true, expected: "answer" },
    { kind: "subagent", afterUser: false, expected: "subagent" },
    { kind: "setup", afterUser: false, expected: "setup" },
  ] as const)(
    "attributes history-result consumption to $expected while preserving $kind precedence",
    async ({ kind, afterUser, expected }) => {
      const messages: Context["messages"] = [
        {
          role: "toolResult",
          toolCallId: "history-call",
          toolName: "search_history",
          content: [{ type: "text", text: "Synthetic history" }],
          isError: false,
          timestamp: 1,
        },
      ];
      if (afterUser) messages.push({ role: "user", content: "New task", timestamp: 2 });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        { operationKind: kind },
      );
      for await (const _event of stream) {
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operationKind: expected, totalTokens: 12 });
    },
  );
  it("attributes a model call requesting history to retrieval without duplicating its usage", async () => {
    const reply = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "history-call", type: "function", function: { name: "read_history", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`;
    const events: AgentRuntimeEvent[] = [];
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () =>
          new Response(reply, { headers: { "content-type": "text/event-stream" } }),
      },
      (event) => events.push(event),
    );
    for await (const _event of stream) {
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operationKind: "retrieval", totalTokens: 12 });
  });
  it("accounts a cancelled model call even when the event consumer closes before usage arrives", async () => {
    const onUsage = vi.fn();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Pending" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } } })}\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const stream = new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture-cancelled",
          prompt: "Test",
          instructions: "Fixture",
          history: [],
          tools: [],
          onUsage,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            allowPrivateEndpoint: true,
          },
        },
        { signal: AbortSignal.timeout(15000) },
      );
      expect((await stream.next()).value).toMatchObject({ type: "text" });
      await stream.return!();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
        inputTokens: 60,
        outputTokens: 30,
        cacheReadTokens: 40,
        reasoningTokens: 10,
        totalTokens: 130,
        callId: expect.any(String),
      });
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30000);
  it("persists a generation id before exposing the first SSE chunk", async () => {
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRequestId = vi.fn(async () => {
      entered();
      await durable;
    });
    const fields = new Set<keyof AgentUsage>();
    const wrapped = usageReportingFetch(
      async () =>
        new Response('data: {"id":"gen_fixture","choices":[]}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      fields,
      onRequestId,
    );
    const response = await wrapped("https://example.test");
    let exposed = false;
    const read = response.text().then((text) => {
      exposed = true;
      return text;
    });
    await waiting;
    expect(exposed).toBe(false);
    release();
    await read;
    expect(onRequestId).toHaveBeenCalledWith("gen_fixture");
    expect(normalizePiUsage(undefined, model, fields).providerRequestId).toBe("gen_fixture");
  });
  it("keeps OpenRouter's generation id over the upstream message id in an Anthropic-format stream", async () => {
    const onRequestId = vi.fn();
    const fields = new Set<keyof AgentUsage>();
    const wrapped = usageReportingFetch(
      async () =>
        new Response(
          'data: {"type":"message_start","message":{"id":"msg_fixture","usage":{"input_tokens":1}}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "x-generation-id": "gen-1-fixture",
            },
          },
        ),
      fields,
      onRequestId,
    );
    await (await wrapped("https://openrouter.ai/api/v1/messages")).text();
    expect(onRequestId.mock.calls).toEqual([["gen-1-fixture"]]);
    expect(normalizePiUsage(undefined, model, fields).providerRequestId).toBe("gen-1-fixture");
  });
  it.each([
    [{ upstream_inference_cost: 0.0042 }, 0.0042, "provider-reported"],
    [{ upstream_inference_cost: null }, null, null],
  ] as const)(
    "adds the upstream inference cost of a bring-your-own-key generation (%j)",
    async (costDetails, costUsd, costSource) => {
      const fields = new Set<keyof AgentUsage>();
      const wrapped = usageReportingFetch(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              type: "message_delta",
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                cost: 0,
                is_byok: true,
                cost_details: costDetails,
              },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        fields,
      );
      await (await wrapped("https://openrouter.ai/api/v1/messages")).text();
      expect(normalizePiUsage(undefined, model, fields)).toMatchObject({ costUsd, costSource });
    },
  );
  it("retains a provider cost receipt when a stream throws after reporting it", async () => {
    const afterCall = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    const models = {
      streamSimple: (_model: unknown, _context: unknown, options: { fetch: typeof fetch }) => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const response = await options.fetch("https://model.example.test/v1");
              await response.text();
              throw new Error("Synthetic interrupted stream");
            },
          };
        },
      }),
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(
      models,
      model,
      { messages: [] },
      {
        fetch: async () =>
          new Response('data: {"id":"gen_fixture","usage":{"cost":0.125},"choices":[]}\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
      },
      (event) => events.push(event),
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).stopReason).toBe("error");
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        costUsd: 0.125,
        costSource: "provider-reported",
        providerRequestId: "gen_fixture",
      }),
    );
    expect(events[0]).toMatchObject({ costUsd: 0.125, costSource: "provider-reported" });
  });

  it("settles a thrown provider call before exposing the terminal event", async () => {
    let finishSettlement = () => {};
    const settlement = new Promise<void>((resolve) => {
      finishSettlement = resolve;
    });
    const afterCall = vi.fn(async (_reservation: string, _usage: AgentUsage | null) => settlement);
    const models = {
      streamSimple: () => {
        throw new Error("Synthetic provider exception");
      },
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(models, model, { messages: [] }, undefined, vi.fn(), {
      beforeCall: () => "reservation",
      afterCall,
    });
    let terminalSeen = false;
    const next = stream[Symbol.asyncIterator]()
      .next()
      .then((event) => {
        terminalSeen = true;
        return event;
      });
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(terminalSeen).toBe(false);
    finishSettlement();
    expect((await next).value).toMatchObject({ type: "error" });
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
    );
    expect(afterCall.mock.calls[0]?.[1]).not.toHaveProperty("countedTokens");
  });
  it.each([
    ["the call is aborted", true],
    ["the provider drops it", false],
  ])("keeps our own token count when %s before usage arrives", async (_case, aborted) => {
    const controller = new AbortController();
    const afterCall = vi.fn();
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const answer = "x".repeat(52);
    const frame = {
      id: "gen_partial",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
    };
    let drop = () => {};
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
      {
        apiKey: "fake-fixture-key",
        signal: controller.signal,
        fetch: async (_input, init) =>
          new Response(
            new ReadableStream({
              start(body) {
                body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
                drop = () => body.error(new Error("connection reset"));
                init?.signal?.addEventListener("abort", drop);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
      vi.fn(),
      { beforeCall, afterCall },
    );
    for await (const event of stream)
      if (event.type === "text_delta") aborted ? controller.abort() : drop();
    const inputTokens = beforeCall.mock.calls[0]![0].inputTokensEstimate;
    expect(afterCall).toHaveBeenCalledOnce();
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        providerRequestId: "gen_partial",
        costUsd: null,
        countedTokens: {
          inputTokens,
          outputTokens: 10,
          ...(aborted
            ? { ifStopped: { inputTokens, outputTokens: estimateTextTokens(answer) } }
            : {}),
        },
      }),
    );
  });
  it("counts the streamed answer when the terminal error carries no content", async () => {
    const afterCall = vi.fn();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const message = (text: string) => ({
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      usage,
      stopReason: "error",
    });
    const events = [
      { type: "text_delta", delta: "x".repeat(50), partial: message("x".repeat(50)) },
      { type: "error", reason: "error", error: message("") },
    ];
    const models = {
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        result: async () => message(""),
      }),
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(models, model, { messages: [] }, undefined, vi.fn(), {
      beforeCall: () => "reservation",
      afterCall,
    });
    for await (const _event of stream) {
    }
    expect(afterCall.mock.calls[0]?.[1]).toMatchObject({
      countedTokens: { outputTokens: lowTextTokens("x".repeat(50)) },
    });
  });
  it("does not count a call whose provider refused to start it", async () => {
    const afterCall = vi.fn();
    const models = {
      streamSimple: () => {
        throw new Error("Synthetic missing credentials");
      },
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(
      models,
      { ...model, provider: "google", api: "google-generative-ai" },
      { messages: [] },
      undefined,
      vi.fn(),
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect(afterCall.mock.calls[0]?.[1]).not.toHaveProperty("countedTokens");
  });
  it("does not count a request that failed to connect", async () => {
    const afterCall = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
      vi.fn(),
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect(afterCall).toHaveBeenCalledOnce();
    expect(afterCall.mock.calls[0]?.[1]).not.toHaveProperty("countedTokens");
  });
  it("counts the prompt of a call stopped after sending but before any response", async () => {
    const controller = new AbortController();
    const afterCall = vi.fn();
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
      {
        apiKey: "fake-fixture-key",
        signal: controller.signal,
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            controller.abort();
          }),
      },
      vi.fn(),
      { beforeCall, afterCall },
    );
    for await (const _event of stream) {
    }
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        providerRequestId: null,
        costUsd: null,
        countedTokens: {
          inputTokens: beforeCall.mock.calls[0]![0].inputTokensEstimate,
          outputTokens: 0,
          ifStopped: {
            inputTokens: beforeCall.mock.calls[0]![0].inputTokensEstimate,
            outputTokens: 0,
          },
        },
      }),
    );
  });
  it("does not derive an unsafe integer total from valid component counts", () => {
    expect(
      normalizePiUsage(
        {
          input: Number.MAX_SAFE_INTEGER,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: Number.MAX_SAFE_INTEGER + 1,
        },
        model,
        new Set(["cacheReadTokens", "cacheWriteTokens"]),
      ).totalTokens,
    ).toBeNull();
  });
  it("keeps fractional or unsafe token counts unknown", () => {
    expect(
      normalizePiUsage({ input: 1.5, output: Number.MAX_SAFE_INTEGER + 1 }, model),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
  it.each([400, 401, 402, 403, 429])(
    "releases a rejected HTTP %s attempt without hidden retries",
    async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Synthetic rate limit", type: "rate_limit" } }),
            { status, headers: { "content-type": "application/json" } },
          ),
      );
      const afterCall = vi.fn();
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        { apiKey: "fake-fixture-key", fetch: fetcher, maxRetries: 3 },
        (event) => events.push(event),
        { beforeCall: () => "reservation", afterCall },
      );
      for await (const _event of stream) {
      }
      expect((await stream.result()).stopReason).toBe("error");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(afterCall).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(afterCall).toHaveBeenCalledWith(
        "reservation",
        expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          pricingVersion: null,
          usageSource: "provider-rejected",
        }),
      );
      expect(events[0]).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costSource: "provider-rejection",
      });
    },
  );
  it("records zero usage for a rejected call at the normalizer", async () => {
    const fields = new Set<keyof AgentUsage>();
    const wrapped = usageReportingFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: "Synthetic rejection" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      fields,
    );
    await wrapped("https://model.example.test/v1");
    // Bogus token values attached to a rejected response must lose to the
    // rejected classification; nothing is generated, so nothing was spent.
    expect(
      normalizePiUsage(
        {
          input: 12,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          cacheWrite1h: 1,
          reasoning: 4,
          totalTokens: 25,
        },
        model,
        fields,
      ),
    ).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      costSource: "provider-rejection",
      pricingVersion: null,
      usageSource: "provider-rejected",
    });
  });
  it("keeps a reported zero on a successful call instead of unknown", async () => {
    const { events } = await run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
  it.each([408, 500, 503])("retains uncertainty for HTTP %s", async (status) => {
    const afterCall = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fixture-key",
        fetch: async () => Response.json({ error: { message: "Synthetic failure" } }, { status }),
      },
      () => {},
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
    );
  });
  it("prepares context before budget reservation and provider execution", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const onUsage = vi.fn(() => {
      throw new Error("telemetry unavailable");
    });
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () =>
          new Response(sse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), {
            headers: { "content-type": "text/event-stream" },
          }),
      },
      vi.fn(),
      { beforeCall, afterCall: vi.fn() },
      undefined,
      { prepareContext: () => ({ messages: [], systemPrompt: "0".repeat(10000) }), onUsage },
    );
    for await (const _event of stream) {
    }
    expect(beforeCall.mock.calls[0]?.[0]).toMatchObject({
      inputTokensEstimate: expect.any(Number),
    });
    expect(beforeCall.mock.calls[0]?.[0]?.inputTokensEstimate).toBeGreaterThan(10000);
    expect(onUsage).toHaveBeenCalledOnce();
    expect((await stream.result()).stopReason).toBe("stop");
  });
  it("context policy rejection terminates without reserving or spending", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      { beforeCall, afterCall: vi.fn() },
      undefined,
      {
        prepareContext: () => {
          throw new Error("context exceeds budget");
        },
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("context exceeds budget");
    expect(beforeCall).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("does not count an already-aborted next turn as a model call", async () => {
    const beforeCall = vi.fn();
    const afterCall = vi.fn();
    const prepareContext = vi.fn();
    const recordUsage = vi.fn();
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { signal: AbortSignal.abort(new Error("synthetic tool stop")), fetch: fetcher },
      push,
      { beforeCall, afterCall },
      undefined,
      { prepareContext, recordUsage },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("synthetic tool stop");
    for (const callback of [beforeCall, afterCall, prepareContext, recordUsage, fetcher, push])
      expect(callback).not.toHaveBeenCalled();
  });
  it("releases a credit reservation if cancellation arrives before the provider starts", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn();
    const afterCall = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { signal: controller.signal, fetch: fetcher },
      vi.fn(),
      {
        beforeCall: () => {
          controller.abort(new Error("canceled before request"));
          return "reservation";
        },
        afterCall,
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("canceled before request");
    expect(fetcher).not.toHaveBeenCalled();
    expect(afterCall).toHaveBeenCalledWith("reservation", expect.objectContaining({ costUsd: 0 }));
  });
  it("retains reported zero through the full generic runtime and its safe hostname network adapter", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      );
    });
    server.listen(0, "localhost");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const events: AgentRuntimeEvent[] = [];
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture",
          prompt: "test",
          instructions: "fixture",
          history: [],
          tools: [],
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://localhost:${address.port}/v1`,
            allowPrivateEndpoint: true,
          },
        },
        { signal: AbortSignal.timeout(5000) },
      ))
        events.push(event);
      expect(events.find((event) => event.type === "usage")).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("preserves an injected compatible fetch, its pinned dispatcher, and raw usage", async () => {
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "fixture",
      baseUrl: "http://localhost:1234/v1",
      allowPrivate: true,
    });
    const compatible = models.getModel("openai-compatible", "fixture")!;
    const events: AgentRuntimeEvent[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: Agent }).dispatcher).toBeInstanceOf(Agent);
      expect(init?.redirect).toBe("error");
      return new Response(sse({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const stream = observedPiStream(
      models,
      compatible,
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      { fetch: fetcher },
      (event) => events.push(event),
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
    });
  });
  it.each([false, true])(
    "enforces the public gate and pinned lookup through default usage observation (allowPublic=%s)",
    async (allowPublic) => {
      const resolve = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      const safe = createOpenAiCompatibleFetch(
        usageReportingFetch(globalThis.fetch, new Set()),
        resolve,
        { allowPublic },
      );
      const request = safe("https://models.example.test/v1/chat/completions");
      if (allowPublic) {
        await expect(request).rejects.toMatchObject({
          cause: { message: "Public model server hostname resolved to a private address" },
        });
        expect(resolve).toHaveBeenCalledOnce();
      } else {
        await expect(request).rejects.toThrow();
        expect(resolve).not.toHaveBeenCalled();
      }
    },
  );
  it("keeps network protections when composing raw-usage observation", async () => {
    const fetcher = vi.fn();
    const safe = createOpenAiCompatibleFetch(usageReportingFetch(fetcher, new Set()));
    await expect(safe("http://169.254.169.254/v1/chat/completions")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves real endpoint cache and reasoning breakdown without double counting", async () => {
    const { events, afterCall, result } = await run({
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "usage",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: null,
      reasoningTokens: 10,
      totalTokens: 130,
      costSource: "pi-catalog-estimate",
    });
    expect(afterCall).toHaveBeenCalledOnce();
  });
  it("distinguishes explicit reported zero from omitted provider measurements", async () => {
    const reported = await run({
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(reported.events[0]).toMatchObject({
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
    const omitted = await run();
    expect(omitted.events[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
  it.each(["prompt_cache_hit_tokens", "cached_tokens"])(
    "recognizes cache-read alias %s with fully cached input",
    async (alias) => {
      const { events } = await run({
        prompt_tokens: 40,
        completion_tokens: 2,
        total_tokens: 42,
        [alias]: 40,
      });
      expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
    },
  );
  it("recognizes all-cache-write input and explicit zero read usage", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 40 });
  });
  it("preserves zero uncached input when all reported prompt tokens are cached", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
  });
  it("preserves provider reported dollar cost even when pricing or cache-write usage is unavailable", async () => {
    const { events } = await run({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cost: 0.00003,
    });
    expect(events[0]).toMatchObject({
      costUsd: 0.00003,
      costSource: "provider-reported",
      pricingVersion: null,
      cacheWriteTokens: null,
    });
  });
  it("keeps compatible zero pricing unknown", () => {
    expect(
      normalizePiUsage(
        {
          input: 10,
          output: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ).costUsd,
    ).toBeNull();
  });
  it("does not start model work when budget reservation fails", async () => {
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      {
        beforeCall: () => {
          throw new Error("budget exhausted");
        },
        afterCall: vi.fn(),
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("budget exhausted");
    expect(push).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains bytes and observes fragmented CRLF SSE with explicit zeros", async () => {
    const bytes = new TextEncoder().encode('data: {"usage":{"prompt_tokens":0}}\r\n\r\n');
    const reported = new Set<"inputTokens">();
    const fetcher = usageReportingFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      reported,
    );
    const response = await fetcher("https://model.example.test");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(reported.has("inputTokens")).toBe(true);
  });
  it("records reported totalTokens and request id from WebSocket provider stream events when fetch is unused", async () => {
    const codexModel: Model<Api> = {
      ...model,
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      api: "openai-codex-responses",
      cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    };
    const onRequestId = vi.fn();
    const afterCall = vi.fn();
    const callerStreamEvent = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    const terminalMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Done" }],
      api: codexModel.api,
      provider: codexModel.provider,
      model: codexModel.id,
      usage: {
        input: 2312,
        output: 410,
        cacheRead: 10112,
        cacheWrite: 0,
        reasoning: 190,
        totalTokens: 12834,
        cost: {
          input: 0.0004624,
          output: 0.000492,
          cacheRead: 0.00020224,
          cacheWrite: 0,
          total: 0.00115664,
        },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const models = {
      streamSimple: (
        streamModel: Model<Api>,
        _context: unknown,
        options?: {
          onProviderStreamEvent?: (event: unknown, eventModel: Model<Api>) => void | Promise<void>;
        },
      ) => ({
        async *[Symbol.asyncIterator]() {
          await options?.onProviderStreamEvent?.(
            { type: "response.created", response: { id: "resp_codex_ws_1" } },
            streamModel,
          );
          await options?.onProviderStreamEvent?.(
            {
              type: "response.completed",
              response: {
                id: "resp_codex_ws_1",
                status: "completed",
                usage: {
                  input_tokens: 12424,
                  input_tokens_details: { cached_tokens: 10112 },
                  output_tokens: 410,
                  output_tokens_details: { reasoning_tokens: 190 },
                  total_tokens: 12834,
                },
              },
            },
            streamModel,
          );
          yield { type: "done" as const, reason: "stop" as const, message: terminalMessage };
        },
        result: async () => terminalMessage,
      }),
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(
      models,
      codexModel,
      { messages: [] },
      { onProviderStreamEvent: callerStreamEvent },
      (event) => events.push(event),
      { beforeCall: () => "reservation", onRequestId, afterCall },
    );
    for await (const _event of stream) {
    }
    expect(onRequestId).toHaveBeenCalledWith("reservation", "resp_codex_ws_1");
    expect(callerStreamEvent).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "usage",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      providerRequestId: "resp_codex_ws_1",
      inputTokens: 2312,
      outputTokens: 410,
      cacheReadTokens: 10112,
      cacheWriteTokens: null,
      reasoningTokens: 190,
      totalTokens: 12834,
      usageSource: "provider-reported-via-pi",
    });
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        providerRequestId: "resp_codex_ws_1",
        totalTokens: 12834,
        usageSource: "provider-reported-via-pi",
      }),
    );
  });
});
