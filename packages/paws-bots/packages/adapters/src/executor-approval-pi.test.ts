import type { ConnectorTool } from "@rakazo/adapter-kit";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalPausedToolResult,
  isApprovalPausedResult,
  resolveDuplicateEffectGate,
} from "./approval-effect.js";

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
      const destination = this.tools.find((tool) => tool.name === "destination_write");
      if (!destination) throw new Error("destination tool missing");
      const args = { collection: "notes", title: "Result", body: "Done" };
      fakeAgentState.lastToolResult = await destination.execute(fakeAgentState.toolCallId, args);
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
      modelId === "approval-pi-model" ? { provider: "test", id: modelId } : undefined,
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

const destinationTool: ConnectorTool = {
  name: "destination.write",
  description: "Write a record to the connected destination",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
};

const runContext = {
  operationId: "approval-pi",
  traceId: "approval-pi",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "write the result",
  instructions: "Use destination_write for connected destination records.",
  history: [],
  tools: [destinationTool],
  model: { provider: "test", id: "approval-pi-model" },
};

describe("Pi approval pause", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.toolCallId = "call-1";
    fakeAgentState.lastToolResult = null;
  });

  it("forwards a terminating approval tool result from executeTool", async () => {
    const executeTool = vi.fn(async () => approvalPausedToolResult());
    const runtime = new PiAgentRuntime();
    const texts: string[] = [];

    for await (const event of runtime.run({ ...runRequest, executeTool }, runContext)) {
      if (event.type === "text") texts.push(event.text);
    }

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(fakeAgentState.lastToolResult).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      details: { approval: "paused" },
    });
    expect(isApprovalPausedResult(fakeAgentState.lastToolResult)).toBe(true);
    expect(texts.some((text) => text.includes("I hit a problem"))).toBe(false);
  });

  it("replays an approved effect for a new toolCallId without another pause", async () => {
    fakeAgentState.toolCallId = "call-2";
    const args = { collection: "notes", title: "Result", body: "Done" };
    const executeTool = vi.fn(async (_tool, toolArgs, toolCallId) => {
      expect(toolCallId).toBe(JSON.stringify(["pi-tool", "main", "call-2"]));
      expect(approvalEffectKey("run", "destination.write", toolArgs)).toBe(
        approvalEffectKey("run", "destination.write", args),
      );
      expect(resolveDuplicateEffectGate({ status: "approved" }, "destination.write")).toEqual({
        action: "execute",
      });
      return { ok: true, written: true };
    });

    const runtime = new PiAgentRuntime();
    const texts: string[] = [];

    for await (const event of runtime.run({ ...runRequest, executeTool }, runContext)) {
      if (event.type === "text") texts.push(event.text);
    }

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(texts.some((text) => text.includes("Waiting for approval"))).toBe(false);
    expect(texts.some((text) => text.includes("I hit a problem"))).toBe(false);
  });
});
