import { createHash } from "node:crypto";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextCacheTracker,
  estimateContextTokens,
  providerContextPrefix,
} from "./context-selection.js";
import { createRuntimeContextPolicy, rebuildPaysOff } from "./runtime-context.js";

const model = {
  id: "synthetic-model",
  provider: "synthetic-provider",
  baseUrl: "https://synthetic.invalid",
  contextWindow: 200_000,
  maxTokens: 4096,
} as Model<Api>;

type Step =
  | { tool: "shell"; text: string }
  | { tool: "browser_snapshot"; text: string }
  | { tool: "computer_observe"; screenshot: true }
  | { steer: string };

function request(overrides: Partial<AgentRunRequest> = {}, historyCount = 30): AgentRunRequest {
  return {
    botId: "bot",
    threadId: `thread-${Math.random()}`,
    runId: "run",
    instructions: "Stable instructions",
    prompt: "Current objective",
    history: Array.from({ length: historyCount }, (_, index) => ({
      id: `message-${index}`,
      createdAt: "2026-01-01T00:00:00Z",
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Original discussion ${index}: ${"synthetic history ".repeat(30)}`,
    })),
    tools: [],
    model: { provider: "synthetic-provider", id: "synthetic-model" },
    ...overrides,
  };
}

/** Pi's view of the run before the first model call: saved history, then the current prompt. */
function initialMessages(input: AgentRunRequest): Message[] {
  return [
    ...input.history.map(
      (item): Message =>
        ({
          role: "user",
          content: item.role === "assistant" ? `Assistant: ${item.content}` : item.content,
          timestamp: 0,
          rakazoHistory: true,
          rakazoMessageId: item.id,
        }) as Message,
    ),
    { role: "user", content: input.prompt, timestamp: 1 },
  ];
}

/**
 * Signs a reasoning block the way providers that bind reasoning to its conversation do: the
 * signature records the instructions, tools and every message before the block's message.
 */
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

/** Thinking blocks the provider would reject: their message's prefix changed since signing. */
function staleThinking(context: Context): number[] {
  return context.messages.flatMap((message, index) =>
    message.role === "assistant" &&
    message.content.some(
      (part) =>
        part.type === "thinking" && part.thinkingSignature !== prefixSignature(context, index),
    )
      ? [index]
      : [],
  );
}

function thinkingCount(context: Context): number {
  return context.messages.reduce(
    (count, message) =>
      count +
      (message.role === "assistant"
        ? message.content.filter((part) => part.type === "thinking").length
        : 0),
    0,
  );
}

function imageCount(context: Context): number {
  return context.messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? (message.content as Array<{ type: string }>).filter((part) => part.type === "image")
            .length
        : 0),
    0,
  );
}

/** Whether `next` sends everything `previous` sent, unchanged, before anything new. */
function extendsPrevious(previous: Context, next: Context): boolean {
  return (
    previous.systemPrompt === next.systemPrompt &&
    JSON.stringify(previous.tools ?? []) === JSON.stringify(next.tools ?? []) &&
    next.messages.length >= previous.messages.length &&
    JSON.stringify(next.messages.slice(0, previous.messages.length)) ===
      JSON.stringify(previous.messages) &&
    JSON.stringify(
      providerContextPrefix("", [], next.messages.slice(0, previous.messages.length)),
    ) === JSON.stringify(providerContextPrefix("", [], previous.messages))
  );
}

/**
 * Runs a tool loop through one policy, as the Pi runtime does: every model call gets the run's
 * messages so far, and the model answers each call with signed thinking and a tool call.
 */
function simulateRun(
  input: AgentRunRequest,
  steps: Step[],
  options: {
    cacheTracker?: ContextCacheTracker;
    tick?: () => void;
    systemPrompt?: (step: number) => string;
    /** The model's reasoning carries no signature, as from OpenAI-compatible providers. */
    unsigned?: boolean;
    /** The model the run talks to; the default is a hosted provider. */
    model?: Model<Api>;
  } = {},
) {
  const policy = createRuntimeContextPolicy(input, undefined, {
    cacheTracker: options.cacheTracker,
  });
  const messages = initialMessages(input);
  const sent: Context[] = [];
  const send = (step: number) => {
    const context = policy.prepareContext(
      {
        systemPrompt: options.systemPrompt?.(step) ?? input.instructions,
        tools: [],
        messages: [...messages],
      },
      options.model ?? model,
    );
    sent.push(context);
    policy.onUsage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900 });
    options.tick?.();
    return context;
  };
  for (const [index, step] of steps.entries()) {
    const context = send(index);
    if ("steer" in step) {
      messages.push({ role: "user", content: step.steer, timestamp: 1000 + index });
      continue;
    }
    const id = `call-${index}`;
    messages.push({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `Plan step ${index}`,
          ...(options.unsigned
            ? {}
            : { thinkingSignature: prefixSignature(context, context.messages.length) }),
        },
        { type: "toolCall", id, name: step.tool, arguments: {} },
      ],
      timestamp: 1000 + index,
    } as unknown as Message);
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: step.tool,
      content:
        "screenshot" in step
          ? [{ type: "image", data: `frame-${index}`, mimeType: "image/png" }]
          : [{ type: "text", text: step.text }],
      ...("screenshot" in step ? { details: { frameId: `frame-${index}` } } : {}),
      isError: false,
      timestamp: 1000 + index,
    } as Message);
  }
  send(steps.length);
  return sent;
}

/** Indexes of calls whose transcript did not extend the previous call's transcript. */
function rewrites(sent: Context[]): number[] {
  return sent.flatMap((context, index) =>
    index > 0 && !extendsPrevious(sent[index - 1]!, context) ? [index] : [],
  );
}

const toolHeavyRun: Step[] = [
  { tool: "shell", text: `first log line ${"synthetic shell output ".repeat(500)}` },
  { tool: "browser_snapshot", text: `page one ${"node ".repeat(400)}` },
  { tool: "computer_observe", screenshot: true },
  { tool: "shell", text: "synthetic shell output ".repeat(500) },
  { tool: "browser_snapshot", text: `page two ${"node ".repeat(400)}` },
  { tool: "computer_observe", screenshot: true },
  { steer: "Also check the second dashboard" },
  { tool: "browser_snapshot", text: `page three ${"node ".repeat(400)}` },
  { tool: "computer_observe", screenshot: true },
  { tool: "browser_snapshot", text: `page four ${"node ".repeat(400)}` },
  { tool: "shell", text: "synthetic shell output ".repeat(500) },
  { tool: "computer_observe", screenshot: true },
  { tool: "browser_snapshot", text: `page five ${"node ".repeat(400)}` },
];

describe("append-only run transcript", () => {
  it.each(["current", "retrieval", "snapshots", "cache-aware"] as const)(
    "never rewrites what a %s run already sent",
    (contextStrategy) => {
      const sent = simulateRun(request({ contextStrategy }), toolHeavyRun);
      expect(sent).toHaveLength(toolHeavyRun.length + 1);
      expect(rewrites(sent)).toEqual([]);
      for (const context of sent) expect(staleThinking(context)).toEqual([]);
      // Old tool output, page state and screenshots stay as first sent; nothing was trimmed.
      const last = JSON.stringify(sent.at(-1));
      expect(last).toContain("first log line");
      expect(last).toContain("page one");
      expect(last).not.toContain("Tool result truncated");
      expect(last).not.toContain("Earlier page state trimmed");
      expect(imageCount(sent.at(-1)!)).toBe(4);
      expect(thinkingCount(sent.at(-1)!)).toBe(toolHeavyRun.length - 1);
    },
  );

  it("keeps the history it chose while the predicted cache warmth changes mid-run", () => {
    let now = 0;
    const cacheTracker = new ContextCacheTracker(() => now);
    const input = request({
      contextStrategy: "cache-aware",
      model: {
        provider: "synthetic-provider",
        id: "synthetic-model",
        cacheCapabilities: { scope: "account", retentionMs: 300_000, minimumTokens: 1 },
      },
    });
    // Every other call lands after the cache window, so a fresh selection would flip between
    // full history and navigation snapshots.
    const sent = simulateRun(input, toolHeavyRun, {
      cacheTracker,
      tick: () => {
        now += now % 2 ? 1 : 400_000;
      },
    });
    expect(rewrites(sent)).toEqual([]);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
  });

  it("sends the same transcript again when a call is retried", () => {
    const input = request({ contextStrategy: "retrieval" });
    const policy = createRuntimeContextPolicy(input);
    const context: Context = {
      systemPrompt: input.instructions,
      tools: [],
      messages: initialMessages(input),
    };
    const first = policy.prepareContext(context, model);
    expect(policy.prepareContext(context, model).messages).toEqual(first.messages);
  });

  it("rebuilds once the run outgrows the model, then appends again", () => {
    const small = {
      ...model,
      contextWindow: 40_000,
    } as Model<Api>;
    const input = request({
      contextStrategy: "retrieval",
      model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: 40_000 },
    });
    const steps: Step[] = Array.from({ length: 30 }, (_, index) => ({
      tool: "shell",
      text: `output ${index} ${"synthetic shell output ".repeat(433)}`,
    }));
    const sent = simulateRun(input, steps);
    const rebuilt = rewrites(sent);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.length).toBeLessThan(steps.length / 4);
    // Each rebuild leaves room, so the next calls append instead of rebuilding again.
    for (const index of rebuilt) expect(rebuilt).not.toContain(index + 1);
    for (const context of sent) {
      expect(staleThinking(context)).toEqual([]);
      expect(JSON.stringify(context).length / 4).toBeLessThan(small.contextWindow);
    }
  });

  it("keeps thinking before the first rewritten message and drops it after", () => {
    const input = request({
      contextStrategy: "retrieval",
      model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: 40_000 },
    });
    const steps: Step[] = [
      { tool: "shell", text: "short" },
      { tool: "shell", text: "short" },
      ...Array.from({ length: 16 }, (_, index) => ({
        tool: "shell" as const,
        text: `output ${index} ${"synthetic shell output ".repeat(433)}`,
      })),
    ];
    const sent = simulateRun(input, steps);
    const [first] = rewrites(sent);
    expect(first).toBeDefined();
    const rebuilt = sent[first!]!;
    expect(staleThinking(rebuilt)).toEqual([]);
    // History and the two short steps stay byte-for-byte stable. Keeping larger recent
    // results must not evict that prefix and invalidate all of its signed thinking.
    const previous = sent[first! - 1]!;
    const firstLargeResult = previous.messages.findIndex(
      (message) => message.role === "toolResult" && message.toolCallId === "call-2",
    );
    expect(firstLargeResult).toBeGreaterThan(0);
    expect(rebuilt.messages.slice(0, firstLargeResult)).toEqual(
      previous.messages.slice(0, firstLargeResult),
    );
    // The two short results were not rewritten, so the thinking before them survives.
    const kept = rebuilt.messages.filter(
      (message) =>
        message.role === "assistant" && message.content.some((part) => part.type === "thinking"),
    );
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(thinkingCount(rebuilt)).toBeLessThan(thinkingCount(sent[first! - 1]!));
  });

  it("rebuilds at the model's image limit and keeps the two latest screenshots", () => {
    const input = request({
      contextStrategy: "retrieval",
      model: { provider: "synthetic-provider", id: "synthetic-model", maxImagesPerPrompt: 5 },
    });
    const steps: Step[] = Array.from({ length: 10 }, () => ({
      tool: "computer_observe",
      screenshot: true,
    }));
    const sent = simulateRun(input, steps);
    expect(sent.map(imageCount)).toEqual([0, 1, 2, 3, 4, 5, 2, 3, 4, 5, 2]);
    expect(rewrites(sent)).toEqual([6, 10]);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
  });

  it("keeps unsigned thinking through a rebuild", () => {
    const input = request({
      contextStrategy: "retrieval",
      model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: 40_000 },
    });
    const steps: Step[] = Array.from({ length: 18 }, (_, index) => ({
      tool: "shell" as const,
      text: `output ${index} ${"synthetic shell output ".repeat(433)}`,
    }));
    const sent = simulateRun(input, steps, { unsigned: true });
    const [first] = rewrites(sent);
    expect(first).toBeDefined();
    // Nothing the model wrote can be rejected, so the rebuild drops none of it.
    expect(thinkingCount(sent[first!]!)).toBe(thinkingCount(sent[first! - 1]!) + 1);
  });

  it("rebuilds a browsing run only when dropping stale pages pays for the broken cache", () => {
    const input = request({ contextStrategy: "retrieval" }, 0);
    const steps: Step[] = Array.from({ length: 24 }, (_, index) => ({
      tool: "browser_snapshot",
      text: `page ${index} ${"node ".repeat(4_000)}`,
    }));
    const sent = simulateRun(input, steps);
    const rebuilt = rewrites(sent);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.length).toBeLessThanOrEqual(steps.length / 4);
    for (const index of rebuilt) expect(rebuilt).not.toContain(index + 1);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
    expect(JSON.stringify(sent.at(-1))).toContain("Earlier page state trimmed");
  });

  it("keeps steering through a rebuild that reuses the previous call's projection", () => {
    const cacheTracker = new ContextCacheTracker(() => 0);
    const input = request({
      contextStrategy: "cache-aware",
      model: {
        provider: "synthetic-provider",
        id: "synthetic-model",
        maxImagesPerPrompt: 3,
        cacheCapabilities: { scope: "account", retentionMs: 300_000, minimumTokens: 1 },
      },
    });
    const steps: Step[] = [
      { tool: "shell", text: "listing" },
      { steer: "Never delete files" },
      ...Array.from({ length: 5 }, (): Step => ({ tool: "computer_observe", screenshot: true })),
    ];
    const sent = simulateRun(input, steps, { cacheTracker });
    expect(rewrites(sent).length).toBeGreaterThan(0);
    for (const context of sent.slice(2)) {
      expect(JSON.stringify(context.messages)).toContain("Never delete files");
    }
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
  });

  it("drops earlier thinking when the instructions change mid-run", () => {
    const input = request({ contextStrategy: "retrieval" });
    const sent = simulateRun(input, toolHeavyRun.slice(0, 4), {
      systemPrompt: (step) => (step < 3 ? "Stable instructions" : "Changed instructions"),
    });
    expect(rewrites(sent)).toEqual([3]);
    expect(thinkingCount(sent[3]!)).toBe(0);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
    expect(extendsPrevious(sent[3]!, sent[4]!)).toBe(true);
  });
});

/** Size as the policy measures it: a conservative byte estimate of the whole prefix. */
function size(context: Context): number {
  return estimateContextTokens(
    providerContextPrefix(context.systemPrompt ?? "", context.tools ?? [], context.messages),
  );
}

/** Drives one policy call by call, for sequences `simulateRun` can't express. */
function driver(input: AgentRunRequest, callModel: Model<Api> = model) {
  const policy = createRuntimeContextPolicy(input);
  const messages = initialMessages(input);
  const sent: Context[] = [];
  const state = { systemPrompt: input.instructions, tools: [] as NonNullable<Context["tools"]> };
  return {
    policy,
    messages,
    sent,
    state,
    send(sourceMessages: Message[] = [...messages], at: Model<Api> = callModel) {
      const context = policy.prepareContext(
        { systemPrompt: state.systemPrompt, tools: state.tools, messages: sourceMessages },
        at,
      );
      sent.push(context);
      policy.onUsage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900 });
      return context;
    },
    /** The model answers `context` with signed thinking and a tool call, and the tool replies. */
    act(context: Context, id: string, text: string) {
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: `Plan ${id}`,
              thinkingSignature: prefixSignature(context, context.messages.length),
            },
            { type: "toolCall", id, name: "shell", arguments: {} },
          ],
          timestamp: 2,
        } as unknown as Message,
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "shell",
          content: [{ type: "text", text }],
          isError: false,
          timestamp: 3,
        } as Message,
      );
    },
  };
}

describe("append-only run transcript boundaries", () => {
  it("rebuilds for stale text only from the minimum saving on", () => {
    const fresh = { tokens: 1_000, images: 0 };
    // Growth 0 isolates the minimum saving.
    expect(rebuildPaysOff({ tokens: 17_383, images: 0 }, fresh, 17_383, 0)).toBe(false);
    expect(rebuildPaysOff({ tokens: 17_384, images: 0 }, fresh, 17_384, 0)).toBe(true);
  });

  it("rebuilds exactly when stale content reaches the cost balance", () => {
    // stale 20,000; 25 × fresh 16,000 × growth 1,000 = 20,000²
    const kept = { tokens: 36_000, images: 0 };
    const fresh = { tokens: 16_000, images: 0 };
    expect(rebuildPaysOff(kept, fresh, 32_000, 3)).toBe(true);
    expect(rebuildPaysOff(kept, fresh, 31_996, 3)).toBe(false);
  });

  it("rebuilds once eight stale images could be dropped, not at seven", () => {
    const fresh = { tokens: 1_000, images: 2 };
    expect(rebuildPaysOff({ tokens: 1_000, images: 9 }, fresh, 1_000, 0)).toBe(false);
    expect(rebuildPaysOff({ tokens: 1_000, images: 10 }, fresh, 1_000, 0)).toBe(true);
  });

  it("never rebuilds when the rebuilt transcript would be larger", () => {
    expect(rebuildPaysOff({ tokens: 50_000, images: 0 }, { tokens: 80_000, images: 0 }, 0, 0)).toBe(
      false,
    );
  });

  it("appends at exactly the available budget and rebuilds one token over it", () => {
    const outcome = (headroom: number) => {
      const run = driver(request({ contextStrategy: "retrieval" }, 0));
      run.act(run.send(), "a", `old ${"0".repeat(5_000)}`);
      const first = run.send();
      run.act(first, "b", "ok");
      const appendedSize = size({
        ...first,
        messages: [...first.messages, ...run.messages.slice(-2)],
      });
      // Keep the output reserve below the quarter-window clamp so this isolates input fit.
      const tight = { ...model, maxTokens: 1024, contextWindow: appendedSize + 1024 + headroom };
      const next = run.send(undefined, tight as Model<Api>);
      expect(staleThinking(next)).toEqual([]);
      return extendsPrevious(first, next);
    };
    expect(outcome(0)).toBe(true);
    expect(outcome(-1)).toBe(false);
  });

  it("adds the after-use note only on rebuild, then preserves it exactly once", () => {
    const run = driver(request({ contextStrategy: "retrieval" }, 0));
    run.act(run.send(), "a", `old ${"0".repeat(5_000)}`);
    const first = run.send();
    run.act(first, "b", "ok");
    const second = run.send();
    expect(extendsPrevious(first, second)).toBe(true);
    expect(JSON.stringify(second)).not.toContain("Earlier result shortened after you read it");

    run.act(second, "c", "ok");
    run.act(run.send(), "d", "ok");
    run.send();

    // Force a rebuild whose evidence budget cannot retain the oldest result.
    run.state.systemPrompt = "Changed instructions";
    const rebuilt = run.send(undefined, { ...model, contextWindow: 7000, maxTokens: 1024 });
    const result = rebuilt.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "a",
    );
    const serialized = JSON.stringify(result);
    expect(serialized.split("Earlier result shortened after you read it")).toHaveLength(2);
    expect(serialized).not.toContain("unavailable");
    expect(staleThinking(rebuilt)).toEqual([]);
    run.act(rebuilt, "e", "ok");
    const next = run.send();
    expect(extendsPrevious(rebuilt, next)).toBe(true);
    expect(
      JSON.stringify(
        next.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "a",
        ),
      ),
    ).toBe(serialized);
  });

  it("keeps screenshots within the image limit while text alone overflows the window", () => {
    const input = request(
      {
        contextStrategy: "current",
        model: {
          provider: "synthetic-provider",
          id: "synthetic-model",
          contextWindow: 30_000,
          maxImagesPerPrompt: 5,
        },
      },
      0,
    );
    const steps: Step[] = Array.from({ length: 25 }, (_, index) =>
      index % 2
        ? { tool: "computer_observe", screenshot: true }
        : { tool: "shell", text: `output ${index} ${"synthetic shell output ".repeat(500)}` },
    );
    const sent = simulateRun(input, steps);
    expect(Math.max(...sent.map(imageCount))).toBeLessThanOrEqual(5);
    expect(Math.max(...sent.map(size))).toBeGreaterThan(30_000);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
  });

  it("keeps appending when a rebuild cannot bring the text under the window either", () => {
    const input = request(
      {
        contextStrategy: "current",
        model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: 20_000 },
      },
      0,
    );
    const steps: Step[] = Array.from({ length: 12 }, (_, index) => ({
      tool: "shell",
      text: `output ${index} ${"synthetic shell output ".repeat(500)}`,
    }));
    const sent = simulateRun(input, steps);
    expect(Math.max(...sent.map(size))).toBeGreaterThan(20_000);
    expect(rewrites(sent)).toEqual([]);
  });

  it("leaves a quarter of the window free after a rebuild the window forced", () => {
    const window = 40_000;
    const input = request({
      contextStrategy: "retrieval",
      model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: window },
    });
    const steps: Step[] = Array.from({ length: 30 }, (_, index) => ({
      tool: "shell",
      text: `output ${index} ${"synthetic shell output ".repeat(433)}`,
    }));
    const sent = simulateRun(input, steps);
    const rebuilt = rewrites(sent);
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const index of rebuilt) {
      expect(size(sent[index]!)).toBeLessThanOrEqual(Math.floor((window - model.maxTokens) * 0.75));
    }
  });

  it("falls back to the full window when the current turn needs more than the headroom allows", () => {
    const window = 40_000;
    const available = window - model.maxTokens;
    const input = request(
      {
        contextStrategy: "retrieval",
        prompt: `Current objective ${"0".repeat(Math.floor(available * 0.8))}`,
        model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: window },
      },
      0,
    );
    const steps: Step[] = Array.from({ length: 4 }, (_, index) => ({
      tool: "shell",
      text: `output ${index} ${"0".repeat(4_000)}`,
    }));
    const sent = simulateRun(input, steps);
    expect(rewrites(sent).length).toBeGreaterThan(0);
    for (const context of sent) {
      expect(size(context)).toBeLessThanOrEqual(available);
      expect(staleThinking(context)).toEqual([]);
      expect(JSON.stringify(context)).toContain("Current objective");
    }
  });

  it.each(["retrieval", "snapshots"] as const)(
    "keeps the unread tool step after steering forces a %s window rebuild",
    (contextStrategy) => {
      const window = 40_000;
      const run = driver(
        request(
          {
            contextStrategy,
            model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: window },
          },
          contextStrategy === "snapshots" ? 30 : 0,
        ),
      );
      const previous = run.send();
      run.act(previous, "pending", "huge ".repeat(30_000));
      run.messages.push({ role: "user", content: "Also check the summary", timestamp: 4 });
      expect(size({ ...previous, messages: run.messages })).toBeGreaterThan(window);
      const next = run.send();
      expect(size(next)).toBeLessThanOrEqual(window - model.maxTokens);
      expect(
        next.messages.find((message) => message.role === "assistant")?.content ?? [],
      ).toContainEqual({
        type: "toolCall",
        id: "pending",
        name: "shell",
        arguments: {},
      });
      const result = next.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolCallId: "pending" });
      expect(JSON.stringify(result?.content)).toContain("Tool result truncated");
      expect(JSON.stringify(result?.content)).not.toContain("Earlier result shortened");
      expect(next.messages.at(-1)).toMatchObject({
        role: "user",
        content: "Also check the summary",
      });
      expect(staleThinking(next)).toEqual([]);
    },
  );

  it("rebuilds when the newest result alone overflows the window", () => {
    const window = 40_000;
    const input = request(
      {
        contextStrategy: "retrieval",
        model: { provider: "synthetic-provider", id: "synthetic-model", contextWindow: window },
      },
      0,
    );
    const sent = simulateRun(input, [
      { tool: "shell", text: "small" },
      { tool: "shell", text: `huge ${"0".repeat(60_000)}` },
    ]);
    const last = sent.at(-1)!;
    expect(size(last)).toBeLessThanOrEqual(window - model.maxTokens);
    expect(JSON.stringify(last)).toContain("truncated");
    expect(staleThinking(last)).toEqual([]);
  });

  it("rebuilds without stale thinking when the run sends fewer messages than before", () => {
    const run = driver(request({ contextStrategy: "retrieval" }, 0));
    for (const id of ["a", "b", "c"]) run.act(run.send(), id, `result ${id}`);
    const full = run.send();
    const shorter = run.send(run.messages.slice(0, -2));
    expect(extendsPrevious(full, shorter)).toBe(false);
    expect(staleThinking(shorter)).toEqual([]);
  });

  it("keeps thinking before an edited earlier message and drops it from there on", () => {
    const run = driver(request({ contextStrategy: "retrieval" }, 0));
    for (const id of ["a", "b", "c", "d"]) run.act(run.send(), id, `result ${id}`);
    run.send();
    // Edit the result of tool call "b" (prompt, a-call, a-result, b-call, b-result, ...).
    const edited = [...run.messages];
    edited[4] = {
      ...(edited[4] as Message),
      content: [{ type: "text", text: "edited" }],
    } as Message;
    const next = run.send(edited);
    expect(staleThinking(next)).toEqual([]);
    const thinkingAt = next.messages.map((message) =>
      message.role === "assistant"
        ? message.content.some((part) => part.type === "thinking")
        : null,
    );
    expect(thinkingAt).toEqual([null, true, null, true, null, false, null, false, null]);
    run.act(next, "e", "result e");
    expect(extendsPrevious(next, run.send([...edited, ...run.messages.slice(-2)]))).toBe(true);
  });

  it("drops all earlier thinking when the tools change, then appends again", () => {
    const run = driver(request({ contextStrategy: "retrieval" }, 0));
    for (const id of ["a", "b"]) run.act(run.send(), id, `result ${id}`);
    run.send();
    run.state.tools = [
      { name: "shell", description: "Run", parameters: { type: "object" } },
    ] as never;
    const changed = run.send();
    expect(thinkingCount(changed)).toBe(0);
    expect(staleThinking(changed)).toEqual([]);
    run.act(changed, "c", "result c");
    expect(extendsPrevious(changed, run.send())).toBe(true);
  });

  it("is not affected by a caller that later grows the array it passed in", () => {
    const run = driver(request({ contextStrategy: "current" }, 0));
    const live = [...run.messages];
    const first = run.send(live);
    expect(first.messages).toBe(live);
    run.act(first, "a", "result a");
    live.push(...run.messages.slice(-2));
    const next = run.send(live);
    expect(next.messages).toHaveLength(live.length);
    expect(extendsPrevious({ ...first, messages: live.slice(0, 1) }, next)).toBe(true);
  });

  it("never sends more than one image under a one-image limit", () => {
    const input = request(
      {
        contextStrategy: "retrieval",
        model: { provider: "synthetic-provider", id: "synthetic-model", maxImagesPerPrompt: 1 },
      },
      0,
    );
    const steps: Step[] = Array.from({ length: 6 }, () => ({
      tool: "computer_observe",
      screenshot: true,
    }));
    const sent = simulateRun(input, steps);
    expect(sent.map(imageCount)).toEqual([0, 1, 1, 1, 1, 1, 1]);
    for (const context of sent) expect(staleThinking(context)).toEqual([]);
  });

  it("rebuilds an unlimited run once eight stale screenshots could be dropped", () => {
    const input = request({ contextStrategy: "retrieval" }, 0);
    const steps: Step[] = Array.from({ length: 24 }, () => ({
      tool: "computer_observe",
      screenshot: true,
    }));
    const sent = simulateRun(input, steps);
    expect(Math.max(...sent.map(imageCount))).toBe(9);
    expect(rewrites(sent)).toEqual([10, 18]);
    expect(imageCount(sent[10]!)).toBe(2);
  });
});

describe("local prompt cache declared off", () => {
  const local = { ...model, provider: "local" } as Model<Api>;
  const pages: Step[] = Array.from({ length: 12 }, (_, index) => ({
    tool: "browser_snapshot" as const,
    text: `page ${index} ${"node ".repeat(1_200)}`,
  }));
  const lastPrompt = (provider: Model<Api>) =>
    simulateRun(request({ contextStrategy: "current" }), pages, { model: provider }).at(-1)!;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the append-only transcript when the setting is unset", () => {
    const sent = simulateRun(request({ contextStrategy: "current" }), pages, { model: local });
    expect(rewrites(sent)).toEqual([]);
    expect(JSON.stringify(sent.at(-1))).not.toContain("Earlier page state trimmed");
  });

  it("trims stale page state once enough has built up when set to off", () => {
    const cached = lastPrompt(local);
    vi.stubEnv("RAKAZO_LOCAL_PROMPT_CACHE", "off");
    const trimmed = lastPrompt(local);
    expect(JSON.stringify(trimmed)).toContain("Earlier page state trimmed");
    expect(estimateContextTokens(trimmed)).toBeLessThan(estimateContextTokens(cached) * 0.7);
  });

  it("does not shrink a prompt below the threshold", () => {
    vi.stubEnv("RAKAZO_LOCAL_PROMPT_CACHE", "off");
    const sent = simulateRun(request({ contextStrategy: "current" }), pages.slice(0, 2), {
      model: local,
    });
    expect(rewrites(sent)).toEqual([]);
  });

  it("applies to the local provider only", () => {
    vi.stubEnv("RAKAZO_LOCAL_PROMPT_CACHE", "off");
    expect(rewrites(simulateRun(request({ contextStrategy: "current" }), pages))).toEqual([]);
  });

  it("keeps unsigned thinking on the rebuilds it triggers", () => {
    vi.stubEnv("RAKAZO_LOCAL_PROMPT_CACHE", "off");
    const sent = simulateRun(request({ contextStrategy: "current" }), pages, {
      model: local,
      unsigned: true,
    });
    expect(rewrites(sent).length).toBeGreaterThan(0);
    expect(thinkingCount(sent.at(-1)!)).toBe(pages.length);
  });
});

describe("rebuildPaysOff with the prompt cache off", () => {
  const kept = { tokens: 60_000, images: 0 };
  it("rebuilds from 3,000 stale tokens on, and never when nothing is stale", () => {
    expect(rebuildPaysOff(kept, { tokens: 57_000, images: 0 }, 55_000, 4, true)).toBe(true);
    expect(rebuildPaysOff(kept, { tokens: 57_001, images: 0 }, 55_000, 4, true)).toBe(false);
    expect(rebuildPaysOff(kept, { tokens: 60_000, images: 0 }, 55_000, 4, true)).toBe(false);
  });
  it("leaves the cached cost balance alone by default", () => {
    expect(rebuildPaysOff(kept, { tokens: 50_000, images: 0 }, 55_000, 4)).toBe(false);
  });
});
