import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentOptions } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  CredentialStore,
  Model,
  ModelThinkingLevel,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import {
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_REQUEST_LIMIT_ERROR,
  normalizeRunError,
} from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  credentialStores: [] as unknown[],
  stream: vi.fn(),
  agentOptions: undefined as AgentOptions | undefined,
  agent: undefined as AgentCore.Agent | undefined,
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agentOptions = options;
        providerState.agent = this;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (options?: { credentials?: unknown }) => {
    if (options?.credentials) providerState.credentialStores.push(options.credentials);
    return {
      getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
      streamSimple: (...args: unknown[]) => providerState.stream(...args),
    };
  },
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { estimateModelContextTokens } from "./model-context.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MESSAGE } from "./pi-runtime-stream.js";
import { PiJsonlSessionRecorder } from "./pi-session.js";
import { sharedTokenPacer } from "./token-pacer.js";

const primary = model("provider-a", "primary", 32_768);
const backupA = model("provider-b", "backup-a", 8_192);
const backupB = model("provider-c", "backup-b", 16_384);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(_target: Model<"openai-completions">, response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({
      type: "error",
      reason: response.stopReason,
      error: response,
    });
  } else if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call,
        partial: response,
      });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function countContextImages(context: { messages?: unknown[] }): number {
  let count = 0;
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object" || !("content" in message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    count += content.filter(
      (part) =>
        part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image",
    ).length;
  }
  return count;
}

