import type { AgentToolCompletion, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const fakeAgentState = vi.hoisted(() => ({
  mode: "dispatch" as
    | "dispatch"
    | "empty"
    | "answer-then-stop"
    | "two-boundaries"
    | "silent-continuation"
    | "subagent-limit"
    | "two-subagents"
    | "background-subagent"
    | "parent-limit"
    | "parent-parallel"
    | "ask-pause"
    | "nested-ask-pause"
    | "tools-then-empty-failure"
    | "tools-then-final-text"
    | "terminating-tool",
  terminalMessage: undefined as
    | {
        role: "assistant";
        content: Array<{ type: "text"; text: string } | { type: "toolCall" }>;
        stopReason?: string;
        errorMessage?: string;
      }
    | undefined,
  emitFinalAfterFollowUp: true,
  /** Deliver the post-tool answer only on the completed message, with no text deltas. */
  emitFinalOnCompletedMessage: false,
  /** Stream the post-tool answer, but leave the completed turn's message text empty. */
  emitFinalDeltaOnly: false,
  narration: "I will check the destination first.",
  finalDelta: undefined as string | undefined,
  abortCount: 0,
  tools: [] as Array<{
    name: string;
    executionMode?: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
  invoke: {
    name: "destination_write",
    args: { collection: "notes", title: "Result", body: "Done" } as Record<string, unknown>,
  },
  preparedMessages: [] as unknown[],
  steeredMessages: [] as unknown[],
  followUpMessages: [] as unknown[],
  initialMessages: [] as unknown[],
  promptInputs: [] as string[],
  promptImages: [] as unknown[][],
  toolResult: undefined as unknown,
  continueCalls: 0,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = {
      errorMessage: undefined as string | undefined,
      messages: [] as unknown[],
    };
    private readonly tools: typeof fakeAgentState.tools;
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];
    private readonly prepareNextTurnWithContext?: (input: {
      context: { messages: unknown[] };
    }) => Promise<{ context?: { messages: unknown[] }; messages?: unknown[] } | undefined>;
    private readonly finishTurn?: (turn: unknown, signal?: AbortSignal) => Promise<unknown>;
    private aborted = false;

    constructor(options: {
      initialState: { tools: typeof fakeAgentState.tools; messages: unknown[] };
      prepareNextTurnWithContext?: (input: {
        context: { messages: unknown[] };
      }) => Promise<{ context?: { messages: unknown[] }; messages?: unknown[] } | undefined>;
      finishTurn?: (turn: unknown, signal?: AbortSignal) => Promise<unknown>;
    }) {
      this.tools = options.initialState.tools;
      this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
      this.finishTurn = options.finishTurn;
      fakeAgentState.tools = this.tools;
      fakeAgentState.initialMessages = options.initialState.messages;
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    // Messages the hook returns are appended before the next request, like steered ones.
    private async prepareNextTurn() {
      const update = await this.prepareNextTurnWithContext?.({ context: { messages: [] } });
      fakeAgentState.steeredMessages.push(...(update?.messages ?? []));
    }

    async prompt(prompt: string, images?: unknown[]) {
      fakeAgentState.promptInputs.push(prompt);
      fakeAgentState.promptImages.push(images ?? []);
      if (fakeAgentState.mode === "answer-then-stop") {
        // The model answers the steered message in text and stops.
        await this.prepareNextTurn();
        await this.finishTurn?.({
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Yes" }],
          },
          toolResults: [],
          context: { messages: [] },
          newMessages: [],
        });
        return;
      }
      if (fakeAgentState.mode === "empty" || fakeAgentState.mode === "two-boundaries") {
        await this.prepareNextTurn();
        if (fakeAgentState.mode === "two-boundaries") await this.prepareNextTurn();
        fakeAgentState.preparedMessages = [...fakeAgentState.steeredMessages];
        return;
      }

      if (fakeAgentState.mode === "dispatch") {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        this.emit({
          type: "tool_execution_start",
          toolName: target.name,
          args,
        });
        fakeAgentState.toolResult = await target.execute("call-1", args);
        return;
      }

      if (fakeAgentState.mode === "terminating-tool") {
        // A tool result with terminate: true ends the turn; the agent stops after it.
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        this.emit({
          type: "message_start",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: target.name, arguments: args }],
          },
        });
        this.emit({ type: "tool_execution_start", toolName: target.name, args });
        const result = await target.execute("call-1", args);
        fakeAgentState.toolResult = result;
        this.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: target.name,
          result,
          isError: false,
        });
        // Like pi-agent-core, the terminating tool result lands in the transcript:
        // it stays the last message, because the turn ends at it.
        const toolResultMessage = {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: target.name,
          content: (result as { content: unknown[] }).content,
          isError: false,
          timestamp: Date.now(),
        };
        this.emit({ type: "message_start", message: toolResultMessage });
        this.emit({ type: "message_end", message: toolResultMessage });
        this.state.messages.push(toolResultMessage);
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: target.name, arguments: args }],
          },
          toolResults: [{ toolCallId: "call-1", result }],
        });
        return;
      }

      if (fakeAgentState.mode === "silent-continuation") {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        const narration = "I will check the destination first.";
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: narration },
        });
        this.emit({
          type: "tool_execution_start",
          toolName: target.name,
          args,
        });
        await target.execute("call-1", args);
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: narration },
              {
                type: "toolCall",
                id: "call-1",
                name: target.name,
                arguments: args,
              },
            ],
          },
          toolResults: [{ toolCallId: "call-1", result: { ok: true } }],
        });
        this.emit({
          type: "turn_end",
          message: { role: "assistant", content: [] },
          toolResults: [],
        });
        if (fakeAgentState.followUpMessages.length > 0 && fakeAgentState.emitFinalAfterFollowUp) {
          const text = "The final answer.";
          if (!fakeAgentState.emitFinalOnCompletedMessage) {
            this.emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: text },
            });
          }
          const content = fakeAgentState.emitFinalDeltaOnly ? [] : [{ type: "text", text }];
          this.emit({
            type: "message_end",
            message: { role: "assistant", content },
          });
          this.emit({
            type: "turn_end",
            message: { role: "assistant", content },
            toolResults: [],
          });
        }
        return;
      }

      if (
        fakeAgentState.mode === "tools-then-empty-failure" ||
        fakeAgentState.mode === "tools-then-final-text"
      ) {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        const narration = fakeAgentState.narration;
        this.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: narration,
          },
        });
        this.emit({
          type: "tool_execution_start",
          toolName: target.name,
          args,
        });
        await target.execute("call-1", args);
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: narration },
              {
                type: "toolCall",
                id: "call-1",
                name: target.name,
                arguments: args,
              },
            ],
          },
          toolResults: [{ toolCallId: "call-1", result: { ok: true } }],
        });
        const terminal = fakeAgentState.terminalMessage ?? {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "" }],
          stopReason: "length",
        };
        this.state.messages.push(terminal);
        this.emit({ type: "message_start", message: terminal });
        if (fakeAgentState.finalDelta) {
          this.emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: fakeAgentState.finalDelta,
            },
          });
        }
        this.emit({ type: "message_end", message: terminal });
        this.emit({
          type: "turn_end",
          message: terminal,
          toolResults: [],
        });
        return;
      }

      if (fakeAgentState.mode === "parent-limit") {
        const shell = this.tools.find((tool) => tool.name === "shell");
        if (!shell) throw new Error("shell was not exposed");
        for (let index = 0; index < 100; index += 1) {
          const args = { command: `echo ${index}` };
          this.emit({
            type: "tool_execution_start",
            toolName: shell.name,
            args,
          });
          if (this.aborted) break;
          await shell.execute(`shell-${index}`, args);
        }
        return;
      }

      if (fakeAgentState.mode === "parent-parallel") {
        const shell = this.tools.find((tool) => tool.name === "shell");
        if (!shell) throw new Error("shell was not exposed");
        const batch = Array.from({ length: 4 }, (_, index) => ({
          args: { command: `echo ${index}` },
        }));
        for (const item of batch) {
          this.emit({
            type: "tool_execution_start",
            toolName: shell.name,
            args: item.args,
          });
        }
        await Promise.all(
          batch.map((item, index) =>
            this.aborted ? Promise.resolve() : shell.execute(`shell-${index}`, item.args),
          ),
        );
        return;
      }

      if (fakeAgentState.mode === "ask-pause" || fakeAgentState.mode === "nested-ask-pause") {
        if (fakeAgentState.mode === "nested-ask-pause") {
          const delegation = this.tools.find((tool) => tool.name === "run_subagent");
          if (delegation) {
            const args = { name: "helper", task: "ask the user" };
            this.emit({
              type: "tool_execution_start",
              toolName: delegation.name,
              args,
            });
            await delegation.execute("delegate-1", args);
            return;
          }
        }
        const shell = this.tools.find((tool) => tool.name === "shell");
        const askUser = this.tools.find((tool) => tool.name === "ask_user");
        if (!shell) throw new Error("shell was not exposed");
        if (!askUser) throw new Error("ask_user was not exposed");
        for (let index = 0; index < 2; index += 1) {
          const args = { command: `echo ${index}` };
          this.emit({
            type: "tool_execution_start",
            toolName: shell.name,
            args,
          });
          if (this.aborted) return;
          await shell.execute(`shell-pause-${index}`, args);
        }
        const askArgs = {
          question: "Which option?",
          options: ["Keep going", "Stop here"],
        };
        this.emit({
          type: "tool_execution_start",
          toolName: askUser.name,
          args: askArgs,
        });
        if (!this.aborted) await askUser.execute("ask-1", askArgs);
        return;
      }

      const delegation = this.tools.find((tool) => tool.name === "run_subagent");
      if (delegation && fakeAgentState.mode === "background-subagent") {
        const args = { name: "scout", task: "compare the venues", background: true };
        this.emit({ type: "tool_execution_start", toolName: delegation.name, args });
        // Pi prepares the model's arguments before it runs the tool.
        await delegation.execute("delegate-bg", delegation.prepareArguments?.(args) ?? args);
        return;
      }
      if (delegation && fakeAgentState.mode === "two-subagents") {
        await Promise.all(
          ["a", "b"].map((name) => {
            const args = { name, task: "keep calling shell" };
            this.emit({ type: "tool_execution_start", toolName: delegation.name, args });
            return delegation.execute(`delegate-${name}`, args);
          }),
        );
        return;
      }
      if (delegation) {
        const args = { name: "loop", task: "keep calling shell" };
        this.emit({
          type: "tool_execution_start",
          toolName: delegation.name,
          args,
        });
        await delegation.execute("delegate-1", args);
        return;
      }

      const shell = this.tools.find((tool) => tool.name === "shell");
      if (!shell) throw new Error("shell was not exposed to the subagent");
      for (let index = 0; index < 100; index += 1) {
        const args = { command: `echo ${index}` };
        this.emit({ type: "tool_execution_start", toolName: shell.name, args });
        if (this.aborted) break;
        await shell.execute(`shell-${index}`, args);
      }
    }

    async waitForIdle() {}

    async continue() {
      fakeAgentState.continueCalls += 1;
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Trying again anyway." }],
        stopReason: "stop",
      };
      this.emit({ type: "message_start", message });
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Trying again anyway." },
      });
      this.state.messages.push(message);
      this.emit({ type: "message_end", message });
      this.emit({ type: "turn_end", message, toolResults: [] });
    }

    steer(message: unknown) {
      fakeAgentState.steeredMessages.push(message);
    }

    followUp(message: unknown) {
      fakeAgentState.followUpMessages.push(message);
    }

    abort() {
      this.aborted = true;
      // Mirror pi-agent-core: abort settles the run with an errorMessage that
      // would otherwise make PiAgentRuntime throw and skip a final reply.
      this.state.errorMessage = "Request aborted by user";
      fakeAgentState.abortCount += 1;
    }

    private emit(event: Record<string, unknown>) {
      for (const listener of this.listeners) listener(event);
    }
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "dispatch-test-model" ? { provider: "test", id: modelId } : undefined,
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

