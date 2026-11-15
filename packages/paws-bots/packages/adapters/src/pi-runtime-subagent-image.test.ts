import type { Context, Model } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import type * as RuntimeContextModule from "./runtime-context.js";

const captured = vi.hoisted(() => ({ policies: [] as unknown[] }));

vi.mock("./runtime-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeContextModule>();
  return {
    ...actual,
    createRuntimeContextPolicy: (...args: Parameters<typeof actual.createRuntimeContextPolicy>) => {
      const policy = actual.createRuntimeContextPolicy(...args);
      captured.policies.push(policy);
      return policy;
    },
  };
});

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: Array<{
      name: string;
      execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
    }>;
    constructor(options: {
      initialState: {
        tools: Array<{
          name: string;
          execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
        }>;
      };
    }) {
      this.tools = options.initialState.tools;
    }
    subscribe() {}
    async prompt() {
      await this.tools
        .find((tool) => tool.name === "run_subagent")
        ?.execute("subagent-call", { name: "helper", task: "Inspect the screen" });
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) =>
      provider === "test" && id === "vision-test-model"
        ? {
            provider,
            id,
            api: "openai-completions",
            baseUrl: "http://127.0.0.1/unused",
            contextWindow: 128_000,
            maxTokens: 4096,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }
        : undefined,
    streamSimple: () => {
      throw new Error("The fake agent must not make a model request");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import type { createRuntimeContextPolicy } from "./runtime-context.js";

it("uses the image planner in a nested subagent's screenshot context", async () => {
  captured.policies = [];
  for await (const _event of new PiAgentRuntime().run(
    {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "Delegate the visual task.",
      instructions: "Keep the answer brief.",
      history: [],
      tools: builtinAgentTools,
      model: { provider: "test", id: "vision-test-model" },
    },
    {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  )) {
  }
  expect(captured.policies).toHaveLength(2);
  const policy = captured.policies[1] as ReturnType<typeof createRuntimeContextPolicy>;
  const pixels = Buffer.alloc(1024 * 1024);
  let seed = 1;
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[index] = seed & 255;
  }
  const png = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 1 } })
    .png()
    .toBuffer();
  expect(png.length).toBeGreaterThan(1_000_000);
  const image = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
  const context = {
    systemPrompt: "Inspect the screen.",
    tools: [],
    messages: [
      { role: "user" as const, content: "Check this screen", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "capture", name: "computer_observe", arguments: {} },
        ],
        api: "openai-completions" as const,
        provider: "test",
        model: "vision-test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse" as const,
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "capture",
        toolName: "computer_observe",
        content: [image],
        details: {},
        isError: false,
        timestamp: 3,
      },
    ],
  } satisfies Context;
  const model = {
    provider: "test",
    id: "vision-test-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/unused",
    contextWindow: 128_000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<"openai-completions">;
  const prepared = policy.prepareContext(context, model);
  expect(prepared.messages.at(-1)).toMatchObject({ content: [image] });
  expect(policy.getDecision()!.estimatedInputTokens).toBeLessThan(128_000 - 4096);
});