function request(fallbackModels: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "write_effect",
        description: "Write one external effect.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        readOnly: false,
      },
    ],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-primary-key" },
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(
  input: AgentRunRequest,
  events: AgentRuntimeEvent[] = [],
  runtime = new PiAgentRuntime(),
) {
  for await (const event of runtime.run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.credentialStores.length = 0;
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.agentOptions = undefined;
  providerState.agent = undefined;
  vi.restoreAllMocks();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Pi runtime transient model retries", () => {
  it("recovers one empty idle stream after the header retry budget expires", async () => {
    vi.useFakeTimers();
    providerState.delay.mockImplementation(async (delay) => {
      vi.setSystemTime(Date.now() + delay);
    });
    providerState.stream
      .mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + MODEL_STREAM_IDLE_TIMEOUT_MS);
        return stream(primary, message(primary, [], "error", MODEL_STREAM_IDLE_TIMEOUT_MESSAGE));
      })
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    expect(await run(request())).toContainEqual({ type: "text", text: "Recovered." });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
    expect(providerState.stream.mock.calls[1]?.[2].timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS - 2_000);
  });

  it("caps idle recovery at one retry even when failures arrive before the idle bound", async () => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", MODEL_STREAM_IDLE_TIMEOUT_MESSAGE)),
    );
    await expect(run(request())).rejects.toThrow(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
  });

  it("recovers idle after a completed tool without replaying the effect", async () => {
    vi.useFakeTimers();
    const input = request();
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "effect-once",
                name: "write_effect",
                arguments: { value: "once" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + MODEL_STREAM_IDLE_TIMEOUT_MS);
        return stream(primary, message(primary, [], "error", MODEL_STREAM_IDLE_TIMEOUT_MESSAGE));
      })
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Complete." }], "stop")),
      );
    expect(await run(input)).toContainEqual({ type: "text", text: "Complete." });
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(providerState.stream.mock.calls[2]?.[1].messages)).toContain(
      "effect-once",
    );
  });

  it("does not renew the idle recovery budget again for an ordinary timeout", async () => {
    vi.useFakeTimers();
    providerState.stream.mockImplementation((_target, _context, options) => {
      vi.setSystemTime(
        Date.now() +
          (providerState.stream.mock.calls.length === 1
            ? MODEL_STREAM_IDLE_TIMEOUT_MS
            : options.timeoutMs),
      );
      const error =
        providerState.stream.mock.calls.length === 1
          ? MODEL_STREAM_IDLE_TIMEOUT_MESSAGE
          : "Request timed out.";
      return stream(primary, message(primary, [], "error", error));
    });
    await expect(run(request())).rejects.toThrow(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).toHaveBeenCalledOnce();
  });

  it("does not recover idle after partial text", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: "partial" }];
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, content, "error", MODEL_STREAM_IDLE_TIMEOUT_MESSAGE)),
    );
    await expect(run(request())).rejects.toThrow(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each([
    "terminated",
    "Stream ended without finish_reason",
    "Codex error: Our servers are currently overloaded. Please try again later.",
    "Connection error.",
    "Request timed out.",
  ])(
    "recovers from two pre-output failures with %s and commits one assistant message",
    async (error) => {
      providerState.stream
        .mockImplementationOnce(() => stream(primary, message(primary, [], "error", error)))
        .mockImplementationOnce(() => stream(primary, message(primary, [], "error", error)))
        .mockImplementation(() =>
          stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
        );
      const appendMessage = vi.fn(async (_entry: AgentMessage) => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events = await run(
        request(),
        [],
        new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
      );
      expect(providerState.stream).toHaveBeenCalledTimes(3);
      expect(providerState.stream.mock.calls.map(([target]) => target)).toEqual([
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
      ]);
      expect(events.filter((event) => event.type === "text")).toEqual([
        { type: "text", text: "Recovered." },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
      expect(appendMessage.mock.calls.filter(([entry]) => entry.role === "assistant")).toEqual([
        [
          expect.objectContaining({
            stopReason: "stop",
            content: [{ type: "text", text: "Recovered." }],
          }),
        ],
      ]);
      expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
    },
  );

  it.each([
    "HTTP 403; servers are overloaded",
    "permission denied; terminated",
    "context_length_exceeded; 503 overloaded",
    "bad request; terminated",
  ])("does not retry or switch on %s", async (error) => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", error)),
    );
    await expect(
      run(request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }])),
    ).rejects.toThrow(error);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("exhausts three retries without a backup and preserves the first provider error", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementation(() =>
        stream(primary, message(primary, [], "error", "HTTP 503 unavailable")),
      );
    await expect(run(request())).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000, 20_000]);
  });

  it.each(["Request timed out.", "Connection error.", "HTTP 503 unavailable"])(
    "does not retry %s after the request budget is spent",
    async (error) => {
      vi.useFakeTimers();
      const pending = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(pending);
      const outcome = run(request()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS);
      const failure = message(primary, [], "error", error);
      pending.push({ type: "error", reason: "error", error: failure });
      pending.end(failure);
      expect(await outcome).toEqual(expect.objectContaining({ message: error }));
      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it("retries within the configured request budget", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "240000");
    const pending = new AssistantMessageEventStream();
    providerState.stream
      .mockReturnValueOnce(pending)
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    const outcome = run(request());
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS);
    const failure = message(primary, [], "error", "Request timed out.");
    pending.push({ type: "error", reason: "error", error: failure });
    pending.end(failure);
    expect(await outcome).toContainEqual({ type: "text", text: "Recovered." });
    expect(providerState.stream.mock.calls[1]?.[2].timeoutMs).toBe(
      240_000 - MODEL_STREAM_TIMEOUT_MS,
    );
  });

  it("bounds repeated early timeouts by elapsed request budget", async () => {
    vi.useFakeTimers();
    const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
    providerState.delay.mockImplementation(abortableDelay);
    providerState.stream.mockImplementation((_target, _context, options) => {
      const pending = new AssistantMessageEventStream();
      setTimeout(
        () => {
          const failure = message(primary, [], "error", "Request timed out.");
          pending.push({ type: "error", reason: "error", error: failure });
          pending.end(failure);
        },
        Math.min(MODEL_STREAM_TIMEOUT_MS / 2, options.timeoutMs),
      );
      return pending;
    });
    const outcome = run(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS);
    expect(providerState.stream.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([
      MODEL_STREAM_TIMEOUT_MS,
      MODEL_STREAM_TIMEOUT_MS / 2 - 2_000,
    ]);
    expect(await outcome).toEqual(expect.objectContaining({ message: "Request timed out." }));
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not back off when the delay would consume the remaining budget", async () => {
    vi.useFakeTimers();
    const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
    providerState.delay.mockImplementation(abortableDelay);
    providerState.stream.mockImplementation(() => {
      const pending = new AssistantMessageEventStream();
      setTimeout(() => {
        const failure = message(primary, [], "error", "Request timed out.");
        pending.push({ type: "error", reason: "error", error: failure });
        pending.end(failure);
      }, 30_000);
      return pending;
    });
    const outcome = run(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
    expect(await outcome).toEqual(expect.objectContaining({ message: "Request timed out." }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the budget when backoff wakes after the deadline", async () => {
    vi.useFakeTimers();
    providerState.delay.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + MODEL_STREAM_TIMEOUT_MS);
    });
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "Connection error.")),
    );
    await expect(run(request())).rejects.toThrow("Connection error.");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).toHaveBeenCalledOnce();
  });

  it("surfaces a non-retryable error encountered after a transient failure", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementation(() => stream(primary, message(primary, [], "error", "invalid api key")));
    await expect(run(request())).rejects.toThrow("invalid api key");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
  });

  it.each([
    "terminated",
    "Stream ended without finish_reason",
    "Request timed out.",
    "Connection error.",
    MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
  ])("redoes a call that failed with %s mid tool call, before any text", async (error) => {
    const partialCall = {
      type: "toolCall" as const,
      id: "dropped-call",
      name: "write_effect",
      arguments: { value: "half" },
    };
    const failure = message(primary, [partialCall], "error", error);
    const started = { ...failure, content: [], stopReason: "stop" as const };
    providerState.stream
      .mockImplementationOnce(() => {
        const result = new AssistantMessageEventStream();
        result.push({ type: "start", partial: started });
        result.push({ type: "thinking_start", contentIndex: 0, partial: started });
        result.push({ type: "toolcall_start", contentIndex: 1, partial: failure });
        result.push({
          type: "toolcall_delta",
          contentIndex: 1,
          delta: '{"value":"ha',
          partial: failure,
        });
        result.push({ type: "error", reason: "error", error: failure });
        result.end(failure);
        return result;
      })
      .mockImplementationOnce((target: Model<"openai-completions">) =>
        stream(
          target,
          message(
            target,
            [
              {
                type: "toolCall",
                id: "whole-call",
                name: "write_effect",
                arguments: { value: "whole" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [{ type: "text", text: "Done." }], "stop")),
      );
    const appendMessage = vi.fn(async (_entry: AgentMessage) => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);

    const events = await run(input, [], new PiAgentRuntime({ sessionRoot: "fixture-sessions" }));

    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(vi.mocked(input.executeTool!).mock.calls.map(([, args]) => args)).toEqual([
      { value: "whole" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    // The dropped call leaves nothing behind: no assistant message and no tool activity.
    const assistantEntries = appendMessage.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.role === "assistant");
    expect(assistantEntries).toHaveLength(2);
    expect(JSON.stringify(assistantEntries)).not.toContain("dropped-call");
    expect(
      events.filter((event) => event.type === "progress" && event.text && event.activity),
    ).toHaveLength(1);
  });

  it("keeps a failure mid tool call terminal once reply text was shown", async () => {
    const failure = message(
      primary,
      [
        { type: "text", text: "Saving it now." },
        { type: "toolCall", id: "dropped-call", name: "write_effect", arguments: {} },
      ],
      "error",
      "terminated",
    );
    providerState.stream.mockImplementation(() => {
      const result = new AssistantMessageEventStream();
      const started = { ...failure, content: [], stopReason: "stop" as const };
      result.push({ type: "start", partial: started });
      result.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "Saving it now.",
        partial: failure,
      });
      result.push({ type: "toolcall_start", contentIndex: 1, partial: failure });
      result.push({ type: "error", reason: "error", error: failure });
      result.end(failure);
      return result;
    });
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);

    await expect(run(input)).rejects.toThrow("terminated");

    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it("retries the same model for a helper agent without configured backups", async () => {
    const input = request();
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "retry-helper",
                name: "run_subagent",
                arguments: { name: "helper", task: "Summarize the fixture." },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "503 overloaded")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [{ type: "text", text: "Helper result." }], "stop")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Complete." }], "stop")),
      );
    const events = await run(input);
    expect(providerState.stream).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent", status: "completed", result: "Helper result." }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Complete." });
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
  });

  it("waits for each bounded backoff before retrying", async () => {
    vi.useFakeTimers();
    const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
    providerState.delay.mockImplementation(abortableDelay);
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "429 rate limit")),
    );
    const outcome = run(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [2_000, 8_000, 20_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 2);
    }
    expect(await outcome).toEqual(expect.objectContaining({ message: "429 rate limit" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { source: "run", error: "429 rate limit" },
    { source: "turn", error: "429 rate limit" },
    { source: "run", error: "Request timed out." },
    { source: "turn", error: "Request timed out." },
    { source: "run", error: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE },
    { source: "turn", error: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE },
  ])(
    "stops promptly when the $source signal aborts during $error backoff",
    async ({ source, error }) => {
      vi.useFakeTimers();
      const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
      providerState.delay.mockImplementation(abortableDelay);
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", error)),
      );
      const controller = new AbortController();
      const input = request();
      const events: AgentRuntimeEvent[] = [];
      const consume = async () => {
        for await (const event of new PiAgentRuntime().run(input, { signal: controller.signal })) {
          events.push(event);
        }
        return undefined;
      };
      const outcome = consume().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(providerState.delay).toHaveBeenCalled();
      const attempts = providerState.stream.mock.calls.length;
      if (source === "run") controller.abort();
      else providerState.agent?.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/abort|stop/i) }),
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(providerState.stream).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("Pi runtime ordered model fallback", () => {
  it.each(["absent", "empty"])(
    "passes the original stream options and terminal content through with %s backups",
    async (backups) => {
      const initialStream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(initialStream);
      const input = request();
      if (backups === "absent") delete input.fallbackModels;
      const initialRun = run(input);
      await vi.waitFor(() => expect(providerState.stream).toHaveBeenCalledOnce());
      const agentOptions = providerState.agentOptions;
      if (!agentOptions) throw new Error("Agent was not created");
      expect(await agentOptions.getApiKey?.(primary.provider)).toBe("fake-primary-key");

      const upstream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(upstream);
      const signal = new AbortController().signal;
      const options = {
        apiKey: "caller-key",
        reasoning: "high" as const,
        maxTokens: 123,
        timeoutMs: 456,
        maxRetries: 2,
        headers: { "x-fixture": "unchanged" },
        signal,
      };
      const response = await agentOptions.streamFn(
        primary,
        { messages: [] } as unknown as TranscriptContext,
        options,
      );
      const iterator = response[Symbol.asyncIterator]();
      const first = iterator.next();
      const failure = message(
        primary,
        [{ type: "text", text: "partial result" }],
        "error",
        "503 overloaded",
      );
      const start = { type: "start" as const, partial: { ...failure, content: [] } };
      upstream.push(start);
      let started = false;
      void first.then(() => {
        started = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toBe(false);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject(options);
      upstream.push({ type: "error", reason: "error", error: failure });
      upstream.end(failure);
      expect((await first).value).toBe(start);
      expect((await iterator.next()).value).toEqual({
        type: "error",
        reason: "error",
        error: failure,
      });
      expect(await response.result()).toBe(failure);
      const initialMessage = message(primary, [{ type: "text", text: "healthy" }], "stop");
      initialStream.push({ type: "done", reason: "stop", message: initialMessage });
      initialStream.end(initialMessage);
      await initialRun;
    },
  );

  it("preserves OAuth getApiKey behavior with no backup list", async () => {
    const input = request();
    delete input.fallbackModels;
    delete input.model.apiKey;
    input.model.oauth = {
      credential: {
        type: "oauth",
        access: "fake-user-access",
        refresh: "fake-user-refresh",
        expires: Date.now() + 60_000,
      },
    };
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "answer" }], "stop")),
    );
    await run(input);
    expect(await providerState.agentOptions?.getApiKey?.(primary.provider)).toBeUndefined();
    expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({ apiKey: undefined });
  });

  it("skips a backup with no user credential even when a process key is set", async () => {
    const unconnected = model("openrouter", "unconnected", 16_384);
    providerState.models.set(
      `${unconnected.provider}/${unconnected.id}`,
      unconnected as unknown as Record<string, unknown>,
    );
    vi.stubEnv("OPENROUTER_API_KEY", "fake-process-key");
    try {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate limit"))
          : stream(target, message(target, [{ type: "text", text: "backup" }], "stop")),
      );
      await run(
        request([
          { provider: unconnected.provider, id: unconnected.id },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-user-backup-key" },
        ]),
      );
      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([primary.provider, backupB.provider]);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({
        apiKey: "fake-user-backup-key",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "bills configured model ids with switched=%s despite provider response ids",
    async (switched) => {
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "reservation");
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
      const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
      const input = request(
        switched ? [{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }] : [],
      );
      input.onUsage = onUsage;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        const failure = switched && target.provider === primary.provider;
        const result = message(
          target,
          failure ? [] : [{ type: "text", text: "answer" }],
          failure ? "error" : "stop",
          failure ? "429 rate limit" : undefined,
        );
        result.provider = "reported-provider";
        result.model = "reported-model";
        result.responseModel = "reported-model-2026-10-08";
        return stream(target, result);
      });
      const events = await run(
        input,
        [],
        new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
      );
      const targets = switched ? [primary, backupA] : [primary];
      expect(beforeCall.mock.calls.map(([call]) => call)).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, modelId: target.id }),
        ),
      );
      expect(onUsage.mock.calls.map(([event]) => event)).toEqual(
        targets.map((target) =>
          expect.objectContaining({
            provider: target.provider,
            model: target.id,
            inputTokens: 4,
            outputTokens: 2,
          }),
        ),
      );
      expect(afterCall).toHaveBeenCalledTimes(targets.length);
      expect(events.filter((event) => event.type === "usage")).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, model: target.id, accounted: true }),
        ),
      );
    },
  );

  it.each(["reservation", "accounting"])(
    "does not fail over on a local %s timeout",
    async (phase) => {
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const localError = new Error("503 local billing timeout");
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      if (phase === "accounting")
        input.onUsage = async () => {
          throw localError;
        };
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", "429 provider rate limit")),
      );
      await expect(
        run(
          input,
          [],
          new PiAgentRuntime({
            modelCallObserver: { beforeCall, afterCall: async () => undefined },
          }),
        ),
      ).rejects.toThrow(/local billing timeout/);
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      expect(beforeCall).toHaveBeenCalledTimes(1);
    },
  );

  it("advances after a provider stream throws before output", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error("503 provider unavailable");
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("completes on the backup when the primary throws a Kimi 403 usage-limit error", async () => {
    const kimiUsageLimit =
      '403 {"error":{"type":"permission_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"},"type":"error"}';
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error(kimiUsageLimit);
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("completes on the backup when the primary reports a ChatGPT usage limit", async () => {
    const chatGptUsageLimit =
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", chatGptUsageLimit))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("uses the configured backup for an explicit insufficient-balance error", async () => {
    const balanceError =
      '402: {"message":"Insufficient Balance","type":"insufficient_balance_error","code":"invalid_request_error"}';
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", balanceError))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each([
    [
      "400 insufficient credits",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have insufficient credits to make this request. Please purchase more credits to continue using the service."}}',
    ],
    ["403 quota exceeded", "403 Quota exceeded for this account."],
  ])("moves to the configured backup on an exhausted account: %s", async (_label, error) => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", error))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each([
    '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
    "401 You have insufficient credits to make this request.",
    "invalid_api_key: Incorrect API key provided",
  ])(
    "moves to the configured backup without a retry on a rejected credential: %s",
    async (error) => {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", error))
          : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
      );
      const events = await run(
        request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
      );
      expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
      expect(providerState.stream.mock.calls.map(([target]) => target.provider)).toEqual([
        primary.provider,
        backupA.provider,
      ]);
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it("fails on a rejected credential without retrying when no backup is configured", async () => {
    const error = "401 OAuth access token has been revoked.";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", error)),
    );
    await expect(run(request())).rejects.toThrow(error);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each(["400 invalid_request_error: Invalid parameter: credits must be a positive integer."])(
    "does not switch to the backup on a non-exhaustion 4xx: %s",
    async (error) => {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", error)),
      );
      await expect(
        run(request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }])),
      ).rejects.toThrow();
      expect(providerState.stream.mock.calls.map(([target]) => target.provider)).toEqual([
        primary.provider,
      ]);
    },
  );

  it("retries a short usage window on the same model without a backup", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [],
            "error",
            "429 You have hit your usage limit for requests per minute; retry after 1 second.",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    const events = await run(request());
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.stream.mock.calls.map(([target]) => target)).toEqual([
      expect.objectContaining({ provider: primary.provider, id: primary.id }),
      expect.objectContaining({ provider: primary.provider, id: primary.id }),
    ]);
    expect(providerState.delay).toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
  });

  it.each([
    "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.",
    '403 {"error":{"type":"permission_error","message":"You\'ve reached your 5-hour usage limit."}}',
    "402 provider quota exhausted",
    '402: {"message":"Insufficient Balance","type":"insufficient_balance_error","code":"invalid_request_error"}',
    "400 You have insufficient credits to make this request.",
  ])(
    "does not retry the same model on an exhausted usage window without a backup: %s",
    async (error) => {
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", error)),
      );
      await expect(run(request())).rejects.toThrow(error);
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["openai-codex", "openrouter", "openai-compatible"].flatMap((provider) =>
      [true, false].map((backup) => ({ provider, backup })),
    ),
  )(
    "recovers after a $provider stream goes silent before output (backup=$backup)",
    async ({ provider, backup }) => {
      vi.useFakeTimers();
      try {
        const targetModel = {
          ...primary,
          provider,
          api: provider === "openai-codex" ? ("openai-codex-responses" as const) : primary.api,
        };
        providerState.models.set(`${targetModel.provider}/${targetModel.id}`, targetModel);
        let primaryCalls = 0;
        providerState.stream.mockImplementation(
          (
            target: Model<"openai-completions">,
            _ctx: unknown,
            options: {
              signal: AbortSignal;
              onResponse?: (response: Response, model: Model<"openai-completions">) => void;
            },
          ) => {
            if (target.provider !== targetModel.provider || primaryCalls++ > 0)
              return stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"));
            const result = new AssistantMessageEventStream();
            options.onResponse?.(new Response(null, { status: 200 }), target);
            options.signal.addEventListener("abort", () => {
              const failure = message(target, [], "aborted", "aborted");
              result.push({ type: "error", reason: "aborted", error: failure });
              result.end(failure);
            });
            return result;
          },
        );
        const input = request(
          backup ? [{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }] : [],
        );
        input.model.provider = targetModel.provider;
        const pending = run(input);
        await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);
        expect(providerState.stream).toHaveBeenCalledTimes(2);
        expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual(
          backup ? [] : [2_000],
        );
        expect(await pending).toContainEqual({ type: "text", text: "recovered" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("records streamed content when the provider iterator throws after output", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "keep this text" }],
      "error",
      "429 insufficient_quota",
    );
    providerState.stream.mockImplementation(() => {
      class ThrowingStream extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...failure, content: [] } };
          yield {
            type: "text_delta" as const,
            contentIndex: 0,
            delta: "keep this text",
            partial: failure,
          };
          throw new Error("429 insufficient_quota");
        }
      }
      return new ThrowingStream();
    });
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(
        request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
        events,
        new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
      ),
    ).rejects.toThrow(/429 insufficient_quota/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("keep this text");
  });

  it("keeps terminal-only partial text even when usage accounting fails", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal answer" }],
      "error",
      "503 unavailable",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.onUsage = async () => {
      throw new Error("local accounting timeout");
    };
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(input, events, new PiAgentRuntime({ sessionRoot: "fixture-sessions" })),
    ).rejects.toThrow(/local accounting timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(events).toContainEqual({ type: "text", text: "terminal answer" });
  });

  it("continues after a long-retry 429 on a smaller backup without replaying a completed tool effect", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    const executeTool = vi.mocked(input.executeTool!);
    let primaryCalls = 0;
    let backupContext: { messages?: unknown[] } | undefined;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          primaryCalls += 1;
          if (primaryCalls === 1) {
            const call = {
              type: "toolCall" as const,
              id: "write-once",
              name: "write_effect",
              arguments: { value: "persist this once" },
            };
            return stream(target, message(target, [call], "toolUse"));
          }
          return stream(
            target,
            message(
              target,
              [],
              "error",
              "Server requested 3301s retry delay (max:60s). 429 rate_limit_error",
            ),
          );
        }
        backupContext = context;
        return stream(
          target,
          message(target, [{ type: "text", text: "Finished safely." }], "stop"),
        );
      },
    );

    const events = await run(input);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(primaryCalls).toBe(2);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, backupA.provider]);
    expect(JSON.stringify(backupContext?.messages)).toContain("write-once");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "Finished safely." }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: backupA.provider, model: backupA.id }),
    );
  });

  it("keeps the primary on a healthy response and leaves an empty chain unchanged", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "Primary response." }], "stop")),
    );

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.stream.mock.calls[0]?.[0]).toMatchObject({ provider: primary.provider });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: primary.provider, model: primary.id }),
    );
  });

  it("keeps helper-model selection on the active backup after the primary fails", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-fixture-key" },
    ]);
    input.model.apiKey = "primary-fixture-key";
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    const providers: string[] = [];
    const apiKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        providers.push(target.provider);
        apiKeys.push(options?.apiKey);
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        if (backupCalls === 1) {
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "helper-call",
                  name: "run_subagent",
                  arguments: { name: "helper", task: "Summarize the fixture." },
                },
              ],
              "toolUse",
            ),
          );
        }
        return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
      },
    );

    await run(input);

    expect(providers).toEqual([
      primary.provider,
      backupA.provider,
      backupA.provider,
      backupA.provider,
    ]);
    expect(apiKeys).toEqual([
      "primary-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
    ]);
  });

  it("keeps a refreshed backup OAuth token for later helper calls", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: backupA.provider,
      id: backupA.id,
      oauth: {
        credential: {
          type: "oauth" as const,
          access: "backup-access-before-refresh",
          refresh: "backup-refresh",
          expires: Date.now() + 60_000,
        },
      },
    }));
    const backupKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupKeys.push(options?.apiKey);
        if (backupCalls !== 1) {
          return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
        }
        const credentialStore = providerState.credentialStores[0] as CredentialStore;
        const response = message(
          target,
          [
            {
              type: "toolCall",
              id: "oauth-helper-call",
              name: "run_subagent",
              arguments: { name: "helper", task: "Summarize the fixture." },
            },
          ],
          "toolUse",
        );
        const output = new AssistantMessageEventStream();
        void (async () => {
          await credentialStore.modify(backupA.provider, async (current) => {
            if (current?.type !== "oauth") throw new Error("OAuth credential missing in fixture");
            return { ...current, access: "backup-access-after-refresh" };
          });
          for await (const event of stream(target, response)) output.push(event);
          output.end(response);
        })();
        return output;
      },
    );

    const events = await run(input);

    expect(backupKeys).toEqual([
      "backup-access-before-refresh",
      "backup-access-after-refresh",
      "backup-access-after-refresh",
    ]);
    expect(JSON.stringify(events)).not.toContain("backup-access-before-refresh");
    expect(JSON.stringify(events)).not.toContain("backup-access-after-refresh");
  });

  it("persists the selected model before streaming from the backup", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    let modelChangePersisted = false;
    input.onModelChange = vi.fn(async () => {
      await Promise.resolve();
      modelChangePersisted = true;
    });
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      }
      expect(modelChangePersisted).toBe(true);
      return stream(target, message(target, [{ type: "text", text: "backup response" }], "stop"));
    });

    const events = await run(input);

    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(backupA.provider, backupA.id);
    expect(events.filter((event) => event.type === "progress")).toEqual([]);
  });

  it("prunes new screenshots using the active backup image limit", async () => {
    const visionBackup = { ...backupA, input: ["text", "image"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, visionBackup);
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async () => ({
      provider: backupA.provider,
      id: backupA.id,
      apiKey: "test-key",
      maxImagesPerPrompt: 1,
    });
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    input.executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      details: { frameId: "test-frame" },
    }));
    let calls = 0;
    const counts: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        counts.push(
          context.messages.reduce(
            (total, item) =>
              total +
              (typeof item.content === "string"
                ? 0
                : item.content.filter((part) => part.type === "image").length),
            0,
          ),
        );
        calls += 1;
        return calls <= 2
          ? stream(
              target,
              message(
                target,
                [
                  {
                    type: "toolCall",
                    id: `frame-${calls}`,
                    name: "computer_observe",
                    arguments: {},
                  },
                ],
                "toolUse",
              ),
            )
          : stream(target, message(target, [{ type: "text", text: "Done" }], "stop"));
      },
    );
    await run(input);
    expect(counts).toEqual([0, 1, 1]);
    expect(input.executeTool).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal partial text while refusing unsafe failover", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "partial answer" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const events: AgentRuntimeEvent[] = [];
    await expect(run(request(), events)).rejects.toThrow(/429 rate_limit_error/);
    expect(events).toContainEqual({ type: "text", text: "partial answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "records streamed output and terminal suffixes with emptyTerminal=%s",
    async (emptyTerminal) => {
      const targetMessage = message(
        primary,
        [{ type: "text", text: "partial plus terminal suffix" }],
        "error",
        "429 insufficient_quota",
      );
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        if (target.provider === primary.provider) {
          const result = new AssistantMessageEventStream();
          const partial = { ...targetMessage, content: [] };
          result.push({ type: "start", partial });
          result.push({ type: "text_start", contentIndex: 0, partial });
          result.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: { ...targetMessage, content: [{ type: "text", text: "partial" }] },
          });
          const terminal = emptyTerminal ? { ...targetMessage, content: [] } : targetMessage;
          result.push({ type: "error", reason: "error", error: terminal });
          result.end(terminal);
          return result;
        }
        return stream(target, message(target, [{ type: "text", text: "must not run" }], "stop"));
      });

      const appendMessage = vi.fn(async () => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        run(
          request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
          events,
          new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
        ),
      ).rejects.toThrow(/429 insufficient_quota/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledWith(
        expect.objectContaining(
          emptyTerminal
            ? { ...targetMessage, content: [{ type: "text", text: "partial" }] }
            : targetMessage,
        ),
      );
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(emptyTerminal ? "partial" : "partial plus terminal suffix");
    },
  );

  it("keeps terminal error text when nothing was streamed and does not switch", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal partial" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, failure)
        : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
    );
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const events: Array<{ type: string; text?: string }> = [];
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      for await (const event of runtime.run(input, {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "terminal partial" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "text", text: "must not run" }),
    );
  });

  it("accepts a backup whose image limit fits once accumulated screenshots are pruned", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-key", maxImagesPerPrompt: 2 },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Observe the computer",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let shots = 0;
    input.executeTool = vi.fn(async () => {
      shots += 1;
      return {
        kind: "agent_tool_result" as const,
        content: [{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const }],
        details: { frameId: `frame-${shots}` },
      };
    });
    let primaryCalls = 0;
    const backupImageCounts: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          primaryCalls += 1;
          if (primaryCalls > 3)
            return stream(target, message(target, [], "error", "429 rate_limit_error"));
          const call = {
            type: "toolCall" as const,
            id: `observe-${primaryCalls}`,
            name: "computer_observe",
            arguments: {},
          };
          return stream(target, message(target, [call], "toolUse"));
        }
        backupImageCounts.push(countContextImages(context));
        return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
      },
    );

    const events = await run(input);

    expect(shots).toBe(3);
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(backupImageCounts).toEqual([2]);
  });

  it("prunes later screenshots with the active backup image limit", async () => {
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "backup-key",
        maxImagesPerPrompt: 1,
      },
    ]);
    input.model = { ...input.model, maxImagesPerPrompt: 3 };
    input.tools = [
      {
        name: "computer_observe",
        description: "Observe the computer",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let shots = 0;
    input.executeTool = vi.fn(async () => {
      shots += 1;
      return {
        kind: "agent_tool_result" as const,
        content: [
          { type: "text" as const, text: `frame ${shots}` },
          { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const },
        ],
        details: { frameId: `frame-${shots}` },
      };
    });
    const backupImageCounts: number[] = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupImageCounts.push(countContextImages(context));
        if (backupCalls <= 3) {
          const call = {
            type: "toolCall" as const,
            id: `observe-${backupCalls}`,
            name: "computer_observe",
            arguments: {},
          };
          return stream(target, message(target, [call], "toolUse"));
        }
        return stream(target, message(target, [{ type: "text", text: "done looking" }], "stop"));
      },
    );

    await run(input);

    expect(backupCalls).toBe(4);
    expect(backupImageCounts[0]).toBe(0);
    expect(backupImageCounts.at(-1)).toBe(1);
  });

  it("switches without running a tool call that a failed response holds but never streamed", async () => {
    const failure = message(
      primary,
      [
        {
          type: "toolCall",
          id: "terminal-call",
          name: "write_effect",
          arguments: { value: "must not execute" },
        },
      ],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, failure)
        : stream(target, message(target, [{ type: "text", text: "from backup" }], "stop")),
    );
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);

    const events = await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider]);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "from backup" });
  });

  it("does not switch because a tool failed", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    input.executeTool = vi.fn(async () => {
      throw new Error("tool permission denied");
    });
    let primaryCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        const call = {
          type: "toolCall" as const,
          id: "failed-tool",
          name: "write_effect",
          arguments: { value: "denied" },
        };
        return stream(target, message(target, [call], "toolUse"));
      }
      return stream(
        target,
        message(target, [{ type: "text", text: "The tool was denied." }], "stop"),
      );
    });

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider]);
  });

  it.each(["failed", "skipped", "mixed"] as const)(
    "reports %s backups only when the run fails after exhausting the chain",
    async (outcome) => {
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
        { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
      ]);
      input.resolveFallbackModel = async (provider, id) => ({
        provider,
        id,
        apiKey:
          outcome === "skipped" || (outcome === "mixed" && provider === backupA.provider)
            ? undefined
            : "fake-backup-key",
      });
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", "429 quota exhausted")),
      );
      const error = await run(input).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(error).toBeInstanceOf(Error);
      const diagnostic = JSON.parse(error!.message);
      expect(diagnostic).toMatchObject({
        modelFallbackVersion: 1,
        primaryError: "429 quota exhausted",
      });
      expect(diagnostic.backups.map((backup: { status: string }) => backup.status)).toEqual(
        outcome === "mixed" ? ["skipped", "failed"] : [outcome, outcome],
      );
      expect(normalizeRunError(error!.message).summary).not.toBe(
        normalizeRunError(diagnostic.primaryError).summary,
      );
      expect(providerState.stream).toHaveBeenCalledTimes(
        outcome === "skipped" ? 1 : outcome === "mixed" ? 2 : 3,
      );
    },
  );

  it("records why backups were skipped without exposing credential-resolution errors", async () => {
    providerState.models.set(`${primary.provider}/${primary.id}`, { ...primary, reasoning: true });
    providerState.models.set(`${backupA.provider}/${backupA.id}`, { ...backupA, reasoning: false });
    const input = request([
      { provider: backupA.provider, id: backupA.id },
      { provider: backupB.provider, id: backupB.id },
    ]);
    input.resolveFallbackModel = async (provider, id) => {
      if (provider === backupB.provider) throw new Error("fake-private-credential-diagnostic");
      return { provider, id, apiKey: "fake-backup-key", thinkingLevel: "low" };
    };
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 quota exhausted")),
    );
    const error = await run(input).catch((error: Error) => error);
    expect((error as Error).message).not.toContain("fake-private-credential-diagnostic");
    expect(JSON.parse((error as Error).message).backups).toEqual([
      {
        provider: backupA.provider,
        modelId: backupA.id,
        status: "skipped",
        reason: "The backup model does not support the requested thinking level.",
      },
      {
        provider: backupB.provider,
        modelId: backupB.id,
        status: "skipped",
        reason: "The backup connection or request could not be prepared.",
      },
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it.each(["primary", "backup"] as const)(
    "does not reuse a recovered %s call's error on a later failed call",
    async (recovered) => {
      const input = request([{ provider: backupA.provider, id: backupA.id }]);
      input.resolveFallbackModel = async (provider, id) => ({
        provider,
        id,
        apiKey: recovered === "backup" ? "fake-backup-key" : undefined,
      });
      let calls = 0;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        calls += 1;
        if (calls === 1)
          return stream(target, message(target, [], "error", "503 Service unavailable"));
        if (calls === 2)
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "recovered-tool",
                  name: "write_effect",
                  arguments: { value: "write once" },
                },
              ],
              "toolUse",
            ),
          );
        return stream(target, message(target, [], "error", "400 Invalid request"));
      });
      await expect(run(input)).rejects.toThrow(/^400 Invalid request$/);
      expect(calls).toBe(3);
      expect(input.executeTool).toHaveBeenCalledTimes(1);
    },
  );

  it("explains a backup skipped because user images exceed its limit", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async (provider, id) => ({
      provider,
      id,
      apiKey: "fake-one-image-key",
      maxImagesPerPrompt: 1,
    });
    input.currentTurnImages = [
      { name: "first.png", mimeType: "image/png", data: new Uint8Array([1]) },
      { name: "second.png", mimeType: "image/png", data: new Uint8Array([2]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 quota exhausted")),
    );
    const error = await run(input).catch((error: Error) => error);
    expect(JSON.parse((error as Error).message).backups).toEqual([
      {
        provider: backupA.provider,
        modelId: backupA.id,
        status: "skipped",
        reason: "The request exceeds the backup model's image limit.",
      },
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it("uses a smaller backup on the context its own policy shortens to fit", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async (provider, id) => ({
      provider,
      id,
      apiKey: "fake-small-window-key",
    });
    // Each turn alone fits the 8K backup; together they fit only the 32K primary.
    input.history = Array.from({ length: 8 }, (_, index) => ({
      id: `older-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Older turn ${index}. `.repeat(400),
    })) as AgentRunRequest["history"];
    const sent: { provider: string; messages: number }[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages: unknown[] }) => {
        sent.push({ provider: target.provider, messages: context.messages.length });
        return target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 quota exhausted"))
          : stream(target, message(target, [{ type: "text", text: "done" }], "stop"));
      },
    );
    await run(input);
    expect(sent.map((call) => call.provider)).toEqual([primary.provider, backupA.provider]);
    expect(sent[1]!.messages).toBeLessThan(sent[0]!.messages);
  });

  it("still skips a smaller backup when the context strategy keeps the transcript as is", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.contextStrategy = "current";
    input.resolveFallbackModel = async (provider, id) => ({
      provider,
      id,
      apiKey: "fake-small-window-key",
    });
    input.history = Array.from({ length: 8 }, (_, index) => ({
      id: `older-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Older turn ${index}. `.repeat(400),
    })) as AgentRunRequest["history"];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 quota exhausted")),
    );
    const error = await run(input).catch((error: Error) => error);
    expect(JSON.parse((error as Error).message).backups).toEqual([
      {
        provider: backupA.provider,
        modelId: backupA.id,
        status: "skipped",
        reason: "Conversation exceeds the backup model's context limit.",
      },
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it("still skips a backup whose window cannot hold the instructions", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.instructions = "Mandatory instruction. ".repeat(4_000);
    input.resolveFallbackModel = async (provider, id) => ({
      provider,
      id,
      apiKey: "fake-small-window-key",
    });
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 quota exhausted")),
    );
    const error = await run(input).catch((error: Error) => error);
    expect(JSON.parse((error as Error).message).backups).toEqual([
      {
        provider: backupA.provider,
        modelId: backupA.id,
        status: "skipped",
        reason: "Conversation exceeds the backup model's context limit.",
      },
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it("retains the primary failure when a backup fails for a different reason", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        message(
          target,
          [],
          "error",
          target.provider === primary.provider ? "429 quota exhausted" : "400 Invalid request",
        ),
      ),
    );
    const error = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup" }]),
    ).catch((error: Error) => error);
    const diagnostic = JSON.parse((error as Error).message);
    expect(diagnostic.primaryError).toBe("429 quota exhausted");
    expect(diagnostic.backups[0]).toMatchObject({
      status: "failed",
      reason: "400 Invalid request",
    });
  });

  it("does not claim exhaustion when an error leaves an untried backup", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        message(
          target,
          [],
          "error",
          target.provider === primary.provider ? "429 quota exhausted" : "400 Invalid request",
        ),
      ),
    );
    const error = await run(
      request([
        { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
        { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
      ]),
    ).catch((error: Error) => error);
    expect((error as Error).message).toBe("400 Invalid request");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("tries each backup once in order, then retries the last before surfacing exhaustion", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "529 overloaded_error")),
    );

    await expect(
      run(
        request([
          { provider: primary.provider, id: primary.id, apiKey: "duplicate-primary" },
          { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
          { provider: backupA.provider, id: backupA.id, apiKey: "duplicate-backup" },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
        ]),
      ),
    ).rejects.toThrow(/overloaded_error/);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider, ...Array<string>(4).fill(backupB.provider)]);
  });

  it("skips a backup that cannot fit the actual prompt and selects the next smaller-than-primary fit", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small...key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "fitti...key" },
    ]);
    input.prompt = "x".repeat(24_000);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fit" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a small-context backup when the actual input and configured output fit", async () => {
    const smallContextBackup = model("provider-small", "small-context", 2_048);
    providerState.models.set(
      `${smallContextBackup.provider}/${smallContextBackup.id}`,
      smallContextBackup as unknown as Record<string, unknown>,
    );
    const input = request([
      {
        provider: smallContextBackup.provider,
        id: smallContextBackup.id,
        apiKey: "small...key",
        maxTokens: 512,
      },
    ]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fits" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, smallContextBackup.provider]);
  });

  it("runs a backup without reasoning with thinking off when the primary thinks", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    const textOnlyBackup = { ...backupA, reasoning: false };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider]);
    expect(providerState.stream.mock.calls[1]?.[2]).toMatchObject({ reasoning: undefined });
  });

  it("runs a reasoning backup at its own effort, not the main model's", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    const reasoningBackup = { ...backupA, reasoning: true };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, reasoningBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "reasoning-backup-key" },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );

    await run(input);

    expect(providerState.stream.mock.calls[1]?.[2]).toMatchObject({ reasoning: "medium" });
  });

  it("keeps a backup's own effort when its role row sets one", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      reasoning: true,
    });
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "reasoning-backup-key",
        thinkingLevel: "low",
      },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
    );

    await run(input);

    expect(providerState.stream.mock.calls[1]?.[2]).toMatchObject({ reasoning: "low" });
  });

  it.each([...IMAGE_RETURNING_COMPUTER_TOOLS, "write_effect"])(
    "requires image-capable backups only when %s can return screenshots",
    async (toolName) => {
      providerState.models.set(`${backupA.provider}/${backupA.id}`, {
        ...backupA,
        input: ["text"],
      });
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
        { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
      ]);
      input.tools = [{ ...input.tools[0]!, name: toolName }];
      providerState.stream.mockImplementation(
        (target: Model<"openai-completions">, context: Context) => {
          expect(countContextImages(context)).toBe(0);
          return target.provider === primary.provider
            ? stream(target, message(target, [], "error", "429 rate_limit_error"))
            : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
        },
      );

      await run(input);

      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([
        primary.provider,
        IMAGE_RETURNING_COMPUTER_TOOLS.has(toolName) ? backupB.provider : backupA.provider,
      ]);
    },
  );

  it("skips backups that cannot accept the current image input", async () => {
    const textOnlyBackup = { ...backupA, input: ["text"] as ["text"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
    ]);
    input.currentTurnImages = [
      { name: "fixture.png", mimeType: "image/png", data: new Uint8Array([1]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "image understood" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("skips a backup whose image limit is below the user's own images", async () => {
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "one-image-key",
        maxImagesPerPrompt: 1,
      },
      { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
    ]);
    input.currentTurnImages = [
      { name: "first.png", mimeType: "image/png", data: new Uint8Array([1]) },
      { name: "second.png", mimeType: "image/png", data: new Uint8Array([2]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "both images seen" }], "stop")),
    );

    const events = await run(input);

    expect(events.at(-1)).toEqual({ type: "done", text: "both images seen" });
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a native vision backup with acceptsImages false after a 429", async () => {
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      input: ["text", "image"],
    });
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "vision-backup-key",
        acceptsImages: false,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "saw the screen" }], "stop")),
    );

    const events = await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider]);
    expect(events.at(-1)).toEqual({ type: "done", text: "saw the screen" });
  });

  it("still skips a native text-only backup when screen tools can return images", async () => {
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      input: ["text"],
    });
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "text-only-key",
        acceptsImages: false,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 rate_limit_error")),
    );

    await expect(run(input)).rejects.toThrow(/429 rate_limit_error/);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, primary.provider, primary.provider]);
  });

  it("skips an OpenAI-compatible backup with acceptsImages false and uses one with true", async () => {
    const refused = model("openai-compatible", "compat-refused", 16_384);
    const accepted = model("openai-compatible", "compat-accepted", 16_384);
    providerState.models.set(`${refused.provider}/${refused.id}`, {
      ...refused,
      input: ["text", "image"],
    });
    providerState.models.set(`${accepted.provider}/${accepted.id}`, {
      ...accepted,
      input: ["text", "image"],
    });
    const input = request([
      {
        provider: refused.provider,
        id: refused.id,
        apiKey: "compat-refused-key",
        baseUrl: "https://compat.invalid/v1",
        acceptsImages: false,
      },
      {
        provider: accepted.provider,
        id: accepted.id,
        apiKey: "compat-accepted-key",
        baseUrl: "https://compat.invalid/v1",
        acceptsImages: true,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "compat saw it" }], "stop")),
    );

    const events = await run(input);

    expect(
      providerState.stream.mock.calls.map(([target]) => target as Model<"openai-completions">),
    ).toEqual([
      expect.objectContaining({ provider: primary.provider, id: primary.id }),
      expect.objectContaining({ provider: accepted.provider, id: accepted.id }),
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "compat saw it" });
  });

  it("does not persist or start a backup when cancellation wins during credential resolution", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    let releaseResolution: ((model: AgentRunRequest["model"]) => void) | undefined;
    input.resolveFallbackModel = vi.fn(
      () =>
        new Promise<AgentRunRequest["model"]>((resolve) => {
          releaseResolution = resolve;
        }),
    );
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        target.provider === primary.provider
          ? message(target, [], "error", "429 rate_limit_error")
          : message(target, [{ type: "text", text: "must not start" }], "stop"),
      ),
    );
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      try {
        for await (const _event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: controller.signal,
        })) {
          // Drain the runtime stream while cancellation is tested.
        }
      } catch {
        // Cancellation is surfaced as a stopped run by the outer runtime.
      }
    };
    const running = consume();
    await vi.waitFor(() => expect(input.resolveFallbackModel).toHaveBeenCalledOnce());
    controller.abort();
    releaseResolution?.({ provider: backupA.provider, id: backupA.id, apiKey: "test-backup-key" });
    await running;

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider]);
  });

  it("skips a backup with changed credentials and uses only the next backup's credential", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id },
      { provider: backupB.provider, id: backupB.id },
    ]);
    const resolveFallbackModel = vi.fn(async (provider: string, id: string) => {
      if (provider === backupA.provider) throw new Error("connected credential changed");
      return { provider, id, apiKey: "backup-only-key" };
    });
    input.resolveFallbackModel = resolveFallbackModel;
    const requestKeys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        requestKeys.push(options?.apiKey);
        return stream(target, message(target, [{ type: "text", text: "safe" }], "stop"));
      },
    );

    const events = await run(input);

    expect(resolveFallbackModel).toHaveBeenNthCalledWith(
      1,
      backupA.provider,
      backupA.id,
      undefined,
    );
    expect(resolveFallbackModel).toHaveBeenNthCalledWith(
      2,
      backupB.provider,
      backupB.id,
      undefined,
    );
    expect(requestKeys).toEqual(["backup-only-key"]);
    expect(JSON.stringify(events)).not.toContain("backup-only-key");
  });

  it("falls back to the same model on another account's connection", async () => {
    const input = request([
      // The running connection is never its own backup.
      { provider: primary.provider, id: primary.id, connectionId: "personal" },
      { provider: primary.provider, id: primary.id, connectionId: "work" },
    ]);
    input.model = { ...input.model, connectionId: "personal" };
    const resolveFallbackModel = vi.fn(
      async (provider: string, id: string, connectionId?: string) => ({
        provider,
        id,
        connectionId,
        apiKey: "fake-work-key",
      }),
    );
    input.resolveFallbackModel = resolveFallbackModel;
    const requestKeys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        requestKeys.push(options?.apiKey);
        return options?.apiKey === "fake-primary-key"
          ? stream(target, message(target, [], "error", "429 usage limit reached"))
          : stream(target, message(target, [{ type: "text", text: "from work" }], "stop"));
      },
    );

    const events = await run(input);

    expect(resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(
      primary.provider,
      primary.id,
      "work",
    );
    expect(requestKeys.at(-1)).toBe("fake-work-key");
    expect(JSON.stringify(events)).toContain("from work");
  });
});