import {
  approvalPausedToolResult,
  OWNER_SETTINGS_REFUSAL_REPLY,
  terminatingToolResult,
} from "./approval-effect.js";
import { MISSING_TOOL_FINAL_RESPONSE_ERROR, PiAgentRuntime } from "./pi-runtime.js";
import { providerFailureText } from "./pi-runtime-errors.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { maxToolCallsPerTurn } from "./pi-runtime-tools.js";
import { toolCompletionAuditPayload } from "./tool-completion-audit.js";
import { serializeTurnCheckpoint } from "./turn-checkpoint.js";
import { midTaskMessageFromPrompt, midTaskMessagePrompt } from "./user-progress.js";

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
  route: { connectorId: "destination", toolName: "destination.write" },
};

const writeFileTool: ConnectorTool = {
  name: "write_file",
  description: "Write a UTF-8 file into this bot's home.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

const shellTool = {
  name: "shell",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
};

const updateBotTool: ConnectorTool = {
  name: "update_bot",
  description: "Update this bot's settings",
  inputSchema: {
    type: "object",
    properties: { notifyOnFinish: { type: "boolean" } },
  },
};

const listFilesTool: ConnectorTool = {
  name: "list_files",
  description: "List files in this bot's home",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

const scheduleCreateTool: ConnectorTool = {
  name: "schedule_create",
  description: "Create a reminder or recurring job for this bot.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      prompt: { type: "string" },
      delayMinutes: { type: "number" },
    },
  },
};

