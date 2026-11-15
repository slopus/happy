import { expect, it, vi } from "vitest";
import { observedPiStream } from "../../../adapters/src/pi-usage.js";
import { SpendBudget } from "./measurement.js";

const model: Parameters<typeof observedPiStream>[1] = {
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  api: "openai-responses",
  baseUrl: "https://model.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};

it("blocks an explicitly requested Anthropic one-hour write before HTTP when its rate is missing", async () => {
  // Use the adapter's pinned SDK; testkit has no independent vendor dependency.
  const { anthropicMessagesApi } = await import(
    new URL(
      "../../../adapters/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js",
      import.meta.url,
    ).href
  );
  const budget = new SpendBudget(5, {
    source: "fixture",
    version: "v1",
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 3,
  });
  const fetcher = vi.fn();
  const events = vi.fn();
  const afterCall = vi.fn();
  const stream = await observedPiStream(
    { streamSimple: anthropicMessagesApi().streamSimple } as unknown as Parameters<
      typeof observedPiStream
    >[0],
    { ...model, api: "anthropic-messages" },
    { messages: [] },
    { apiKey: "fake-fixture-key", cacheRetention: "long", fetch: fetcher },
    events,
    {
      beforeCall: (call) =>
        budget.reserve(call.inputTokensEstimate, call.maxOutputTokens, call.cacheWriteRetention),
      afterCall,
    },
  );
  for await (const _event of stream) {
  }
  expect((await stream.result()).errorMessage).toContain("requested one-hour cache writes");
  expect(budget.reservedUsd).toBe(0);
  expect(budget.usedUsd).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(afterCall).not.toHaveBeenCalled();
  expect(events).not.toHaveBeenCalled();
});

async function anthropicUsage(cacheFields: Record<string, number> = {}, rawTotal?: number) {
  const { anthropicMessagesApi } = await import(
    new URL(
      "../../../adapters/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js",
      import.meta.url,
    ).href
  );
  const budget = new SpendBudget(5, {
    source: "fixture",
    version: "v1",
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 3,
  });
  let reserved = 0;
  let measured: Parameters<SpendBudget["settleUsage"]>[1] = null;
  const stream = await observedPiStream(
    { streamSimple: anthropicMessagesApi().streamSimple } as unknown as Parameters<
      typeof observedPiStream
    >[0],
    { ...model, api: "anthropic-messages" },
    { systemPrompt: "Fixture", messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    {
      apiKey: "fake-fixture-key",
      fetch: async () => {
        const frames = [
          {
            type: "message_start",
            message: {
              id: "fixture",
              type: "message",
              role: "assistant",
              model: "fixture",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, ...cacheFields },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
              output_tokens: 10,
              ...(rawTotal === undefined ? {} : { total_tokens: rawTotal }),
            },
          },
          { type: "message_stop" },
        ];
        return new Response(
          frames
            .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
    () => {},
    {
      beforeCall: (call) => {
        const id = budget.reserve(
          call.inputTokensEstimate,
          call.maxOutputTokens,
          call.cacheWriteRetention,
        );
        reserved = budget.reservedUsd;
        return id;
      },
      afterCall: (id, usage) => {
        measured = usage;
        budget.settleUsage(id, usage);
      },
    },
  );
  for await (const _event of stream) {
  }
  expect((await stream.result()).stopReason).not.toBe("error");
  return { measured, reserved, budget };
}

it("keeps omitted Anthropic cache measurements and synthesized totals unknown, retaining the reservation", async () => {
  const result = await anthropicUsage();
  expect(result.measured).toMatchObject({
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  });
  expect(result.budget.reservedUsd).toBe(0);
  expect(result.budget.usedUsd).toBe(result.reserved);
});

it("derives an Anthropic total when every input, output and cache bucket is measured, including zeros", async () => {
  const result = await anthropicUsage({
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  expect(result.measured).toMatchObject({
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
  });
  expect(result.budget.usedUsd).toBeCloseTo((10 * 2) / 1_000_000);
});

it("preserves a raw total over Pi's synthesized total and bounds unclassified input spend", async () => {
  const result = await anthropicUsage({}, 110);
  expect(result.measured).toMatchObject({
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 110,
  });
  expect(result.budget.usedUsd).toBeCloseTo((100 * 3 + 10 * 2) / 1_000_000);
});