describe("Pi runtime thinking blocks bound to a different conversation", () => {
  const mismatch =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}';
  const thinkingParts = (context: Context) =>
    context.messages.flatMap((entry) =>
      entry.role === "assistant" ? entry.content.filter((part) => part.type === "thinking") : [],
    );

  it("retries once without earlier thinking blocks and keeps dropping them for the run", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              { type: "thinking", thinking: "Plan the write.", thinkingSignature: "sig" },
              { type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", mismatch)))
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [{ type: "toolCall", id: "call-2", name: "write_effect", arguments: { value: "b" } }],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );
    const events = await run(request());
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(contexts).toHaveLength(4);
    expect(thinkingParts(contexts[1]!)).toHaveLength(1);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([]);
    expect(
      contexts[2]!.messages.some(
        (entry) =>
          entry.role === "assistant" && entry.content.some((part) => part.type === "toolCall"),
      ),
    ).toBe(true);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("leaves thinking from before a backup switch out, and keeps the backup's own", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    let backupCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        return providerState.stream.mock.calls.length === 1
          ? stream(
              target,
              message(
                target,
                [
                  { type: "thinking", thinking: "Primary plan.", thinkingSignature: "primary" },
                  {
                    type: "toolCall",
                    id: "call-1",
                    name: "write_effect",
                    arguments: { value: "a" },
                  },
                ],
                "toolUse",
              ),
            )
          : stream(target, message(target, [], "error", "429 rate_limit_error"));
      }
      backupCalls += 1;
      return backupCalls === 1
        ? stream(
            target,
            message(
              target,
              [
                { type: "thinking", thinking: "Backup plan.", thinkingSignature: "backup" },
                { type: "toolCall", id: "call-2", name: "write_effect", arguments: { value: "b" } },
              ],
              "toolUse",
            ),
          )
        : stream(target, message(target, [{ type: "text", text: "Done." }], "stop"));
    });

    const events = await run(input);

    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(contexts).toHaveLength(4);
    expect(thinkingParts(contexts[1]!)).toEqual([
      expect.objectContaining({ thinkingSignature: "primary" }),
    ]);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([
      expect.objectContaining({ thinkingSignature: "backup" }),
    ]);
  });

  it("uses a backup that fits only without the thinking written before the switch", async () => {
    const thinking = "x".repeat(12_000);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small-backup-key", maxTokens: 512 },
    ]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider !== primary.provider)
        return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
      return providerState.stream.mock.calls.length === 1
        ? stream(
            target,
            message(
              target,
              [
                { type: "thinking", thinking, thinkingSignature: "primary" },
                { type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } },
              ],
              "toolUse",
            ),
          )
        : stream(target, message(target, [], "error", "429 rate_limit_error"));
    });

    const events = await run(input);

    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, backupA.provider]);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
  });

  it("surfaces the error when the retry without thinking blocks fails the same way", async () => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", mismatch)),
    );
    await expect(run(request())).rejects.toThrow("bound to a different conversation");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("uses a backup that fits only after discarded thinking blocks are omitted", async () => {
    const thinking = "x".repeat(12_000);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small-backup-key", maxTokens: 512 },
    ]);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              { type: "thinking", thinking, thinkingSignature: "sig" },
              { type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", mismatch)))
      .mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate_limit_error"))
          : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
      );

    const events = await run(input);

    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, primary.provider, backupA.provider]);
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(thinkingParts(contexts[1]!)).toHaveLength(1);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([]);
    expect(providerState.delay).not.toHaveBeenCalled();
  });
});

