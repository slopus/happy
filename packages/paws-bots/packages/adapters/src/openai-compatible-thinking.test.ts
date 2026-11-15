import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import {
  openAiCompatibleModel,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";

/** Fixtures connect as the deployment owner, who may use local model servers. */
const connectAsOwner = (
  input: Parameters<typeof buildModelConnectPlaintext>[0],
  previous?: string,
  options?: Parameters<typeof buildModelConnectPlaintext>[2],
) => buildModelConnectPlaintext(input, previous, { allowPrivateEndpoint: true, ...options });

const modelId = "arbitrary-model";
const baseUrl = "http://127.0.0.1:8090/v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("keeps the existing keyless connection format", () => {
  const plaintext = connectAsOwner({ provider: "openai-compatible", baseUrl, modelId });
  expect(plaintext).toContain(baseUrl);
  expect(plaintext).not.toContain("apiKey");
});

type Payload = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string }>;
  tools: Array<{ function: { name: string } }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  chat_template_kwargs?: Record<string, unknown>;
  reasoning_effort?: string;
};

function fixtureResponse(): Response {
  const deltas = [
    { reasoning_content: "Check the fixture." },
    { content: "Ready." },
    {
      tool_calls: [
        {
          index: 0,
          id: "call_test",
          type: "function",
          function: { name: "lookup", arguments: '{"value":' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: "42}" } }] },
  ];
  const chunks = [...deltas, {}].map((delta, index) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "tool_calls" : null }],
  }));
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAI-compatible standard thinking transport", () => {
  const provider = "openai-compatible";

  it.each([true, false])("exposes thinking levels for reasoning support %s", (reasoning) => {
    const model = openAiCompatibleModel(modelId, baseUrl, reasoning);
    expect(getSupportedThinkingLevels(model)).toEqual(
      reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : ["off"],
    );
  });

  it.each(["xhigh", "max"] as const)("preserves %s only when reasoning is enabled", (level) => {
    expect(clampThinkingLevel(openAiCompatibleModel(modelId, baseUrl, true), level)).toBe(level);
    expect(clampThinkingLevel(openAiCompatibleModel(modelId, baseUrl), level)).toBe("off");
  });

  async function capture(
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    supportsThinking = true,
    maxTokens?: number,
  ) {
    let payload: Payload | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      payload = JSON.parse(String(init?.body)) as Payload;
      return fixtureResponse();
    });
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId,
      baseUrl,
      allowPrivate: true,
      reasoning: supportsThinking,
      maxTokens,
    });
    const model = models.getModel(provider, modelId) as Model<"openai-completions">;
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: "Use the fixture.",
        messages: [{ role: "user", content: "Look it up.", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Look up a fixture",
            parameters: Type.Object({ value: Type.Number() }),
          },
        ],
      },
      { reasoning, fetch: mockFetch },
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("toolUse");
    return { payload: payload!, result, events };
  }

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "sends standard effort %s unchanged",
    async (level) => {
      const { payload } = await capture(level);
      expect(payload.reasoning_effort).toBe(level);
      expect(payload.chat_template_kwargs).toBeUndefined();
    },
  );

  it("sends the configured maximum output-token limit", async () => {
    const { payload } = await capture("medium", true, 8192);
    expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(8192);
  });

  it("sends none when thinking is off", async () => {
    const { payload } = await capture();
    expect(payload.reasoning_effort).toBe("none");
    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it.each([undefined, "high", "xhigh", "max"] as const)(
    "does not send reasoning fields without support for %s, even for the same model ID",
    async (level) => {
      await capture(level);
      const { payload } = await capture(level, false);
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect(payload.chat_template_kwargs).toBeUndefined();
    },
  );

  it("streams system-role requests, reasoning, text and fragmented tool arguments", async () => {
    const { payload, result, events } = await capture("medium");
    expect(payload.messages[0]?.role).toBe("system");
    expect(payload.stream).toBe(true);
    // Google's OpenAI-compatible endpoint rejects the whole request over `store`.
    expect(payload).not.toHaveProperty("store");
    expect(payload.tools[0]?.function.name).toBe("lookup");
    expect(events).toEqual(
      expect.arrayContaining(["thinking_delta", "text_delta", "toolcall_delta", "done"]),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "Check the fixture." }),
        expect.objectContaining({ type: "text", text: "Ready." }),
        expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { value: 42 } }),
      ]),
    );
  });
});
