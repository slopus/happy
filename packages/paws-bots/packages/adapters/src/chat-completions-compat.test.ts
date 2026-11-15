import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  normalizeChatCompletionsPayload,
  withChatCompletionsCompatibility,
  withoutUnsupportedKeywords,
} from "./chat-completions-compat.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";
import { observedPiStream } from "./pi-usage.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const toolCall = {
  id: "call_1",
  type: "function",
  function: { name: "fixture_tool", arguments: "{}" },
};

function messages(payload: unknown) {
  return (payload as { messages: Array<{ role: string; content: unknown }> }).messages;
}

describe("chat completions message sequence", () => {
  it("merges leading instructions into one system message", () => {
    const payload = {
      messages: [
        { role: "system", content: "Fixture instructions." },
        { role: "system", content: "Fixture memory." },
        { role: "user", content: "Fixture request." },
      ],
    };
    expect(messages(normalizeChatCompletionsPayload(payload))).toEqual([
      { role: "system", content: "Fixture instructions.\n\nFixture memory." },
      { role: "user", content: "Fixture request." },
    ]);
  });

  it("merges consecutive user turns, keeping images", () => {
    const payload = {
      messages: [
        { role: "system", content: "Fixture instructions." },
        { role: "user", content: "Earlier fixture." },
        { role: "user", content: "Assistant: Earlier fixture reply." },
        { role: "user", content: [{ type: "text", text: "Look at this." }, image] },
      ],
    };
    expect(messages(normalizeChatCompletionsPayload(payload))).toEqual([
      { role: "system", content: "Fixture instructions." },
      {
        role: "user",
        content: [
          { type: "text", text: "Earlier fixture.\n\nAssistant: Earlier fixture reply." },
          { type: "text", text: "Look at this." },
          image,
        ],
      },
    ]);
  });

  it("sends text-only content as a string and keeps annotated parts", () => {
    const cached = { type: "text", text: "Cached.", cache_control: { type: "ephemeral" } };
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "One." },
            { type: "text", text: "Two." },
          ],
        },
        { role: "assistant", content: "Fixture reply." },
        { role: "user", content: [cached] },
      ],
    };
    expect(messages(normalizeChatCompletionsPayload(payload))).toEqual([
      { role: "user", content: "One.\nTwo." },
      { role: "assistant", content: "Fixture reply." },
      { role: "user", content: [cached] },
    ]);
  });

  it("folds plain assistant text into the next assistant turn but never moves a tool call", () => {
    const payload = {
      messages: [
        { role: "user", content: "Fixture request." },
        { role: "assistant", content: "Checking." },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", content: "Fixture result.", tool_call_id: "call_1" },
        { role: "assistant", content: null, tool_calls: [{ ...toolCall, id: "call_2" }] },
        { role: "assistant", content: "Done." },
      ],
    };
    expect(messages(normalizeChatCompletionsPayload(payload))).toEqual([
      { role: "user", content: "Fixture request." },
      { role: "assistant", content: "Checking.", tool_calls: [toolCall] },
      { role: "tool", content: "Fixture result.", tool_call_id: "call_1" },
      { role: "assistant", content: null, tool_calls: [{ ...toolCall, id: "call_2" }] },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("returns undefined when the request is already well formed", () => {
    expect(
      normalizeChatCompletionsPayload({
        messages: [
          { role: "system", content: "Fixture instructions." },
          { role: "user", content: "Fixture request." },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", content: "Fixture result.", tool_call_id: "call_1" },
          { role: "tool", content: "Fixture result.", tool_call_id: "call_2" },
        ],
        tools: [{ type: "function", function: { name: "fixture_tool", parameters: {} } }],
      }),
    ).toBeUndefined();
    expect(normalizeChatCompletionsPayload({ contents: [] })).toBeUndefined();
  });

  // Observed: 400 AiError 5006 "oneOf at '/' not met ... Type mismatch of
  // '/messages/8/content' ... '/messages/9/content', 'string' not in 'null'".
  it("sends only string content where the server requires it", () => {
    const payload = {
      messages: [
        { role: "system", content: "Fixture instructions." },
        { role: "user", content: "Earlier fixture." },
        { role: "user", content: [{ type: "text", text: "Fixture request." }] },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", content: "Fixture result.", tool_call_id: "call_1" },
      ],
    };
    const normalized = messages(normalizeChatCompletionsPayload(payload, { stringContent: true }));
    expect(normalized.map((message) => typeof message.content)).toEqual([
      "string",
      "string",
      "string",
      "string",
    ]);
    expect(normalized[2]).toEqual({ role: "assistant", content: "", tool_calls: [toolCall] });
    // Other servers keep the standard null content on a tool-call turn.
    expect(messages(normalizeChatCompletionsPayload(payload))[2]?.content).toBeNull();
  });
});

describe("chat completions tool schemas", () => {
  it("drops unsupported keywords at any depth without touching names or data", () => {
    const schema = {
      type: "object",
      properties: {
        uniqueItems: { type: "boolean" },
        options: { type: "array", items: { type: "string" }, uniqueItems: true },
        nested: {
          anyOf: [{ type: "array", uniqueItems: true }, { type: "null" }],
          default: { uniqueItems: true },
        },
      },
      required: ["uniqueItems"],
    };
    expect(withoutUnsupportedKeywords(schema)).toEqual({
      type: "object",
      properties: {
        uniqueItems: { type: "boolean" },
        options: { type: "array", items: { type: "string" } },
        nested: {
          anyOf: [{ type: "array" }, { type: "null" }],
          default: { uniqueItems: true },
        },
      },
      required: ["uniqueItems"],
    });
    const clean = { type: "object", properties: { query: { type: "string" } } };
    expect(withoutUnsupportedKeywords(clean)).toBe(clean);
  });

  it("still rejects duplicate options locally", () => {
    const definition = builtinAgentTools.find((tool) => tool.name === "ask_user");
    expect(definition).toBeDefined();
    if (!definition) return;
    const tool = { name: "ask_user", description: "", parameters: parametersFor(definition) };
    const call = (options: string[]) => ({
      type: "toolCall" as const,
      id: "call_1",
      name: "ask_user",
      arguments: { question: "Which?", options },
    });
    expect(validateToolArguments(tool, call(["Yes", "No"]))).toBeDefined();
    expect(() => validateToolArguments(tool, call(["Yes", "Yes"]))).toThrow();
  });
});

// Observed: 400 "The `uniqueItems` JSON Schema keyword is not supported." from an
// OpenRouter provider, and template errors on non-alternating roles.
it("normalizes the wire request after every other payload hook", async () => {
  const models = builtinModels();
  const catalogModel = models.getModel("openrouter", "openai/gpt-oss-20b");
  if (!catalogModel) throw new Error("fixture model is missing");
  const model: Model<Api> = { ...catalogModel, reasoning: false };
  const definition = builtinAgentTools.find((tool) => tool.name === "ask_user");
  if (!definition) throw new Error("ask_user is missing");
  const context: Context = {
    systemPrompt: "Fixture instructions.",
    messages: [
      { role: "user", content: "Earlier fixture.", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "Fixture request." }], timestamp: 2 },
    ],
    tools: [{ name: "ask_user", description: "", parameters: parametersFor(definition) }],
  };
  let body: { messages: Array<{ role: string; content: unknown }>; tools: unknown[] } | undefined;
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const earlierHook = vi.fn((payload: unknown) => payload);
  const result = await observedPiStream(
    models,
    model,
    context,
    { apiKey: "fixture-key", maxRetries: 0, fetch: fetchMock, onPayload: earlierHook },
    () => undefined,
  ).result();
  expect(result.stopReason).toBe("stop");
  expect(earlierHook).toHaveBeenCalledOnce();
  expect(body?.messages).toEqual([
    { role: "system", content: "Fixture instructions." },
    { role: "user", content: "Earlier fixture.\n\nFixture request." },
  ]);
  expect(JSON.stringify(body?.tools)).not.toContain("uniqueItems");
  expect(JSON.stringify(body?.tools)).toContain("maxItems");
});

it.each([
  ["workers-ai/@cf/fixture/model", "https://gateway.example.test/compat", ""],
  ["@cf/fixture/model", "https://api.cloudflare.com/client/v4/accounts/fixture/ai/v1", ""],
  ["fixture/model", "https://model.example.test/v1", null],
])("sends %s tool-call turns at %s with content %j", async (id, baseUrl, content) => {
  const base: SimpleStreamOptions = { apiKey: "fixture-key" };
  const options = withChatCompletionsCompatibility(
    { api: "openai-completions", id, baseUrl },
    base,
  );
  const payload = { messages: [{ role: "assistant", content: null, tool_calls: [toolCall] }] };
  const sent = await options.onPayload?.(payload, {} as Model<Api>);
  expect(messages(sent ?? payload)[0]?.content).toBe(content);
});

it("leaves other protocols to their own adapters", () => {
  const options = { apiKey: "fixture-key" };
  expect(
    withChatCompletionsCompatibility(
      { api: "anthropic-messages", id: "fixture", baseUrl: "https://model.example.test" },
      options,
    ),
  ).toBe(options);
});