describe("Pi runtime output reservation recovery", () => {
  const limited = model("openrouter", "fixture-limited", 32_768);
  const budgetError =
    '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1024.","metadata":{"limit_source":"openrouter_credits"}}';

  function limitedRequest() {
    providerState.models.set(
      `${limited.provider}/${limited.id}`,
      limited as unknown as Record<string, unknown>,
    );
    return {
      ...request(),
      model: { provider: limited.provider, id: limited.id, apiKey: "fixture-key" },
    };
  }

  it("lowers the rejected reservation once and retains it through subsequent tool turns", async () => {
    const input = limitedRequest();
    const caps: number[] = [];
    providerState.stream.mockImplementation((target, _context, options) => {
      caps.push(options.maxTokens);
      if (caps.length === 1) return stream(target, message(target, [], "error", budgetError));
      if (caps.length === 2)
        return stream(
          target,
          message(
            target,
            [
              {
                type: "toolCall",
                id: "fixture-call",
                name: "write_effect",
                arguments: { value: "fixture" },
              },
            ],
            "toolUse",
          ),
        );
      return stream(target, message(target, [{ type: "text", text: "Ready" }], "stop"));
    });
    const events = await run(input);
    expect(caps).toEqual([4096, 1024, 1024]);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
  });

  it("never loops when the reduced request is rejected too", async () => {
    const input = limitedRequest();
    providerState.stream.mockImplementation((target) =>
      stream(target, message(target, [], "error", budgetError)),
    );
    await expect(run(input)).rejects.toThrow("This request requires more credits");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it.each([
    ["text", 1],
    ["toolCall", 2],
  ] as const)(
    "with a partial %s block in the failed response calls the model %i time(s) and runs nothing",
    async (part, calls) => {
      const input = limitedRequest();
      providerState.stream.mockImplementation((target) =>
        stream(
          target,
          message(
            target,
            part === "text"
              ? [{ type: "text", text: "Partial" }]
              : [
                  {
                    type: "toolCall",
                    id: "fixture-call",
                    name: "write_effect",
                    arguments: { value: "fixture" },
                  },
                ],
            "error",
            budgetError,
          ),
        ),
      );
      await expect(run(input)).rejects.toThrow("This request requires more credits");
      // Text was shown, so it stays terminal; a tool call never ran, so the call is redone.
      expect(providerState.stream).toHaveBeenCalledTimes(calls);
      expect(input.executeTool).not.toHaveBeenCalled();
    },
  );

  it("does not treat a local reservation failure as a provider rejection", async () => {
    const input = limitedRequest();
    const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
      throw new Error(budgetError);
    });
    await expect(
      run(
        input,
        [],
        new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall: async () => undefined } }),
      ),
    ).rejects.toThrow("This request requires more credits");
    expect(beforeCall).toHaveBeenCalledOnce();
    expect(providerState.stream).not.toHaveBeenCalled();
  });

  it("does not retry after the original request deadline", async () => {
    vi.useFakeTimers();
    const input = limitedRequest();
    providerState.stream.mockImplementation((target) => {
      vi.setSystemTime(Date.now() + MODEL_STREAM_TIMEOUT_MS + 1);
      return stream(target, message(target, [], "error", budgetError));
    });
    await expect(run(input)).rejects.toThrow("This request requires more credits");
    expect(providerState.stream).toHaveBeenCalledOnce();
  });
});

