import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerContextPrefix } from "./context-selection.js";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const claude: Model<"anthropic-messages"> = {
  provider: "anthropic",
  id: "binding-model",
  name: "binding-model",
  api: "anthropic-messages",
  baseUrl: "https://models.invalid",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

/** The prefix a signed thinking block is bound to: instructions, tools and earlier messages. */
function prefixSignature(context: Context, count: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        providerContextPrefix(
          context.systemPrompt ?? "",
          context.tools ?? [],
          context.messages.slice(0, count),
        ),
      ),
    )
    .digest("hex");
}

/** The first message whose thinking no longer matches the prefix it was signed with. */
function staleThinking(context: Context): number | undefined {
  const index = context.messages.findIndex(
    (message, position) =>
      message.role === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "thinking" && part.thinkingSignature !== prefixSignature(context, position),
      ),
  );
  return index < 0 ? undefined : index;
}

function reply(content: AssistantMessage["content"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: claude.api,
    provider: claude.provider,
    model: claude.id,
    usage: {
      input: 1000,
      output: 20,
      cacheRead: 900,
      cacheWrite: 0,
      totalTokens: 1020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage
      ? "error"
      : content.some((part) => part.type === "toolCall")
        ? "toolUse"
        : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(message: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...message, content: [] } });
  if (message.stopReason === "error") {
    result.push({ type: "error", reason: "error", error: message });
  } else {
    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type !== "toolCall") continue;
      result.push({ type: "toolcall_start", contentIndex, partial: message });
      result.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
    result.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  }
  result.end(message);
  return result;
}

/**
 * A provider that binds each thinking block to the conversation it was written in, as Claude
 * does: it signs every block with the request's prefix and rejects a request that replays a
 * block after anything before it changed.
 */
function bindingProvider(toolCalls: number) {
  const contexts: Context[] = [];
  const rejected: number[] = [];
  providerState.stream.mockImplementation((_model: unknown, context: Context) => {
    contexts.push(structuredClone(context));
    const stale = staleThinking(context);
    if (stale !== undefined) {
      rejected.push(contexts.length - 1);
      return stream(
        reply(
          [],
          `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.${stale}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation."}}`,
        ),
      );
    }
    const step = contexts.length - 1 - rejected.length;
    const thinking = {
      type: "thinking" as const,
      thinking: `Plan step ${step}`,
      thinkingSignature: prefixSignature(context, context.messages.length),
    };
    return stream(
      reply(
        step < toolCalls
          ? [
              thinking,
              { type: "toolCall", id: `call-${step}`, name: "fetch_logs", arguments: { step } },
            ]
          : [thinking, { type: "text", text: "Done." }],
      ),
    );
  });
  return { contexts, rejected };
}

function request(history: AgentRunRequest["history"] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Find out why the alarm fired",
    instructions: "Use tools when useful.",
    history,
    tools: [
      {
        name: "fetch_logs",
        description: "Fetch log lines for one step.",
        inputSchema: {
          type: "object",
          properties: { step: { type: "number" } },
          required: ["step"],
        },
        readOnly: true,
      },
    ],
    model: { provider: claude.provider, id: claude.id, apiKey: "fake-key", thinkingLevel: "high" },
    executeTool: vi.fn(async (_name: string, args: { step: number }) => ({
      lines: `log ${args.step} ${"synthetic log line ".repeat(300)}`,
    })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
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
  providerState.models.set(
    `${claude.provider}/${claude.id}`,
    claude as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
});

describe("Pi runtime transcript sent to a provider that binds thinking to its conversation", () => {
  it.each([
    ["without saved history", []],
    [
      "with saved history",
      Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        createdAt: "2026-01-01T00:00:00Z",
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        content: `Earlier discussion ${index}: ${"synthetic history ".repeat(40)}`,
      })),
    ],
  ] as const)("extends every call's transcript unchanged %s", async (_label, history) => {
    const toolCalls = 10;
    const { contexts, rejected } = bindingProvider(toolCalls);

    const events = await run(request([...history]));

    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    expect(rejected).toEqual([]);
    expect(contexts).toHaveLength(toolCalls + 1);
    for (let call = 1; call < contexts.length; call++) {
      const previous = contexts[call - 1]!;
      const current = contexts[call]!;
      expect(current.systemPrompt).toBe(previous.systemPrompt);
      expect(current.tools).toEqual(previous.tools);
      expect(current.messages.length).toBeGreaterThan(previous.messages.length);
      expect(JSON.stringify(current.messages.slice(0, previous.messages.length))).toBe(
        JSON.stringify(previous.messages),
      );
      for (const [index, message] of previous.messages.entries()) {
        expect(providerContextPrefix("", [], [current.messages[index]!])).toEqual(
          providerContextPrefix("", [], [message]),
        );
      }
    }
    // Every reasoning block written during the run reaches the last call, and nothing was cut.
    const last = contexts.at(-1)!;
    expect(
      last.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((part) => part.type === "thinking")
          : [],
      ),
    ).toHaveLength(toolCalls);
    expect(JSON.stringify(last)).not.toContain("truncated");
  });
});
