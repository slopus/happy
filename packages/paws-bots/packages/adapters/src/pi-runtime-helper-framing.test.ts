import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

type FakeTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

const seen = vi.hoisted(() => ({
  helperSystemPrompt: "",
  helperPrompt: "",
  helperToolNames: [] as string[],
  toolExecutionIds: new Map<string, string>(),
  resultForParent: undefined as unknown,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: FakeTool[];
    private readonly systemPrompt: string;
    constructor(options: { initialState: { tools: FakeTool[]; systemPrompt: string } }) {
      this.tools = options.initialState.tools;
      this.systemPrompt = options.initialState.systemPrompt;
    }
    subscribe() {}
    async prompt(text: string) {
      const delegate = this.tools.find((tool) => tool.name === "run_subagent");
      if (delegate) {
        await this.tools
          .find((tool) => tool.name === "use_tool")
          ?.execute("main-call-1", { name: "list_fleet", arguments: {} });
        // The main bot hands work to a helper and reads back what the tool returns.
        seen.resultForParent = await delegate.execute("call-1", {
          name: "scout",
          task: "count the files",
        });
        return;
      }
      // The helper: record what it was told, then answer.
      seen.helperSystemPrompt = this.systemPrompt;
      seen.helperPrompt = text;
      seen.helperToolNames = this.tools.map((tool) => tool.name);
      await this.tools
        .find((tool) => tool.name === "update_bot")
        ?.execute("helper-call-1", { bot_id: "child-1", name: "Obeys" });
      this.state.messages = [
        { role: "assistant", content: [{ type: "text", text: "There are 3 files." }] },
      ];
    }
    async waitForIdle() {}
    abort() {}
  },
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "plain-model" ? { provider: "test", id: modelId, reasoning: false } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
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
import { isSubagentToolExecution } from "./run-effects.js";

describe("helpers know who they are talking to", () => {
  beforeEach(async () => {
    seen.helperSystemPrompt = "";
    seen.helperPrompt = "";
    seen.helperToolNames = [];
    seen.toolExecutionIds.clear();
    seen.resultForParent = undefined;
    for await (const _event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "hello",
        instructions: "",
        history: [],
        tools: builtinAgentTools,
        model: { provider: "test", id: "plain-model" },
        executeTool: vi.fn(async (name: string, _args: unknown, executionId: string) => {
          seen.toolExecutionIds.set(name, executionId);
          return { ok: true };
        }),
      } as never,
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // drain
    }
  });

  it("tells the helper its task comes from the parent bot, not the user", () => {
    expect(seen.helperSystemPrompt).toContain('You are a Rakazo subagent named "scout".');
    expect(seen.helperSystemPrompt).toContain(
      "Your task comes from the parent bot, not from the human user",
    );
    expect(seen.helperSystemPrompt).toContain(
      "Messages marked as automated come from Rakazo, not from the user.",
    );
    expect(seen.helperPrompt).toBe(
      "Task from the parent bot (not from the user):\ncount the files",
    );
  });

  it("never lets the helper inherit any bot management tool", () => {
    expect(seen.helperToolNames.length).toBeGreaterThan(0);
    for (const name of FLEET_TOOL_NAMES) expect(seen.helperToolNames).not.toContain(name);
  });

  it("marks helper calls so the executor refuses update_bot's bot management form from them", () => {
    expect(isSubagentToolExecution(seen.toolExecutionIds.get("update_bot")!)).toBe(true);
    const mainCall = seen.toolExecutionIds.get("list_fleet");
    expect(mainCall).toBeDefined();
    expect(isSubagentToolExecution(mainCall!)).toBe(false);
  });

  it("hands the helper's answer back to the bot as the helper's, not the user's", () => {
    const result = seen.resultForParent as
      | { content?: Array<{ type?: string; text?: string }> }
      | string;
    const text =
      typeof result === "string"
        ? result
        : (result.content ?? []).map((part) => part.text ?? "").join("");
    expect(text).toBe(
      'Result from your helper "scout" (not a message from the user):\nThere are 3 files.',
    );
  });
});