describe("Pi runtime account request ceilings", () => {
  it.each([false, true])(
    "handles a provider budget below mandatory context without retrying it (backup: %s)",
    async (withBackup) => {
      const targetModel = model("groq", "fixture-small-account", 32_768);
      providerState.models.set(
        `${targetModel.provider}/${targetModel.id}`,
        targetModel as unknown as Record<string, unknown>,
      );
      const input = {
        ...request(
          withBackup ? [{ provider: backupA.provider, id: backupA.id, apiKey: "fixture-key" }] : [],
        ),
        model: { provider: targetModel.provider, id: targetModel.id, apiKey: "fixture-key" },
        instructions: "Synthetic required instructions. ".repeat(200),
      };
      providerState.stream.mockImplementation((target) =>
        stream(
          target,
          target.provider === "groq"
            ? message(
                target,
                [],
                "error",
                '413: {"code":"rate_limit_exceeded","type":"tokens","message":"Request too large on tokens per minute (TPM): Limit 2000, Requested 3000, reduce your message size."}',
              )
            : message(target, [{ type: "text", text: "Ready" }], "stop"),
        ),
      );
      if (withBackup) {
        await expect(run(input)).resolves.toContainEqual(
          expect.objectContaining({ type: "done", text: "Ready" }),
        );
        expect(providerState.stream.mock.calls.map(([target]) => target.provider)).toEqual([
          "groq",
          backupA.provider,
        ]);
      } else {
        await expect(run(input)).rejects.toMatchObject({
          name: "ModelAccountError",
          message: MODEL_REQUEST_LIMIT_ERROR,
        });
        expect(providerState.stream).toHaveBeenCalledOnce();
      }
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(input.model).not.toHaveProperty("contextWindow");
    },
  );

  it("rebuilds a rejected Groq context once without changing saved/requested settings", async () => {
    const targetModel = model("groq", "fixture-limited", 32_768);
    providerState.models.set(
      `${targetModel.provider}/${targetModel.id}`,
      targetModel as unknown as Record<string, unknown>,
    );
    const input = {
      ...request(),
      model: { provider: targetModel.provider, id: targetModel.id, apiKey: "fixture-key" },
      history: [{ role: "user" as const, content: "Synthetic older context. ".repeat(2000) }],
    };
    const windows: number[] = [];
    const caps: number[] = [];
    providerState.stream.mockImplementation((target, _context, options) => {
      windows.push(target.contextWindow);
      caps.push(options.maxTokens);
      if (windows.length > 1) {
        expect(estimateModelContextTokens(_context)).toBeLessThan(
          target.contextWindow - options.maxTokens,
        );
      }
      return stream(
        target,
        windows.length === 1
          ? message(
              target,
              [],
              "error",
              '413: {"code":"rate_limit_exceeded","type":"tokens","message":"Request too large on tokens per minute (TPM): Limit 6000, Requested 7000, please reduce your message size."}',
            )
          : message(target, [{ type: "text", text: "Ready" }], "stop"),
      );
    });
    const events = await run(input);
    expect(windows).toEqual([32768, 5100]);
    expect(caps).toEqual([4096, 1275]);
    expect(input.model).not.toHaveProperty("contextWindow");
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
  });

  const llamaCppOverflow = (contextSize: number) =>
    `400: ${JSON.stringify({ code: 400, message: `request (19563 tokens) exceeds the available context size (${contextSize} tokens), try increasing it`, type: "exceed_context_size_error", n_prompt_tokens: 19563, n_ctx: contextSize })}`;
  const compatibleModel = () => {
    const targetModel = model("openai-compatible", "fixture-local", 262_144);
    providerState.models.set(
      `${targetModel.provider}/${targetModel.id}`,
      targetModel as unknown as Record<string, unknown>,
    );
    return {
      provider: targetModel.provider,
      id: targetModel.id,
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "fixture-key",
    };
  };

  it("rebuilds an OpenAI-compatible context once at the window the server reports", async () => {
    const input = {
      ...request(),
      model: compatibleModel(),
      history: [{ role: "user" as const, content: "Synthetic older context. ".repeat(2000) }],
    };
    const windows: number[] = [];
    providerState.stream.mockImplementation((target, context, options) => {
      windows.push(target.contextWindow);
      if (windows.length > 1) {
        expect(estimateModelContextTokens(context)).toBeLessThan(
          target.contextWindow - options.maxTokens,
        );
      }
      return stream(
        target,
        windows.length === 1
          ? message(target, [], "error", llamaCppOverflow(6000))
          : message(target, [{ type: "text", text: "Ready" }], "stop"),
      );
    });
    const events = await run(input);
    expect(windows).toEqual([262_144, 5100]);
    expect(input.model).not.toHaveProperty("contextWindow");
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
  });

  it("rebuilds only once and reports a context failure when the server rejects the rebuild", async () => {
    const input = {
      ...request(),
      model: compatibleModel(),
      history: [{ role: "user" as const, content: "Synthetic older context. ".repeat(2000) }],
    };
    providerState.stream.mockImplementation((target) =>
      stream(target, message(target, [], "error", llamaCppOverflow(6000))),
    );
    const failure = await run(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(normalizeRunError((failure as Error).message)).toMatchObject({ kind: "context" });
  });

  it.each([false, true])(
    "reports a too-small OpenAI-compatible window without retrying it (backup: %s)",
    async (withBackup) => {
      const input = {
        ...request(
          withBackup ? [{ provider: backupA.provider, id: backupA.id, apiKey: "fixture-key" }] : [],
        ),
        model: compatibleModel(),
        instructions: "Synthetic required instructions. ".repeat(200),
      };
      providerState.stream.mockImplementation((target) =>
        stream(
          target,
          target.provider === "openai-compatible"
            ? message(target, [], "error", llamaCppOverflow(2000))
            : message(target, [{ type: "text", text: "Ready" }], "stop"),
        ),
      );
      if (withBackup) {
        await expect(run(input)).resolves.toContainEqual(
          expect.objectContaining({ type: "done", text: "Ready" }),
        );
        expect(providerState.stream.mock.calls.map(([target]) => target.provider)).toEqual([
          "openai-compatible",
          backupA.provider,
        ]);
      } else {
        await expect(run(input)).rejects.toMatchObject({
          name: "ModelAccountError",
          message: MODEL_CONTEXT_TOO_SMALL_ERROR,
        });
        expect(providerState.stream).toHaveBeenCalledOnce();
      }
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(input.model).not.toHaveProperty("contextWindow");
    },
  );
});

describe("Pi runtime fallback error classes and mid-run switches", () => {
  const providers = (): string[] =>
    providerState.stream.mock.calls.map(
      ([target]) => (target as Model<"openai-completions">).provider,
    );
  const backups = () => [{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }];

  it.each([
    ["429 rate limit", "429 rate_limit_error: Number of request tokens has exceeded your limit"],
    ["500 server error", "500 Internal server error"],
    ["503 unavailable", "503 service unavailable"],
    ["529 overloaded", "529 overloaded_error: Overloaded"],
    ["timeout", "Request timed out."],
  ])("switches to the backup on %s", async (_name, error) => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", error))
        : stream(target, message(target, [{ type: "text", text: "from backup" }], "stop")),
    );

    const events = await run(request(backups()));

    expect(providers()).toEqual([primary.provider, backupA.provider]);
    expect(events).toContainEqual(expect.objectContaining({ type: "text", text: "from backup" }));
  });

  it("leaves retries to the backup instead of the provider SDK", async () => {
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "1");
    try {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [{ type: "text", text: "Ready" }], "stop")),
      );

      await run(request(backups()));
      await run(request());

      // A hung primary would otherwise wait out its timeout twice before the switch.
      expect(providerState.stream.mock.calls.map(([, , options]) => options.maxRetries)).toEqual([
        0, 1,
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([["403 forbidden", "403 Forbidden"]])(
    "does not switch to the backup on %s",
    async (_name, error) => {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", error)),
      );

      await expect(run(request(backups()))).rejects.toThrow();

      expect(providers()).toEqual([primary.provider]);
    },
  );

  it("runs the backup's own tool call after a primary tool call, never replaying the first", async () => {
    const input = request(backups());
    const executeTool = vi.mocked(input.executeTool!);
    const call = (id: string, value: string) => ({
      type: "toolCall" as const,
      id,
      name: "write_effect",
      arguments: { value },
    });
    let primaryCalls = 0;
    let backupCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        primaryCalls += 1;
        return primaryCalls === 1
          ? stream(target, message(target, [call("first", "one")], "toolUse"))
          : stream(target, message(target, [], "error", "529 overloaded_error"));
      }
      backupCalls += 1;
      return backupCalls === 1
        ? stream(target, message(target, [call("second", "two")], "toolUse"))
        : stream(target, message(target, [{ type: "text", text: "done" }], "stop"));
    });

    await run(input);

    expect(executeTool.mock.calls.map(([, args]) => args)).toEqual([
      { value: "one" },
      { value: "two" },
    ]);
    expect(providers()).toEqual([
      primary.provider,
      primary.provider,
      backupA.provider,
      backupA.provider,
    ]);
  });
});

