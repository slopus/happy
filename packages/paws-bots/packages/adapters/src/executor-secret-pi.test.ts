import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isToolPauseResult } from "./approval-effect.js";
import { secretPausedToolResult } from "./run-secret.js";

const fakeAgentState = vi.hoisted(() => ({
  tools: [] as Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
  toolCallId: "call-1",
  lastToolResult: null as unknown,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      const secret = this.tools.find((tool) => tool.name === "request_secret");
      if (!secret) throw new Error("request_secret tool missing");
      fakeAgentState.lastToolResult = await secret.execute(fakeAgentState.toolCallId, {
        label: "Enter code",
        purpose: "otp",
      });
      if (
        fakeAgentState.lastToolResult &&
        typeof fakeAgentState.lastToolResult === "object" &&
        (fakeAgentState.lastToolResult as { terminate?: boolean }).terminate
      ) {
        return;
      }
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "secret-pi-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
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

const secretTool: ConnectorTool = {
  name: "request_secret",
  description: "Collect protected input",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      purpose: { type: "string", enum: ["otp", "password", "api_key"] },
    },
    required: ["label", "purpose"],
  },
};

const runContext = {
  operationId: "secret-pi",
  traceId: "secret-pi",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "need a code",
  instructions: "Use request_secret for one-shot codes.",
  history: [],
  tools: [secretTool],
  model: { provider: "test", id: "secret-pi-model" },
};

describe("Pi secret pause", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.toolCallId = "call-secret-1";
    fakeAgentState.lastToolResult = null;
  });

  it("does not emit the finished-work fallback after a secret pause", async () => {
    const executeTool = vi.fn(async () => secretPausedToolResult());
    const runtime = new PiAgentRuntime();
    const texts: string[] = [];
    const progress: string[] = [];

    for await (const event of runtime.run({ ...runRequest, executeTool }, runContext)) {
      if (event.type === "text") texts.push(event.text);
      if (event.type === "progress") progress.push(event.text);
    }

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(isToolPauseResult(fakeAgentState.lastToolResult)).toBe(true);
    expect(texts.join("")).not.toContain("I finished the work.");
    expect(progress.join("")).not.toContain("I finished the work.");
  });
});
