import { beforeEach, describe, expect, it, vi } from "vitest";

const promptCalls = vi.hoisted(() => ({
  tools: [] as unknown[],
  images: [] as Array<{ type: "image"; data: string; mimeType: string }> | undefined,
  initialMessages: [] as unknown[],
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    constructor(options: {
      initialState: { messages: unknown[]; tools: unknown[] };
    }) {
      promptCalls.initialMessages = options.initialState.messages;
      promptCalls.tools = options.initialState.tools;
    }
    subscribe() {}
    async prompt(
      _input: string,
      images?: Array<{ type: "image"; data: string; mimeType: string }>,
    ) {
      promptCalls.images = images;
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "vision-test-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("provider should not be called");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

describe("Pi runtime attachments", () => {
  beforeEach(() => {
    promptCalls.images = undefined;
    promptCalls.initialMessages = [];
  });

  it("forwards current-turn images to agent.prompt", async () => {
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "what is in this image?",
        instructions: "test",
        history: [],
        currentTurnImages: [
          {
            name: "shot.png",
            mimeType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
          },
        ],
        tools: [],
        model: { provider: "test", id: "vision-test-model" },
      },
      {
        operationId: "attachment-test",
        traceId: "attachment-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // exhaust runtime
    }

    expect(promptCalls.tools).toEqual([]);
    expect(promptCalls.images).toEqual([
      {
        type: "image",
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("keeps images from an earlier user turn in the conversation", async () => {
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "what time is that flight?",
        instructions: "test",
        history: [
          {
            id: "message-1",
            role: "user",
            content: "[image: ticket.png]",
            images: [
              {
                name: "ticket.png",
                mimeType: "image/png",
                data: new Uint8Array([1, 2, 3]),
              },
            ],
          },
          { id: "message-2", role: "assistant", content: "Got it." },
        ],
        tools: [],
        model: { provider: "test", id: "vision-test-model" },
      },
      {
        operationId: "history-image-test",
        traceId: "history-image-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // exhaust runtime
    }

    expect(promptCalls.initialMessages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[image: ticket.png]" },
          {
            type: "image",
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mimeType: "image/png",
          },
        ],
        timestamp: expect.any(Number),
        rakazoHistory: true,
        rakazoMessageId: "message-1",
        rakazoCreatedAt: undefined,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Got it." }],
        api: "rakazo-history",
        provider: "rakazo-history",
        model: "history",
        usage: expect.objectContaining({ totalTokens: 0 }),
        stopReason: "stop",
        timestamp: expect.any(Number),
        rakazoHistory: true,
        rakazoMessageId: "message-2",
        rakazoCreatedAt: undefined,
      },
    ]);
    expect(promptCalls.images).toBeUndefined();
  });
});