describe("Pi runtime reasoning efforts an endpoint refuses", () => {
  const refused =
    '400: {"message":"reasoning_effort must be one of: low, medium, high, max","type":"invalid_request_error","param":"","code":null}';

  it.each([
    ["minimal", ["minimal", "low", "low"]],
    ["off", ["off", "off", "off"]],
  ] as const)(
    "retries a refused %s effort with one the endpoint accepts for the rest of the run",
    async (thinkingLevel, sentLevels) => {
      providerState.models.set(`${primary.provider}/${primary.id}`, {
        ...primary,
        reasoning: true,
        thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
      });
      const input = request();
      input.model.thinkingLevel = thinkingLevel;
      providerState.stream
        .mockImplementationOnce((target: Model<"openai-completions">) =>
          stream(target, message(target, [], "error", refused)),
        )
        .mockImplementationOnce((target: Model<"openai-completions">) =>
          stream(
            target,
            message(
              target,
              [{ type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } }],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((target: Model<"openai-completions">) =>
          stream(target, message(target, [{ type: "text", text: "Done." }], "stop")),
        );

      const events = await run(input);

      expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
      const calls = providerState.stream.mock.calls as [
        Model<"openai-completions">,
        unknown,
        { reasoning?: ModelThinkingLevel } | undefined,
      ][];
      expect(
        calls.map(([target, , options]) => clampThinkingLevel(target, options?.reasoning ?? "off")),
      ).toEqual(sentLevels);
      expect(calls.slice(1).map(([target]) => target.thinkingLevelMap?.off)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );
});

describe("Pi runtime token pacer hook", () => {
  const local = model("local", "primary", 32_768);
  const localRequest = () => {
    const input = request();
    input.model = {
      provider: local.provider,
      id: local.id,
      apiKey: "fake-key",
    } as typeof input.model;
    providerState.models.set(
      `${local.provider}/${local.id}`,
      local as unknown as Record<string, unknown>,
    );
    return input;
  };
  const reply = () => stream(local, message(local, [{ type: "text", text: "Done." }], "stop"));

  it("reserves the prompt before the call and settles it with the reported tokens", async () => {
    vi.stubEnv("RAKAZO_LOCAL_TOKENS_PER_MINUTE", "123456");
    const slot = { settle: vi.fn(), release: vi.fn() };
    const acquire = vi.spyOn(sharedTokenPacer, "acquire").mockResolvedValue({ slot, waitedMs: 0 });
    providerState.stream.mockImplementation(reply);
    await run(localRequest());
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]?.[0]).toBe("local|https://models.invalid/v1");
    expect(acquire.mock.calls[0]?.[2]).toBe(123_456);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(
      providerState.stream.mock.invocationCallOrder[0] ?? 0,
    );
    expect(slot.settle).toHaveBeenCalledWith(4);
  });

  it("does not pace when the limit is unset or the provider is not local", async () => {
    const acquire = vi.spyOn(sharedTokenPacer, "acquire");
    providerState.stream.mockImplementation(reply);
    await run(localRequest());
    vi.stubEnv("RAKAZO_LOCAL_TOKENS_PER_MINUTE", "123456");
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
    );
    await run(request());
    expect(acquire).not.toHaveBeenCalled();
  });

  it("frees the reservation when the call fails", async () => {
    vi.stubEnv("RAKAZO_LOCAL_TOKENS_PER_MINUTE", "123456");
    const slot = { settle: vi.fn(), release: vi.fn() };
    vi.spyOn(sharedTokenPacer, "acquire").mockResolvedValue({ slot, waitedMs: 0 });
    providerState.stream.mockImplementation(() =>
      stream(local, message(local, [], "error", "boom")),
    );
    await run(localRequest()).catch(() => undefined);
    expect(slot.release).toHaveBeenCalled();
    expect(slot.settle).not.toHaveBeenCalled();
  });
});

describe("Pi runtime empty replies", () => {
  const providers = (): string[] =>
    providerState.stream.mock.calls.map(
      ([target]) => (target as Model<"openai-completions">).provider,
    );
  const thinkingOnly: AssistantMessage["content"] = [
    { type: "thinking", thinking: "Considering the answer." },
  ];

  it("repeats an empty and a thinking-only reply on the same model with backoff", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "stop")))
      .mockImplementationOnce(() => stream(primary, message(primary, thinkingOnly, "stop")))
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    const appendMessage = vi.fn(async (_entry: AgentMessage) => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });

    const events = await run(
      request(),
      [],
      new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
    );

    expect(providers()).toEqual([primary.provider, primary.provider, primary.provider]);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Recovered." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
    // The empty attempts and their thinking never reach the transcript.
    expect(appendMessage.mock.calls.filter(([entry]) => entry.role === "assistant")).toEqual([
      [expect.objectContaining({ content: [{ type: "text", text: "Recovered." }] })],
    ]);
  });

  /** Streams `chunks` as text deltas, the way providers send a reply. */
  const streamedText = (target: Model<"openai-completions">, chunks: string[]) => {
    const final = message(target, [{ type: "text", text: chunks.join("") }], "stop");
    const result = new AssistantMessageEventStream();
    result.push({ type: "start", partial: { ...final, content: [] } });
    result.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...final, content: [{ type: "text", text: "" }] },
    });
    let text = "";
    for (const delta of chunks) {
      text += delta;
      result.push({
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: { ...final, content: [{ type: "text", text }] },
      });
    }
    result.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
    result.push({ type: "done", reason: "stop", message: final });
    result.end(final);
    return result;
  };

  it("repeats a whitespace-only reply, streamed or only in the final message", async () => {
    providerState.stream
      .mockImplementationOnce(() => streamedText(primary, ["\n", "  \n"]))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [{ type: "text", text: " \n\t" }], "stop")),
      )
      .mockImplementation(() => streamedText(primary, ["Recovered."]));

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Recovered." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
  });

  it("sends held-back whitespace once when real text follows it", async () => {
    providerState.stream.mockImplementation(() => streamedText(primary, ["\n\n", "Hello."]));

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("")).toBe(
      "\n\nHello.",
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "\n\nHello." });
  });

  it("moves to the backup once the same-model repeats are empty too", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, thinkingOnly, "stop"))
        : stream(target, message(target, [{ type: "text", text: "from backup" }], "stop")),
    );

    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
    );

    expect(providers()).toEqual([
      primary.provider,
      primary.provider,
      primary.provider,
      backupA.provider,
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "from backup" });
  });

  it("shows the empty-response text only after every attempt is empty", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "stop")),
    );

    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
    );

    expect(providers()).toEqual([
      primary.provider,
      primary.provider,
      primary.provider,
      backupA.provider,
      backupA.provider,
      backupA.provider,
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "No response. Try again." });
  });

  it("does not repeat an empty reply in a run allowed to stay silent", async () => {
    providerState.stream.mockImplementation(() => stream(primary, message(primary, [], "stop")));
    const input = { ...request(), allowSilentEmpty: true };

    const events = await run(input);

    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("leaves an empty reply after tool work to the runtime's own follow-up", async () => {
    let calls = 0;
    providerState.stream.mockImplementation(() => {
      calls += 1;
      if (calls === 1)
        return stream(
          primary,
          message(
            primary,
            [{ type: "toolCall", id: "call", name: "write_effect", arguments: { value: "one" } }],
            "toolUse",
          ),
        );
      return stream(
        primary,
        message(primary, calls === 2 ? [] : [{ type: "text", text: "Done." }], "stop"),
      );
    });

    const events = await run(request());

    // The empty reply after the tool result is followed up with a prompt, not repeated as is.
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("keeps a discarded call's thinking out of a cancellation during the backoff", async () => {
    const controller = new AbortController();
    providerState.delay.mockImplementation(async () => controller.abort());
    providerState.stream.mockImplementation(() => {
      const final = message(primary, thinkingOnly, "stop");
      const result = new AssistantMessageEventStream();
      result.push({ type: "start", partial: { ...final, content: [] } });
      result.push({ type: "thinking_start", contentIndex: 0, partial: final });
      result.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Considering the answer.",
        partial: final,
      });
      result.push({
        type: "thinking_end",
        contentIndex: 0,
        content: "Considering the answer.",
        partial: final,
      });
      result.push({ type: "done", reason: "stop", message: final });
      result.end(final);
      return result;
    });
    const appendMessage = vi.fn(async (_entry: AgentMessage) => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const consume = async () => {
      for await (const _event of new PiAgentRuntime({ sessionRoot: "fixture-sessions" }).run(
        request(),
        {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: controller.signal,
        },
      )) {
        /* Consume the run. */
      }
    };

    await consume().catch(() => undefined);

    expect(providerState.delay).toHaveBeenCalledOnce();
    const assistants = appendMessage.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(JSON.stringify(assistants)).not.toContain("Considering the answer.");
  });

  it("stops repeating when the run is cancelled during the backoff", async () => {
    const controller = new AbortController();
    providerState.delay.mockImplementation(async () => controller.abort());
    providerState.stream.mockImplementation(() => stream(primary, message(primary, [], "stop")));
    const events: AgentRuntimeEvent[] = [];
    const consume = async () => {
      for await (const event of new PiAgentRuntime().run(request(), {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: controller.signal,
      })) {
        events.push(event);
      }
    };

    await consume().catch(() => undefined);

    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual({ type: "text", text: "No response. Try again." });
  });
});

describe("Pi runtime tool call ids", () => {
  it("keeps results paired when a provider repeats or omits tool call ids", async () => {
    const calls = (ids: string[]) =>
      ids.map((id, index) => ({
        type: "toolCall" as const,
        id,
        name: "write_effect",
        arguments: { value: `${id}-${index}` },
      }));
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, calls(["call_0", "call_1"]), "toolUse")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, calls(["call_0", "", ""]), "toolUse")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );

    const events = await run(request());

    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    const last = providerState.stream.mock.calls.at(-1)![1] as Context;
    const callIds = last.messages.flatMap((entry) =>
      entry.role === "assistant"
        ? entry.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
        : [],
    );
    expect(callIds).toEqual(["call_0", "call_1", "call_0_1", "call_2", "call_3"]);
    expect(
      last.messages.flatMap((entry) => (entry.role === "toolResult" ? [entry.toolCallId] : [])),
    ).toEqual(callIds);
  });
});
