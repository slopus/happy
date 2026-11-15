import type { Api, AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it, vi } from "vitest";
import { withGoogleToolHistory } from "./google-tool-history.js";
import { observedPiStream } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "google",
  id: "gemini-3-flash-preview",
  api: "google-generative-ai",
  name: "Fixture",
  baseUrl: "https://model.example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 256,
};
const call = (id: string, args: ToolCall["arguments"], signature?: string) => ({
  type: "toolCall" as const,
  id,
  name: "fixture_tool",
  arguments: args,
  ...(signature ? { thoughtSignature: signature } : {}),
});
const assistant = (source: string, content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  provider: "google",
  model: source,
  api: model.api,
  content,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 1,
});

it.each(["google", "openai"])(
  "sends transferred %s tool history on the wire and preserves native parallel signatures",
  async (sourceProvider) => {
    const context: Context = {
      messages: [
        { role: "user", content: "Fixture request.", timestamp: 1 },
        {
          ...assistant("fixture-origin", [call("foreign", { query: "earlier" }, "Zm9yZWlnbg==")]),
          provider: sourceProvider,
          api: sourceProvider === "google" ? model.api : "openai-completions",
        },
        {
          role: "toolResult",
          toolCallId: "foreign",
          toolName: "fixture_tool",
          content: [{ type: "text", text: "Historical fixture result." }],
          isError: false,
          timestamp: 2,
        },
        assistant(model.id, [
          call("native", { query: "current" }, "bmF0aXZl"),
          call("parallel", { query: "parallel" }),
        ]),
        ...["native", "parallel"].map((toolCallId) => ({
          role: "toolResult" as const,
          toolCallId,
          toolName: "fixture_tool",
          content: [{ type: "text" as const, text: "Current fixture result." }],
          isError: false,
          timestamp: 3,
        })),
      ],
    };
    const before = JSON.stringify(context);
    let body:
      | {
          contents: Array<{
            parts: Array<{ functionCall?: { name: string }; thoughtSignature?: string }>;
          }>;
        }
      | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Ready"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const onPayload = vi.fn();
    try {
      const events = observedPiStream(
        builtinModels(),
        model,
        context,
        { apiKey: "fixture-key", onPayload, maxRetries: 0 },
        () => undefined,
      );
      const result = await events.result();
      expect(result.stopReason).toBe("stop");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(onPayload).toHaveBeenCalledOnce();
      expect(
        body?.contents.flatMap((content) => content.parts).filter((part) => part.functionCall),
      ).toMatchObject([
        {
          functionCall: { name: "fixture_tool", args: { query: "earlier" } },
          thoughtSignature: "skip_thought_signature_validator",
        },
        {
          functionCall: { name: "fixture_tool", args: { query: "current" } },
          thoughtSignature: "bmF0aXZl",
        },
        { functionCall: { name: "fixture_tool", args: { query: "parallel" } } },
      ]);
      const calls = body?.contents
        .flatMap((content) => content.parts)
        .filter((part) => part.functionCall);
      expect(calls?.[2]).not.toHaveProperty("thoughtSignature");
      expect(JSON.stringify(body)).toContain("Historical fixture result.");
      expect(JSON.stringify(context)).toBe(before);
    } finally {
      fetchMock.mockRestore();
    }
  },
);

type WirePart = {
  functionCall?: { name: string; args?: unknown };
  thoughtSignature?: string;
};

async function wireCalls(context: Context): Promise<WirePart[]> {
  let body: { contents: Array<{ role: string; parts: WirePart[] }> } | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Ready"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const result = await observedPiStream(
      builtinModels(),
      model,
      context,
      { apiKey: "fixture-key", maxRetries: 0 },
      () => undefined,
    ).result();
    expect(result.stopReason).toBe("stop");
  } finally {
    fetchMock.mockRestore();
  }
  return (body?.contents ?? []).flatMap((content) =>
    content.parts.filter((part) => part.functionCall),
  );
}

const results = (...ids: string[]) =>
  ids.map((toolCallId) => ({
    role: "toolResult" as const,
    toolCallId,
    toolName: "fixture_tool",
    content: [{ type: "text" as const, text: "Fixture result." }],
    isError: false,
    timestamp: 3,
  }));

it("marks a restored step from another Google API whose signature Pi discards", async () => {
  // A turn checkpoint written while the model ran on Vertex and resumed on the
  // Gemini API keeps the same provider and model id, so the step looks native,
  // but Pi only replays signatures for the same API.
  const context: Context = {
    messages: [
      { role: "user", content: "Fixture request.", timestamp: 1 },
      {
        ...assistant(model.id, [
          call("first", { query: "a" }, "bmF0aXZl"),
          call("second", { query: "b" }),
        ]),
        api: "google-vertex",
      },
      ...results("first", "second"),
    ],
  };
  const calls = await wireCalls(context);
  expect(calls).toMatchObject([
    {
      functionCall: { name: "fixture_tool", args: { query: "a" } },
      thoughtSignature: "skip_thought_signature_validator",
    },
    { functionCall: { name: "fixture_tool", args: { query: "b" } } },
  ]);
  expect(calls[1]).not.toHaveProperty("thoughtSignature");
});

it("marks every step whose first call reaches the wire unsigned and keeps real signatures", async () => {
  const shared = { query: "shared" };
  const context: Context = {
    messages: [
      { role: "user", content: "Fixture request.", timestamp: 1 },
      assistant(model.id, [call("signed", { query: "signed" }, "c2lnbmVk")]),
      ...results("signed"),
      // Pi drops a signature that is not valid base64 for the bytes field.
      assistant(model.id, [call("unusable", { query: "unusable" }, "not base64")]),
      ...results("unusable"),
      // An argument object shared with a foreign call must not matter.
      assistant("fixture-origin", [call("foreign", shared, "Zm9yZWlnbg==")]),
      ...results("foreign"),
      assistant(model.id, [
        { type: "text", text: "Checking both." },
        call("native", shared),
        call("parallel", { query: "parallel" }),
      ]),
      ...results("native", "parallel"),
    ],
  };
  const before = JSON.stringify(context);
  expect((await wireCalls(context)).map((part) => part.thoughtSignature)).toEqual([
    "c2lnbmVk",
    "skip_thought_signature_validator",
    "skip_thought_signature_validator",
    "skip_thought_signature_validator",
    undefined,
  ]);
  expect(JSON.stringify(context)).toBe(before);
});

it("leaves other protocols and non-Gemini models unchanged", () => {
  const options = { apiKey: "fixture-key" };
  expect(withGoogleToolHistory({ ...model, api: "openai-completions" }, options)).toBe(options);
  expect(withGoogleToolHistory({ ...model, id: "gemma-4-31b-it" }, options)).toBe(options);
});

it("keeps the caller's payload hook and its replacement", async () => {
  const payload = {
    contents: [
      { role: "user", parts: [{ text: "Fixture request." }] },
      { role: "model", parts: [{ functionCall: { name: "fixture_tool", args: {} } }] },
    ],
  };
  const replacement = { fixture: true };
  const onPayload = vi.fn(() => replacement);
  const options = withGoogleToolHistory(model, { onPayload });
  expect(await options.onPayload?.(payload, model)).toBe(replacement);
  expect(payload.contents[1]?.parts[0]).toHaveProperty(
    "thoughtSignature",
    "skip_thought_signature_validator",
  );
  expect(payload.contents[0]?.parts[0]).not.toHaveProperty("thoughtSignature");
  expect(onPayload).toHaveBeenCalledWith(payload, model);
});