const scheduleListTool: ConnectorTool = {
  name: "schedule_list",
  description: "List this bot's active and inactive schedules (routines).",
  inputSchema: { type: "object", properties: {} },
};

const scheduleCancelTool: ConnectorTool = {
  name: "schedule_cancel",
  description: "Cancel a schedule by routineId or exact name.",
  inputSchema: {
    type: "object",
    properties: { routineId: { type: "string" }, name: { type: "string" } },
  },
};

const previousMaxToolCalls = process.env.MAX_TOOL_CALLS_PER_TURN;

describe("Pi connector tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.mode = "dispatch";
    fakeAgentState.abortCount = 0;
    fakeAgentState.tools = [];
    fakeAgentState.preparedMessages = [];
    fakeAgentState.steeredMessages = [];
    fakeAgentState.followUpMessages = [];
    fakeAgentState.emitFinalAfterFollowUp = true;
    fakeAgentState.terminalMessage = undefined;
    fakeAgentState.emitFinalOnCompletedMessage = false;
    fakeAgentState.emitFinalDeltaOnly = false;
    fakeAgentState.narration = "I will check the destination first.";
    fakeAgentState.finalDelta = undefined;
    fakeAgentState.initialMessages = [];
    fakeAgentState.promptInputs = [];
    fakeAgentState.promptImages = [];
    fakeAgentState.toolResult = undefined;
    fakeAgentState.continueCalls = 0;
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
    delete process.env.MAX_TOOL_CALLS_PER_TURN;
  });

  it("injects durable steering at Pi's next safe turn boundary", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      return claimCount === 1
        ? []
        : [
            {
              id: "steering-1",
              messageId: "message-1",
              text: "Use the newer customer totals.",
              origin: "user" as const,
            },
            {
              id: "steering-2",
              messageId: "message-2",
              text: "Keep the original date range.",
              origin: "webhook" as const,
            },
          ];
    });
    const runtime = new PiAgentRuntime();
    const events: Array<{ type: string; fromRunUser?: boolean }> = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "prepare the report",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    // The run's person is asked for a reply; anything else is passed on with its source and
    // no call to reply. The run sees one boundary, marked as from its person.
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: midTaskMessagePrompt("Use the newer customer totals.", false),
      }),
      expect.objectContaining({
        role: "user",
        content: midTaskMessageFromPrompt("Keep the original date range.", "webhook"),
      }),
    ]);
    expect(fakeAgentState.preparedMessages[1]).toMatchObject({
      content: expect.not.stringContaining("reply"),
    });
    expect(events.filter((event) => event.type === "steered")).toEqual([
      { type: "steered", fromRunUser: true },
    ]);
  });

  it("asks the run's person for an answer through message_user when the bot has it", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      return claimCount === 1
        ? []
        : [
            {
              id: "steering-1",
              messageId: "message-1",
              text: "Still working?",
              origin: "user" as const,
            },
          ];
    });
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "prepare the report",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [builtinAgentTools.find((tool) => tool.name === "message_user")!],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ content: midTaskMessagePrompt("Still working?", true) }),
    ]);
  });

  it("ends the run when the model answers the person in text and stops", async () => {
    fakeAgentState.mode = "answer-then-stop";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      return claimCount === 1
        ? []
        : [
            {
              id: "steering-1",
              messageId: "message-1",
              text: "Still working?",
              origin: "user" as const,
            },
          ];
    });
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "prepare the report",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }
    expect(fakeAgentState.followUpMessages).toEqual([]);
  });

  it("defers steering arriving during a continuation to the following boundary", async () => {
    fakeAgentState.mode = "two-boundaries";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) return [];
      return claimCount === 2
        ? [
            {
              id: "steering-1",
              messageId: "message-1",
              text: "First boundary context.",
              origin: "user" as const,
            },
          ]
        : [
            {
              id: "steering-2",
              messageId: "message-2",
              text: "Next boundary context.",
              origin: "user" as const,
            },
          ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "continue",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    expect(claimSteering).toHaveBeenNthCalledWith(3, ["steering-1"]);
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ content: midTaskMessagePrompt("First boundary context.", false) }),
      expect.objectContaining({ content: midTaskMessagePrompt("Next boundary context.", false) }),
    ]);
  });

  it("consumes pending continuation steering once in the first prompt", async () => {
    fakeAgentState.mode = "empty";
    const steering = [
      {
        id: "steering-1",
        messageId: "message-1",
        text: "Use the newer customer totals.",
      },
      {
        id: "steering-2",
        messageId: "message-2",
        text: "Keep the original date range.",
      },
    ];
    const claimSteering = vi.fn(async (seenIds: string[]) => (seenIds.length ? [] : steering));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "continuation",
        prompt: "Respond to the user's steering context.",
        instructions: "Follow the user's instructions.",
        history: [
          {
            id: steering[0]!.messageId,
            role: "user",
            content: steering[0]!.text,
          },
          {
            id: steering[1]!.messageId,
            role: "user",
            content: steering[1]!.text,
          },
          { role: "assistant", content: "Here is the first result." },
        ],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptInputs).toHaveLength(1);
    for (const item of steering) {
      expect(fakeAgentState.promptInputs[0]?.split(item.text)).toHaveLength(2);
      expect(JSON.stringify(fakeAgentState.initialMessages)).not.toContain(item.text);
    }
    expect(fakeAgentState.steeredMessages).toEqual([]);
  });

  it("delivers images attached to initial and boundary steering", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return [
          {
            id: "initial-image",
            messageId: "initial-image-message",
            text: "Inspect the first image.",
            images: [
              {
                name: "first.png",
                mimeType: "image/png" as const,
                data: new Uint8Array([1, 2, 3]),
              },
            ],
          },
        ];
      }
      return [
        {
          id: "boundary-image",
          messageId: "boundary-image-message",
          text: "Compare the second image.",
          origin: "user" as const,
          images: [
            {
              name: "second.png",
              mimeType: "image/png" as const,
              data: new Uint8Array([4, 5, 6]),
            },
          ],
        },
      ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "image-steering",
        prompt: "continue",
        instructions: "Inspect attached images.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptImages).toEqual([
      [{ type: "image", data: "AQID", mimeType: "image/png" }],
    ]);
    expect(fakeAgentState.steeredMessages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: midTaskMessagePrompt("Compare the second image.", false) },
        { type: "image", data: "BAUG", mimeType: "image/png" },
      ],
      timestamp: expect.any(Number),
    });
  });

  afterEach(() => {
    if (previousMaxToolCalls === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
    else process.env.MAX_TOOL_CALLS_PER_TURN = previousMaxToolCalls;
  });

  it.each([undefined, "", ".", "/home/rakazo", "subdir"])(
    "preserves executor-owned shell cwd defaults (%j)",
    async (cwd) => {
      const command = "printf WORKSPACE_OK > roundtrip.txt";
      fakeAgentState.invoke = {
        name: "shell",
        args: cwd === undefined ? { command } : { command, cwd },
      };
      const executeTool = vi.fn(async () => ({ ok: true }));
      const runtime = new PiAgentRuntime();
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "r",
          prompt: "write the workspace test file",
          instructions: "Use shell.",
          history: [],
          tools: [shellTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        { signal: new AbortController().signal },
      )) {
        // Exercise Pi argument preparation and execution, not just path helpers.
      }
      expect(executeTool.mock.calls).toStrictEqual([
        [
          "shell",
          cwd ? { command, cwd } : { command },
          JSON.stringify(["pi-tool", "main", "call-1"]),
          undefined,
          { onShellStillRunning: expect.any(Function) },
        ],
      ]);
    },
  );

  it("exposes a provider-safe name while executing the original connector name", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "write the result",
        instructions: "Use destination_write for connected destination records.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(fakeAgentState.tools.map((tool) => tool.name)).toEqual(["destination_write"]);
    expect(executeTool).toHaveBeenCalledWith(
      "destination.write",
      { collection: "notes", title: "Result", body: "Done" },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      { connectorId: "destination", toolName: "destination.write" },
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("preserves a connected delete_bot schema and arguments through the runtime", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const tool: ConnectorTool = {
      name: "delete_bot",
      description: "Delete a remote object",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      route: { connectorId: "remote", toolName: "delete_bot" },
    };
    fakeAgentState.invoke = { name: "delete_bot", args: { id: "remote-object" } };
    for await (const _event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "delete the remote object",
        instructions: "",
        history: [],
        tools: [tool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime so its tool call finishes.
    }
    expect(executeTool).toHaveBeenCalledWith(
      "delete_bot",
      { id: "remote-object" },
      expect.any(String),
      tool.route,
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("passes spawn_bot's public description and private instructions to the executor", async () => {
    const spawnBotTool = builtinAgentTools.find((tool) => tool.name === "spawn_bot");
    if (!spawnBotTool) throw new Error("missing spawn_bot");
    fakeAgentState.invoke = {
      name: "use_tool",
      args: {
        name: "spawn_bot",
        arguments: {
          name: "Scout",
          description: "Finds venues.",
          instructions: "Ask before booking anything.",
          computer_mode: "team",
        },
      },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "create a bot named Scout",
        instructions: "",
        history: [],
        tools: [spawnBotTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "spawn_bot",
      expect.objectContaining({
        name: "Scout",
        description: "Finds venues.",
        instructions: "Ask before booking anything.",
      }),
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("creates a bot when the model leaves out the optional computer_mode", async () => {
    const spawnBotTool = builtinAgentTools.find((tool) => tool.name === "spawn_bot");
    if (!spawnBotTool) throw new Error("missing spawn_bot");
    fakeAgentState.invoke = {
      name: "use_tool",
      args: { name: "spawn_bot", arguments: { name: "Scout" } },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "create a bot named Scout",
        instructions: "",
        history: [],
        tools: [spawnBotTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "spawn_bot",
      { name: "Scout", description: "", instructions: "", prompt: "" },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("passes update_bot's read offset through the use_tool wrapper", async () => {
    const updateBotTool = builtinAgentTools.find((tool) => tool.name === "update_bot");
    if (!updateBotTool) throw new Error("missing update_bot");
    fakeAgentState.invoke = {
      name: "use_tool",
      args: { name: "update_bot", arguments: { instructions_offset: 8_000 } },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "read the next page of my instructions",
        instructions: "",
        history: [],
        // A deferred tool exposes use_tool, through which the model names update_bot.
        tools: [updateBotTool, scheduleCancelTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "update_bot",
      { instructions_offset: 8_000 },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("runs schedule tools, remember and request_secret sequentially", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "remind me in ten minutes",
        instructions: "Use schedule_create then schedule_list.",
        history: [],
        tools: [
          scheduleCreateTool,
          scheduleListTool,
          scheduleCancelTool,
          destinationTool,
          builtinAgentTools.find((tool) => tool.name === "remember")!,
          builtinAgentTools.find((tool) => tool.name === "request_secret")!,
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool dispatch completes.
    }

    const modes = new Map(
      fakeAgentState.tools.map((tool) => [tool.name, tool.executionMode ?? "default"]),
    );
    // A concurrent batch can read the routine list before schedule_create writes
    // the row, so the bot reports "no schedules" for a reminder it just made.
    expect(modes.get("schedule_create")).toBe("sequential");
    expect(modes.get("schedule_list")).toBe("sequential");
    // schedule_cancel is deferred, so the use_tool that runs it is sequential.
    expect(modes.get("use_tool")).toBe("sequential");
    expect(modes.get("remember")).toBe("sequential");
    // Two code requests in one batch would each wait on a card that one answer approves.
    expect(modes.get("request_secret")).toBe("sequential");
    expect(modes.get("destination_write")).toBe("default");
  });

  it("does not claim a tool-only turn finished work the model never described", async () => {
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "tool-only",
        prompt: "send the update",
        instructions: "Use the destination tool.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "tool-only",
        traceId: "tool-only",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "progress",
      text: "Using destination_write",
      activity: true,
    });
    expect(events).not.toContainEqual({
      type: "text",
      text: "I finished the work.",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("continues after narration is followed by a silent tool result turn", async () => {
    fakeAgentState.mode = "silent-continuation";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const onToolCompleted = vi.fn();

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "silent-continuation",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
        onToolCompleted,
      },
      {
        operationId: "silent-continuation",
        traceId: "silent-continuation",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toHaveLength(1);
    expect(fakeAgentState.followUpMessages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Continue"),
      }),
    );
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "destination.write",
        executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
        result: expect.objectContaining({ content: expect.any(Array) }),
        durationMs: expect.any(Number),
      }),
    );
    expect(events).toContainEqual({ type: "text", text: "The final answer." });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The final answer.",
    });
  });

  it("does not wait for a slow tool completion hook", async () => {
    let resolveAudit!: () => void;
    const audit = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const onToolCompleted = vi.fn(() => audit);
    let settled = false;
    const runtime = new PiAgentRuntime();
    const run = (async () => {
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "non-blocking-audit",
          prompt: "send the update",
          instructions: "Use the destination tool.",
          history: [],
          tools: [destinationTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool: vi.fn(async () => ({ ok: true })),
          onToolCompleted,
        },
        {
          operationId: "non-blocking-audit",
          traceId: "non-blocking-audit",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        // Exhaust the runtime event stream.
      }
    })().finally(() => {
      settled = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(true);
      expect(onToolCompleted).toHaveBeenCalledOnce();
    } finally {
      resolveAudit();
      await run;
    }
  });

  it("audits a returned connector error after Pi wraps it without changing the model result", async () => {
    const result = { error: "destination rejected the record" };
    const audits: Record<string, unknown>[] = [];
    const onToolCompleted = vi.fn((completion: AgentToolCompletion) => {
      audits.push(toolCompletionAuditPayload(completion));
    });
    for await (const _event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "returned-error",
        prompt: "send the update",
        instructions: "Use the destination tool.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => result),
        onToolCompleted,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the fake agent's runtime event stream; no provider or database is used.
    }
    expect(onToolCompleted).toHaveBeenCalledOnce();
    expect(fakeAgentState.toolResult).toMatchObject({ details: result });
    expect(audits).toEqual([
      expect.objectContaining({
        name: "destination.write",
        outcome: "error",
        error: result.error,
      }),
    ]);
  });

  it("fails a tool turn that never writes a final answer instead of asking to continue", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalAfterFollowUp = false;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const consume = async () => {
      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "silent-fallback",
          prompt: "send the update and report back",
          instructions: "Use the destination tool, then tell the user what happened.",
          history: [],
          tools: [destinationTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool: vi.fn(async () => ({ ok: true })),
        },
        {
          operationId: "silent-fallback",
          traceId: "silent-fallback",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(MISSING_TOOL_FINAL_RESPONSE_ERROR);
    expect(MISSING_TOOL_FINAL_RESPONSE_ERROR.toLowerCase()).not.toContain("continue");
    expect(events).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringMatching(/ask me to continue/i),
      }),
    );
    expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(false);
  });

  it("does not replay a continue prompt into another ask-to-continue reply", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalAfterFollowUp = false;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const consume = async () => {
      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "continue-loop",
          prompt: "continue",
          instructions: "Use the destination tool, then tell the user what happened.",
          history: [
            { role: "user", content: "send the update and report back" },
            {
              role: "assistant",
              content:
                "I completed the tool step but could not produce a final response. Please ask me to continue.",
            },
          ],
          tools: [destinationTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool: vi.fn(async () => ({ ok: true })),
        },
        {
          operationId: "continue-loop",
          traceId: "continue-loop",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(MISSING_TOOL_FINAL_RESPONSE_ERROR);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringMatching(/ask me to continue/i),
      }),
    );
    expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(false);
  });

  it("emits a final answer that arrives only on the completed message after tools", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalOnCompletedMessage = true;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "completed-message-final",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "completed-message-final",
        traceId: "completed-message-final",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "The final answer." });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The final answer.",
    });
  });

  it("keeps a streamed final answer when the completed tool-follow-up message is empty", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalDeltaOnly = true;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "delta-only-final",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "delta-only-final",
        traceId: "delta-only-final",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "The final answer." });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The final answer.",
    });
  });

  it("names a written response when an error stop has no provider message", () => {
    expect(
      providerFailureText({
        role: "assistant",
        content: [{ type: "text", text: "Partial answer." }],
        stopReason: "error",
      }),
    ).toBe("The model failed after writing a response.");
    expect(
      providerFailureText({
        role: "assistant",
        content: [{ type: "text", text: "   " }],
        stopReason: "error",
      }),
    ).toBe("The model failed before writing a response.");
    expect(
      providerFailureText({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "upstream unavailable",
      }),
    ).toBe("upstream unavailable");
  });

  it("fails when tools succeeded and the final assistant content is an empty provider error", async () => {
    fakeAgentState.mode = "tools-then-empty-failure";
    fakeAgentState.terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "length",
      errorMessage: "This model's maximum context length is 131072 tokens.",
    };
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    const consume = async () => {
      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "tools-then-empty-failure",
          prompt: "send the update and report back",
          instructions: "Use the destination tool, then tell the user what happened.",
          history: [],
          tools: [destinationTool],
          model: { provider: "test", id: "dispatch-test-model" },
          emptyResponseText: "The delegated bot completed its turn without a written summary.",
          executeTool: vi.fn(async () => ({ ok: true })),
        },
        {
          operationId: "tools-then-empty-failure",
          traceId: "tools-then-empty-failure",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(
      "This model's maximum context length is 131072 tokens.",
    );
    expect(events).not.toContainEqual({
      type: "text",
      text: "The delegated bot completed its turn without a written summary.",
    });
    expect(events).not.toContainEqual({
      type: "text",
      text: "I completed the tool step but could not produce a final response. Please ask me to continue.",
    });
    expect(fakeAgentState.followUpMessages).toHaveLength(0);
  });

  it("emits final assistant text that arrives only on the completed message after tools", async () => {
    fakeAgentState.mode = "tools-then-final-text";
    fakeAgentState.terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "The inbox has 3 unread notes." }],
      stopReason: "stop",
    };
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "tools-then-final-text",
        prompt: "check the inbox and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "The delegated bot completed its turn without a written summary.",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "tools-then-final-text",
        traceId: "tools-then-final-text",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "The inbox has 3 unread notes.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The inbox has 3 unread notes.",
    });
    expect(events).not.toContainEqual({
      type: "text",
      text: "The delegated bot completed its turn without a written summary.",
    });
  });

  it("keeps a final answer that repeats the tool narration", async () => {
    fakeAgentState.mode = "tools-then-final-text";
    fakeAgentState.narration = "Done.";
    fakeAgentState.terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
    };
    const events: unknown[] = [];

    for await (const event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "repeated-final",
        prompt: "finish and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }

    expect(events.filter((event) => (event as { text?: string }).text === "Done.")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done.Done." });
  });

  it("emits only the final suffix that extends a streamed prefix", async () => {
    fakeAgentState.mode = "tools-then-final-text";
    fakeAgentState.finalDelta = "The inbox";
    fakeAgentState.terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "The inbox has 3 unread notes." }],
      stopReason: "stop",
    };
    const events: unknown[] = [];

    for await (const event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "final-suffix",
        prompt: "check the inbox and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "The inbox" });
    expect(events).toContainEqual({
      type: "text",
      text: " has 3 unread notes.",
    });
    expect(events).not.toContainEqual({
      type: "text",
      text: "The inbox has 3 unread notes.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The inbox has 3 unread notes.",
    });
  });

  it("keeps a repeated suffix that matches the streamed prefix", async () => {
    fakeAgentState.mode = "tools-then-final-text";
    fakeAgentState.finalDelta = "abc";
    fakeAgentState.terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "abcabc" }],
      stopReason: "stop",
    };
    const events: unknown[] = [];

    for await (const event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "repeated-suffix",
        prompt: "check the inbox and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }

    expect(events.filter((event) => (event as { text?: string }).text === "abc")).toHaveLength(2);
    expect(events).not.toContainEqual({ type: "text", text: "abcabc" });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.abcabc",
    });
  });

  it("allows a silent empty completion after tools when allowSilentEmpty is set", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalAfterFollowUp = false;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "routine-silent-tools",
        prompt: "If nothing to report, produce no message.",
        instructions: "Stay silent when the inbox is empty.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "routine-silent-tools",
        traceId: "routine-silent-tools",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    const followUp = fakeAgentState.followUpMessages[0] as {
      role: string;
      content: string;
    };
    expect(followUp).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("stay silent"),
      }),
    );
    expect(followUp.content).not.toContain("NO_RESPONSE");
    expect(events).not.toContainEqual({
      type: "text",
      text: MISSING_TOOL_FINAL_RESPONSE_ERROR,
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("keeps FYI bot-message wakes silent when the model produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "bot-wake-silent",
        prompt: "[bot] FYI only",
        instructions: "Stay silent when there is nothing to do.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "bot-wake-silent",
        traceId: "bot-wake-silent",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).not.toContainEqual({
      type: "text",
      text: "No response. Try again.",
    });
    expect(events).toEqual([{ type: "done" }]);
  });

  it("still asks the user to retry when a normal empty turn produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "user-empty",
        prompt: "hello",
        instructions: "Reply to the user.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "user-empty",
        traceId: "user-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "No response. Try again.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "No response. Try again.",
    });
  });

  it("surfaces a contextual peer fallback when that run produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-empty",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "Update from Researcher: The answer is 42.",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-empty",
        traceId: "peer-result-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "Update from Researcher: The answer is 42.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "Update from Researcher: The answer is 42.",
    });
  });

  it("normalizes a blank contextual fallback", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-blank",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "   ",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-blank",
        traceId: "peer-result-blank",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "done",
      text: "No response. Try again.",
    });
  });

  it("allows more than 80 tool calls by default when no fuse is configured", async () => {
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "unlimited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2a",
        traceId: "2a",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(100);
    expect(fakeAgentState.abortCount).toBe(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining("tool calls in one turn"),
      }),
    );
  });

  it("soft-stops with a final message when MAX_TOOL_CALLS_PER_TURN is set", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "parent-limited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2b",
        traceId: "2b",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(80);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
  });

  it("ends the run with the reply a terminating tool result carries", async () => {
    fakeAgentState.mode = "terminating-tool";
    const terminatingReply = OWNER_SETTINGS_REFUSAL_REPLY;
    const executeTool = vi.fn(async () =>
      terminatingToolResult(terminatingReply, { refused: "owner-settings" }),
    );
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "terminated",
        prompt: "change your model",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2c",
        traceId: "2c",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.toolResult).toMatchObject({ terminate: true });
    expect(events).toContainEqual({ type: "text", text: terminatingReply });
    expect(events.at(-1)).toEqual({ type: "done", text: terminatingReply });
  });

  it.each([true, false])(
    "requires internal provenance to end a restored turn (trusted: %s)",
    async (trusted) => {
      const terminatingReply = OWNER_SETTINGS_REFUSAL_REPLY;
      const executed: string[] = [];
      const executeTool = vi.fn(async (name: string) => {
        executed.push(name);
        if (name !== "update_bot") return { ok: true };
        const result = terminatingToolResult(terminatingReply, { refused: "owner-settings" });
        return trusted ? result : JSON.parse(JSON.stringify(result));
      });
      const checkpoint = serializeTurnCheckpoint({
        version: 1,
        provider: "test",
        model: "dispatch-test-model",
        systemPrompt: "You are a test bot.",
        pendingToolCallId: "call-1",
        executionMode: "sequential",
        messages: [
          { role: "user", content: "change your model", timestamp: new Date(0) },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "update_bot",
                arguments: { notifyOnFinish: false },
              },
              { type: "toolCall", id: "call-2", name: "list_files", arguments: { path: "" } },
            ],
            stopReason: "toolUse",
          },
        ] as never,
      });
      const runtime = new PiAgentRuntime();
      const events: unknown[] = [];

      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "replay-terminated",
          prompt: "resume the turn",
          instructions: "Use update_bot.",
          history: [],
          tools: [updateBotTool, listFilesTool],
          model: { provider: "test", id: "dispatch-test-model" },
          turnCheckpoint: checkpoint,
          executeTool,
        },
        { signal: new AbortController().signal },
      )) {
        events.push(event);
      }

      expect(executed).toEqual(trusted ? ["update_bot"] : ["update_bot", "list_files"]);
      expect(fakeAgentState.continueCalls).toBe(trusted ? 0 : 1);
      expect(events.at(-1)).toEqual({
        type: "done",
        text: trusted ? terminatingReply : "Trying again anyway.",
      });
    },
  );

  it("keeps a restored turn paused, without a final reply, when a replayed call pauses", async () => {
    const executed: string[] = [];
    const executeTool = vi.fn(async (name: string) => {
      executed.push(name);
      return name === "update_bot" ? approvalPausedToolResult() : { ok: true };
    });
    const checkpoint = serializeTurnCheckpoint({
      version: 1,
      provider: "test",
      model: "dispatch-test-model",
      systemPrompt: "You are a test bot.",
      pendingToolCallId: "call-1",
      executionMode: "sequential",
      messages: [
        { role: "user", content: "change your model", timestamp: new Date(0) },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "update_bot",
              arguments: { notifyOnFinish: false },
            },
            { type: "toolCall", id: "call-2", name: "list_files", arguments: { path: "" } },
          ],
          stopReason: "toolUse",
        },
      ] as never,
    });
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "replay-paused",
        prompt: "resume the turn",
        instructions: "Use update_bot.",
        history: [],
        tools: [updateBotTool, listFilesTool],
        model: { provider: "test", id: "dispatch-test-model" },
        turnCheckpoint: checkpoint,
        executeTool,
      },
      { signal: new AbortController().signal },
    )) {
      events.push(event);
    }

    expect(executed).toEqual(["update_bot"]);
    expect(fakeAgentState.continueCalls).toBe(0);
    expect(events).not.toContainEqual({ type: "text", text: "Waiting for approval." });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("shares an optional tool-call fuse with subagents and still emits a final message", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
    fakeAgentState.mode = "subagent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "limited",
        prompt: "delegate the loop",
        instructions: "Use run_subagent.",
        history: [],
        tools: [
          {
            name: "run_subagent",
            description: "Delegate work",
            inputSchema: { type: "object", properties: {} },
          },
          shellTool,
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2",
        traceId: "2",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(79);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events).toContainEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    const subagentEvents = events.filter(
      (event): event is { type: "subagent"; status: string; result?: string } =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event as { type?: string }).type === "subagent",
    );
    expect(subagentEvents.some((event) => event.status === "failed")).toBe(false);
    expect(subagentEvents).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result:
          "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
      }),
    );
  });

  it("hands a background helper to the executor instead of running it inside the turn", async () => {
    fakeAgentState.mode = "background-subagent";
    const executeTool = vi.fn(async () => ({ ok: true, name: "scout" }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "background-helper",
        prompt: "look into the venues in the background",
        instructions: "",
        history: [],
        tools: [
          {
            name: "run_subagent",
            description: "Delegate work",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "bg",
        traceId: "bg",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    ))
      events.push(event);
    const calls = executeTool.mock.calls as unknown as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual([
      "run_subagent",
      expect.objectContaining({ name: "scout", task: "compare the venues", background: true }),
    ]);
    // No helper ran inside this turn.
    expect(events.filter((event) => (event as { type?: string }).type === "subagent")).toEqual([]);
  });

  it("caps a parent and two concurrent subagents at one total, then gives a later run a fresh budget", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "50";
    fakeAgentState.mode = "two-subagents";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const request = {
      botId: "b",
      threadId: "t",
      runId: "tree-limited",
      prompt: "delegate twice",
      instructions: "Use run_subagent.",
      history: [],
      tools: [
        {
          name: "run_subagent",
          description: "Delegate work",
          inputSchema: { type: "object", properties: {} },
        },
        shellTool,
      ],
      model: { provider: "test", id: "dispatch-test-model" },
      executeTool,
    };
    const context = {
      operationId: "2j",
      traceId: "2j",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const stopText =
      "I stopped after reaching the limit of 50 tool calls in this turn. Send another message to continue.";

    const first: unknown[] = [];
    for await (const event of runtime.run(request, context)) first.push(event);
    // 2 run_subagent calls + shell calls from both children never exceed the cap in total.
    expect(executeTool).toHaveBeenCalledTimes(48);
    expect(first.at(-1)).toEqual({ type: "done", text: stopText });
    expect(first.filter((e) => (e as { status?: string }).status === "failed")).toHaveLength(0);

    // The budget was released: the same run id starts at zero again.
    executeTool.mockClear();
    const second: unknown[] = [];
    for await (const event of runtime.run(request, context)) second.push(event);
    expect(executeTool).toHaveBeenCalledTimes(48);
    expect(second.at(-1)).toEqual({ type: "done", text: stopText });
  });

  it("treats unset, empty, and non-positive MAX_TOOL_CALLS_PER_TURN as unlimited", () => {
    expect(maxToolCallsPerTurn({})).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "0" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "-5" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "abc" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "80" })).toBe(80);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: " 12.9 " })).toBe(12);
  });

  it("lets a parallel tool batch finish before the optional fuse aborts", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "2";
    fakeAgentState.mode = "parent-parallel";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "parallel-fuse",
        prompt: "run them together",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2c",
        traceId: "2c",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 2 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across a second run() for the same runId", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "5";
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const abort = new AbortController();
    let started = 0;
    executeTool.mockImplementation(async () => {
      started += 1;
      if (started === 2) abort.abort();
      return { ok: true };
    });

    await expect(async () => {
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "fuse-resume",
          prompt: "keep going",
          instructions: "Use shell.",
          history: [],
          tools: [shellTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        {
          operationId: "2d",
          traceId: "2d",
          spaceId: "w",
          userId: "u",
          signal: abort.signal,
        },
      )) {
        // Exhaust until abort fails the turn.
      }
    }).rejects.toThrow();

    executeTool.mockImplementation(async () => ({ ok: true }));
    const events: unknown[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "fuse-resume",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2e",
        traceId: "2e",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 5 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across ask_user pause and continueRun", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "4";
    fakeAgentState.mode = "ask-pause";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const request = {
      botId: "b",
      threadId: "t",
      runId: "fuse-ask-pause",
      prompt: "keep going",
      instructions: "Use shell, then ask.",
      history: [],
      tools: [
        shellTool,
        {
          name: "ask_user",
          description: "Ask a short multiple-choice question",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      model: { provider: "test", id: "dispatch-test-model" },
      executeTool,
    };

    for await (const event of runtime.run(request, {
      operationId: "2f",
      traceId: "2f",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which option?",
      }),
    );

    fakeAgentState.mode = "parent-limit";
    const resumed: unknown[] = [];
    for await (const event of runtime.run(
      {
        ...request,
        tools: [shellTool],
      },
      {
        operationId: "2g",
        traceId: "2g",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      resumed.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(resumed).toContainEqual({
      type: "progress",
      text: "Stopped: more than 4 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across nested ask_user pause and continueRun", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "4";
    fakeAgentState.mode = "nested-ask-pause";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const request = {
      botId: "b",
      threadId: "t",
      runId: "fuse-nested-ask-pause",
      prompt: "delegate then ask",
      instructions: "Use a subagent.",
      history: [],
      tools: [
        {
          name: "run_subagent",
          description: "Delegate work",
          inputSchema: { type: "object", properties: {} },
        },
        shellTool,
        {
          name: "ask_user",
          description: "Ask a short multiple-choice question",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      model: { provider: "test", id: "dispatch-test-model" },
      executeTool,
    };

    for await (const event of runtime.run(request, {
      operationId: "2h",
      traceId: "2h",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which option?",
      }),
    );

    fakeAgentState.mode = "parent-limit";
    const resumed: unknown[] = [];
    for await (const event of runtime.run(
      {
        ...request,
        tools: [shellTool],
      },
      {
        operationId: "2i",
        traceId: "2i",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      resumed.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(resumed).toContainEqual({
      type: "progress",
      text: "Stopped: more than 4 tool calls in one turn.",
    });
  });

  it("clips structured tool results to one aggregate text budget", async () => {
    const first = "a".repeat(TOOL_RESULT_TEXT_LIMIT - 5);
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
    };
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [
        { type: "text" as const, text: first },
        image,
        { type: "text" as const, text: "bbbbbbbbbb" },
        { type: "text" as const, text: "omit me" },
      ],
      details: { ok: true },
    }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "clip-multipart",
        prompt: "write it",
        instructions: "Use the destination.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "clip",
        traceId: "2h",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust so the fake agent executes the tool.
    }

    const result = fakeAgentState.toolResult as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ type: "text", text: first });
    expect(result.content[1]).toEqual(image);
    expect(result.content[2]).toEqual({ type: "text", text: "bbbbb…" });
  });

  it("delivers a skill read larger than the tool result bound verbatim", async () => {
    const skill = {
      name: "large-skill",
      description: "Large skill",
      source: "user",
      readOnly: false,
      content: `---\nname: large-skill\n---\n${"1. Step kept for skill_update.\n".repeat(600)}`,
    };
    fakeAgentState.invoke = { name: "skill_read", args: { name: skill.name } };
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "large-skill",
        prompt: "edit the skill",
        instructions: "Read the skill before updating it.",
        history: [],
        tools: [
          {
            name: "skill_read",
            description: "Load a skill by exact name",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
          },
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => skill),
      },
      {
        operationId: "large-skill",
        traceId: "large-skill",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust so the fake agent executes the tool.
    }

    const result = fakeAgentState.toolResult as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text.length).toBeGreaterThan(TOOL_RESULT_TEXT_LIMIT);
    expect(JSON.parse(result.content[0]!.text)).toEqual(skill);
  });

  it("delivers full child instructions and their version past the tool result bound", async () => {
    const listing = {
      bot: { id: "child", instructionsVersion: "v2", instructions: "x".repeat(20_000) },
      bots: [],
      groups: [],
      sections: [],
      truncated: false,
    };
    fakeAgentState.invoke = {
      name: "use_tool",
      args: { name: "list_fleet", arguments: { bot_id: "child" } },
    };
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "large-child",
        prompt: "edit the child",
        instructions: "Read the child before updating it.",
        history: [],
        tools: [
          {
            name: "list_fleet",
            description: "Read a child by id",
            inputSchema: { type: "object", properties: { bot_id: { type: "string" } } },
          },
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => listing),
      },
      {
        operationId: "large-child",
        traceId: "large-child",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust so the fake agent executes the tool.
    }

    const result = fakeAgentState.toolResult as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text.length).toBeGreaterThan(TOOL_RESULT_TEXT_LIMIT);
    expect(JSON.parse(result.content[0]!.text)).toEqual(listing);
  });

  it("serialises object content instead of writing [object Object] for write_file", async () => {
    fakeAgentState.invoke = {
      name: "write_file",
      args: { path: "shared/state.json", content: { last_run: 1_787_648_953 } },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "save the state file",
        instructions: "Use write_file to save state.",
        history: [],
        tools: [writeFileTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "3",
        traceId: "3",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "write_file",
      {
        path: "shared/state.json",
        content: '{\n  "last_run": 1787648953\n}',
      },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );
  });

  it("keeps read_file's positive-integer offset and limit and drops invalid ones", async () => {
    const readFileTool = builtinAgentTools.find((tool) => tool.name === "read_file");
    if (!readFileTool) throw new Error("missing read_file");
    const executeTool = vi.fn(async () => ({ path: "docs/reference.txt", content: "line" }));
    const runtime = new PiAgentRuntime();
    const dispatch = async (args: Record<string, unknown>) => {
      fakeAgentState.invoke = { name: "read_file", args };
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "read-file-range",
          prompt: "read the reference file",
          instructions: "Use read_file.",
          history: [],
          tools: [readFileTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        { signal: new AbortController().signal },
      )) {
        // Exhaust the runtime event stream so tool dispatch completes.
      }
    };

    await dispatch({ path: "docs/reference.txt", offset: 40, limit: 60 });
    expect(executeTool).toHaveBeenCalledWith(
      "read_file",
      { path: "docs/reference.txt", offset: 40, limit: 60 },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );

    executeTool.mockClear();
    await dispatch({ path: "docs/reference.txt", offset: 0, limit: "60" });
    expect(executeTool).toHaveBeenCalledWith(
      "read_file",
      { path: "docs/reference.txt" },
      JSON.stringify(["pi-tool", "main", "call-1"]),
      undefined,
      { onShellStillRunning: expect.any(Function) },
    );
  });
});
