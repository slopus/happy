import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { MODEL_OUTPUT_CUT_ERROR, MODEL_OUTPUT_LIMIT_ERROR } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
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
import { continuationOverlap, continuationRepeat } from "./pi-runtime-fallback.js";

// A plain model with a card ceiling above the 4k completion default, and a reasoning model
// already at its 32k default with the input reserve as the limit.
const plain = model("provider-a", "plain", { reasoning: false, maxTokens: 65_536 });
const reasoner = model("provider-a", "reasoner", {
  reasoning: true,
  maxTokens: 65_536,
  contextWindow: 131_072,
});
const backup = model("provider-b", "backup", { reasoning: false, maxTokens: 65_536 });

function model(
  provider: string,
  id: string,
  { reasoning, maxTokens, contextWindow = 1_000_000 }: Partial<Model<"openai-completions">>,
): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokens ?? 4_096,
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

/**
 * Streams thinking deltas first, as a reasoning model does, then any reply text as it would
 * arrive live, then the terminal event.
 */
function stream(response: AssistantMessage, thinking?: string, text?: string) {
  const result = new AssistantMessageEventStream();
  const empty = { ...response, content: [], stopReason: "stop" as const };
  result.push({ type: "start", partial: empty });
  if (thinking) {
    const partial = { ...empty, content: [{ type: "thinking" as const, thinking }] };
    result.push({ type: "thinking_start", contentIndex: 0, partial: empty });
    result.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial });
    result.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial });
  }
  if (text) {
    const partial = { ...empty, content: [{ type: "text" as const, text }] };
    result.push({ type: "text_start", contentIndex: 0, partial: empty });
    result.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  }
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({ type: "error", reason: response.stopReason, error: response });
  } else {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({ type: "toolcall_start", contentIndex: 0, partial: { ...empty } });
      result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    }
    const reason =
      response.stopReason === "length" ? "length" : call ? ("toolUse" as const) : "stop";
    result.push({ type: "done", reason, message: response });
  }
  result.end(response);
  return result;
}

const thinkingOnly = (
  target: Model<"openai-completions">,
  stopReason: "length" | "error",
  error?: string,
) =>
  stream(
    message(target, [{ type: "thinking", thinking: "planning" }], stopReason, error),
    "planning",
  );
const reply = (target: Model<"openai-completions">, text = "Recovered.") =>
  stream(message(target, [{ type: "text", text }], "stop"));
const toolCall = (target: Model<"openai-completions">, id: string) =>
  stream(
    message(
      target,
      [{ type: "toolCall", id, name: "write_effect", arguments: { value: id } }],
      "toolUse",
    ),
  );

function request(
  target: Model<"openai-completions">,
  extra: Partial<AgentRunRequest["model"]> = {},
  fallbackModels: AgentRunRequest["model"][] = [],
): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Do the task",
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
    model: { provider: target.provider, id: target.id, apiKey: "fake-key", ...extra },
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest, signal = new AbortController().signal) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal,
  })) {
    events.push(event);
  }
  return events;
}

type StreamOptions = { maxTokens?: number; reasoning?: string };
const sentOptions = () =>
  providerState.stream.mock.calls.map(([, , options]) => options as StreamOptions);
const sentContexts = () =>
  providerState.stream.mock.calls.map(([, context]) => JSON.stringify(context));
const texts = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : []));

beforeEach(() => {
  providerState.models.clear();
  for (const candidate of [plain, reasoner, backup]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

describe("a call that has only thought has not started", () => {
  it.each([
    "terminated",
    "Stream ended without finish_reason",
    "Provider finish_reason: network_error",
  ])("retries %s after thinking, discarding that thinking", async (error) => {
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(plain, "error", error))
      .mockImplementation(() => reply(plain));
    const events = await run(request(plain));
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
    // The retry is the same request: the cut attempt's thinking is not sent back.
    const [first, second] = sentContexts();
    expect(second).toBe(first);
    expect(texts(events)).toEqual(["Recovered."]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
  });

  it("moves to the backup model after thinking, when the provider is unavailable", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === plain.provider
        ? thinkingOnly(plain, "error", "HTTP 503 unavailable")
        : reply(target, "From the backup."),
    );
    const events = await run(
      request(plain, {}, [{ provider: backup.provider, id: backup.id, apiKey: "backup-key" }]),
    );
    expect(providerState.stream.mock.calls.map(([target]) => target.id)).toEqual([
      plain.id,
      backup.id,
    ]);
    expect(texts(events)).toContain("From the backup.");
  });

  it("does not repeat a tool that ran before the cut", async () => {
    providerState.stream
      .mockImplementationOnce(() => toolCall(plain, "effect-1"))
      .mockImplementationOnce(() => thinkingOnly(plain, "error", "terminated"))
      .mockImplementation(() => reply(plain, "Done."));
    const input = request(plain);
    const events = await run(input);
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("still fails a cut after reply text, which would be shown twice if repeated", async () => {
    providerState.stream.mockImplementation(() =>
      stream(message(plain, [{ type: "text", text: "1. Open `the" }], "error", "terminated")),
    );
    await expect(run(request(plain))).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("stops at once when the run is stopped while waiting to retry", async () => {
    const controller = new AbortController();
    providerState.delay.mockImplementation(async () => controller.abort());
    providerState.stream.mockImplementation(() => thinkingOnly(plain, "error", "terminated"));
    await expect(run(request(plain), controller.signal)).rejects.toThrow(/abort|stop/i);
    expect(providerState.stream).toHaveBeenCalledOnce();
  });
});

describe("a call that spends its whole output budget on thinking", () => {
  it("is repeated once with double the budget, and the turn goes on", async () => {
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(plain, "length"))
      .mockImplementation(() => reply(plain));
    const events = await run(request(plain));
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192]);
    const [first, second] = sentContexts();
    expect(second).toBe(first);
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
  });

  it("fails as before when the repeat runs out too, without a third call", async () => {
    providerState.stream.mockImplementation(() => thinkingOnly(plain, "length"));
    await expect(run(request(plain))).rejects.toThrow(
      "The model hit its output limit before writing a response.",
    );
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("thinks one level less when the budget is already at the input reserve", async () => {
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(reasoner, "length"))
      .mockImplementation(() => reply(reasoner));
    await run(request(reasoner, { thinkingLevel: "high" }));
    expect(sentOptions().map(({ maxTokens, reasoning }) => [maxTokens, reasoning])).toEqual([
      [32_768, "high"],
      [32_768, "medium"],
    ]);
  });

  it("keeps a budget the user set and thinks less instead", async () => {
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(reasoner, "length"))
      .mockImplementation(() => reply(reasoner));
    await run(request(reasoner, { maxTokens: 2_000 }));
    expect(sentOptions().map(({ maxTokens, reasoning }) => [maxTokens, reasoning])).toEqual([
      [2_000, "medium"],
      [2_000, "low"],
    ]);
  });

  it("never turns thinking on when the user turned it off", async () => {
    providerState.stream.mockImplementation(() => thinkingOnly(reasoner, "length"));
    await expect(
      run(request(reasoner, { maxTokens: 2_000, thinkingLevel: "off" })),
    ).rejects.toThrow("The model hit its output limit before writing a response.");
    expect(sentOptions().map(({ maxTokens, reasoning }) => [maxTokens, reasoning])).toEqual([
      [2_000, undefined],
    ]);
  });

  it("gives a backup model its own budget, not the raised one", async () => {
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(plain, "length"))
      .mockImplementationOnce(() => thinkingOnly(plain, "error", "HTTP 503 unavailable"))
      .mockImplementation(() => reply(backup, "From the backup."));
    const events = await run(
      request(plain, {}, [{ provider: backup.provider, id: backup.id, apiKey: "backup-key" }]),
    );
    expect(
      providerState.stream.mock.calls.map(([target, , options]) => [
        target.id,
        (options as StreamOptions).maxTokens,
      ]),
    ).toEqual([
      [plain.id, 4_096],
      [plain.id, 8_192],
      [backup.id, 4_096],
    ]);
    expect(texts(events)).toContain("From the backup.");
  });

  it.each([
    ["an unavailable provider", () => thinkingOnly(plain, "error", "HTTP 503 unavailable"), 1],
    ["empty replies", () => stream(message(plain, [], "stop")), 3],
  ])(
    "lets a backup reached after %s repeat its own call that spent its budget",
    async (_case, failure, failedCalls) => {
      let primaryCalls = 0;
      let backupCalls = 0;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        if (target.id === plain.id) {
          primaryCalls += 1;
          return primaryCalls === 1 ? thinkingOnly(plain, "length") : failure();
        }
        backupCalls += 1;
        return backupCalls === 1
          ? thinkingOnly(backup, "length")
          : reply(backup, "From the backup.");
      });
      const events = await run(
        request(plain, {}, [{ provider: backup.provider, id: backup.id, apiKey: "backup-key" }]),
      );
      expect(
        providerState.stream.mock.calls.map(([target, , options]) => [
          target.id,
          (options as StreamOptions).maxTokens,
        ]),
      ).toEqual([
        [plain.id, 4_096],
        ...Array.from({ length: failedCalls }, () => [plain.id, 8_192]),
        [backup.id, 4_096],
        [backup.id, 8_192],
      ]);
      expect(texts(events)).toContain("From the backup.");
    },
  );

  it("takes a smaller output reservation the provider can afford after the raise", async () => {
    const router = model("openrouter", "router", { reasoning: false, maxTokens: 65_536 });
    providerState.models.set("openrouter/router", router as unknown as Record<string, unknown>);
    const credits =
      '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 6000.","metadata":{"limit_source":"openrouter_credits"}}';
    providerState.stream
      .mockImplementationOnce(() => thinkingOnly(router, "length"))
      .mockImplementationOnce(() => thinkingOnly(router, "error", credits))
      .mockImplementation(() => reply(router));
    const events = await run(request(router));
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192, 6_000]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
  });

  it("repeats at most three calls in one run", async () => {
    // Each repeat recovers with a tool call, until the fourth run-out fails the run.
    let call = 0;
    providerState.stream.mockImplementation(() => {
      call += 1;
      return call % 2 === 1 ? thinkingOnly(plain, "length") : toolCall(plain, `effect-${call}`);
    });
    const input = request(plain);
    await expect(run(input)).rejects.toThrow(
      "The model hit its output limit before writing a response.",
    );
    expect(providerState.stream).toHaveBeenCalledTimes(7);
    expect(input.executeTool).toHaveBeenCalledTimes(3);
  });
});

/** Reply text that streams live and is then cut by `error`. */
const cutReply = (target: Model<"openai-completions">, text: string, error = "terminated") =>
  stream(message(target, [], "error", error), undefined, text);
const streamedReply = (target: Model<"openai-completions">, text: string) =>
  stream(message(target, [{ type: "text", text }], "stop"), undefined, text);

describe("a reply cut off by a dropped connection", () => {
  it("continues once in the same reply, without repeating the cut text", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Part one. Part tw"))
      .mockImplementation(() => streamedReply(plain, "Part two."));
    const events = await run(request(plain));
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(texts(events).join("")).toBe("Part one. Part two.");
    expect(events.some((event) => event.type === "turn")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", text: "Part one. Part two." });
    // The model gets its cut text back as its own turn, then the continuation note.
    const context = providerState.stream.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const [cut, note] = context.messages.slice(-2);
    expect(cut).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Part one. Part tw" }],
    });
    expect(JSON.stringify(note)).toContain("cut off by a connection error");
  });

  it("drops the repeat from a continuation that arrives only on the completed message", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Part one. Part tw"))
      .mockImplementation(() => reply(plain, "Part two."));
    const events = await run(request(plain));
    expect(texts(events).join("")).toBe("Part one. Part two.");
    expect(events.at(-1)).toEqual({ type: "done", text: "Part one. Part two." });
  });

  it("drops the repeat when only the start of the continuation streams", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Part one. Part tw"))
      .mockImplementation(() =>
        stream(message(plain, [{ type: "text", text: "Part two." }], "stop"), undefined, "Part "),
      );
    const events = await run(request(plain));
    expect(texts(events).join("")).toBe("Part one. Part two.");
    expect(events.at(-1)).toEqual({ type: "done", text: "Part one. Part two." });
  });

  it("joins a continuation that does not repeat anything as it is", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Open the sett"))
      .mockImplementation(() => streamedReply(plain, "ings page."));
    const events = await run(request(plain));
    expect(events.at(-1)).toEqual({ type: "done", text: "Open the settings page." });
  });

  it("does not continue a cut while a tool call was being written, and never runs it", async () => {
    providerState.stream.mockImplementation(() => {
      const call = { type: "toolCall" as const, id: "half", name: "write_effect", arguments: {} };
      const failure = message(
        plain,
        [{ type: "text", text: "Typing it now" }, call],
        "error",
        "terminated",
      );
      const result = stream(message(plain, [], "error", "terminated"), undefined, "Typing it now");
      // Re-stream with the tool call starting before the cut.
      const live = new AssistantMessageEventStream();
      void (async () => {
        for await (const event of result) {
          if (event.type === "error") {
            live.push({ type: "toolcall_start", contentIndex: 1, partial: failure });
            live.push({ type: "error", reason: "error", error: failure });
            live.end(failure);
            return;
          }
          live.push(event);
        }
      })();
      return live;
    });
    const input = request(plain);
    await expect(run(input)).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it("does not continue a second time when the continuation is cut too", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Part one. "))
      .mockImplementation(() => cutReply(plain, "Part two, and"));
    const events: AgentRuntimeEvent[] = [];
    const consume = async () => {
      for await (const event of new PiAgentRuntime().run(request(plain), {
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    // Everything written reaches the executor, which keeps it as one message.
    expect(texts(events).join("")).toBe("Part one. Part two, and");
  });

  it("does not continue after an error that is not a dropped connection", async () => {
    providerState.stream.mockImplementation(() =>
      cutReply(plain, "Part one.", "400 invalid_request_error"),
    );
    await expect(run(request(plain))).rejects.toThrow("400");
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("stops at once when the run is stopped during the continuation", async () => {
    const controller = new AbortController();
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "Part one. "))
      .mockImplementation(() => {
        controller.abort();
        return cutReply(plain, "Part", "Request was aborted");
      });
    await expect(run(request(plain), controller.signal)).rejects.toThrow(/abort|stop/i);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a tool that ran before the cut", async () => {
    providerState.stream
      .mockImplementationOnce(() => toolCall(plain, "effect-1"))
      .mockImplementationOnce(() => cutReply(plain, "Done with the first part, now the sec"))
      .mockImplementation(() => streamedReply(plain, "ond part."));
    const input = request(plain);
    const events = await run(input);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "Done with the first part, now the second part.",
    });
  });

  it("counts toward the three recoveries a run may make", async () => {
    // Three thinking-only run-outs use the run's recoveries; the next cut then fails.
    let call = 0;
    providerState.stream.mockImplementation(() => {
      call += 1;
      if (call <= 6) {
        return call % 2 === 1 ? thinkingOnly(plain, "length") : toolCall(plain, `effect-${call}`);
      }
      return cutReply(plain, "Almost th");
    });
    await expect(run(request(plain))).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledTimes(7);
  });
});

describe("a tool call cut at the output limit", () => {
  const truncated = (target: Model<"openai-completions">) =>
    stream(
      message(
        target,
        [{ type: "toolCall", id: "cut", name: "write_effect", arguments: { value: "par" } }],
        "length",
      ),
    );

  it("is never run, and its re-issue gets double the budget", async () => {
    providerState.stream
      .mockImplementationOnce(() => truncated(plain))
      .mockImplementationOnce(() => toolCall(plain, "whole"))
      .mockImplementation(() => reply(plain, "Done."));
    const input = request(plain);
    const events = await run(input);
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192, 4_096]);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(vi.mocked(input.executeTool)?.mock.calls[0]?.slice(0, 2)).toEqual([
      "write_effect",
      { value: "whole" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("fails the run instead of looping once the run's recoveries are spent", async () => {
    providerState.stream.mockImplementation(() => truncated(plain));
    const input = request(plain);
    await expect(run(input)).rejects.toThrow(MODEL_OUTPUT_LIMIT_ERROR);
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(input.executeTool).not.toHaveBeenCalled();
  });
});

describe("continuationRepeat", () => {
  it.each([
    ["Read it\n\n", "then continue.", 0],
    ["Read it", "…then continue.", 0],
    ["Try cat\n\n", "at noon.", 0],
    ["Read it\n\n", "it works.", 2],
    ["Ag", "Agree on a time.", 2],
    ["Next Ag", "…Agree on a time.", 3],
    ["Hello\n\n", "Hello world.", 5],
    ["Try testing", "ting works.", 4],
  ])("requires a whole final fragment for short requested repeats: %j, %j", (cut, more, size) => {
    expect(continuationRepeat(cut, more, true)).toBe(size);
  });

  it.each([
    ["as they arrive, since", "…since a friendly", "…since".length],
    ["as they arrive, since", "... since a friendly", "... since".length],
    ["deposit the money", "deposit the money according", "deposit the money".length],
    // An ellipsis that doesn't lead into a repeat is the model's own text.
    ["Wait", "... and then it worked", 0],
    ["no repeat here", "fresh words", 0],
    ["Ag", "Agree on a time.", 0],
    ["Hello\n\n", "Hello world.", 0],
  ])("drops %j's repeat from %j", (cut, continuation, size) => {
    expect(continuationRepeat(cut, continuation)).toBe(size);
  });
});

describe("continuationOverlap", () => {
  it.each([
    ["Part one. Part tw", "Part two.", 7],
    ["Part one. Part tw", "Part one. Part two.", 17],
    ["Open the sett", "ings page.", 0],
    // A few shared characters are coincidence, not a repeat.
    ["It is a", "a list", 0],
  ])("finds %j repeated at the start of %j: %i characters", (cut, continuation, size) => {
    expect(continuationOverlap(cut, continuation)).toBe(size);
  });
});

/** Reply text that streams live and stops at the output limit. */
const replyAtLimit = (target: Model<"openai-completions">, text: string) =>
  stream(message(target, [{ type: "text", text }], "length"), undefined, text);

describe("a reply cut off at the output limit", () => {
  it("continues once in the same reply with more room, without repeating the cut text", async () => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, "Your login just"))
      .mockImplementation(() => streamedReply(plain, " expired. Sign in again."));
    const events = await run(request(plain));
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192]);
    expect(texts(events).join("")).toBe("Your login just expired. Sign in again.");
    expect(events.some((event) => event.type === "turn")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "Your login just expired. Sign in again.",
    });
    const context = providerState.stream.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const [cut, note] = context.messages.slice(-2);
    expect(cut).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Your login just" }],
    });
    expect(JSON.stringify(note)).toContain("hit the output limit");
    // The continuation is asked to start from the reply's last words, quoted for it.
    expect(JSON.stringify(note)).toContain('It ended with: \\"Your login just\\"');
  });

  it.each([
    ['Type "yes" and then run', 'Type \\"yes\\" and then run'],
    // A reply that ends on a closing quote mark can't end the prompt's quote early.
    ['Then follow the steps "above"', 'Then follow the steps \\"above\\"'],
  ])("keeps quote marks in the reply's last words inside the quote: %j", async (cut, quoted) => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, cut))
      .mockImplementation(() => streamedReply(plain, " and carry on."));
    await run(request(plain));
    const context = providerState.stream.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const note = context.messages.at(-1)?.content;
    const text = typeof note === "string" ? note : JSON.stringify(note);
    expect(text).toContain(`It ended with: "${quoted}" Continue it`);
  });

  it.each([
    ["Read it\n\n", "then continue.", "Read it\n\nthen continue."],
    ["Read it", "…then continue.", "Read it…then continue."],
    ["Try cat\n\n", "at noon.", "Try cat\n\nat noon."],
    ["Hello\n\n", "Hello world.", "Hello\n\n world."],
    ["Ag", "Agree on a time.", "Agree on a time."],
    ["Ag", "…Agree on a time.", "Agree on a time."],
    // Seams a model wrote when asked only to continue, each joined cleanly once it repeats.
    [
      "Keep cash in a lockbox and deposit the money",
      "deposit the money according to the plan.",
      "Keep cash in a lockbox and deposit the money according to the plan.",
    ],
    [
      "Greet buyers as they arrive, since",
      "…since a friendly greeting helps.",
      "Greet buyers as they arrive, since a friendly greeting helps.",
    ],
    [
      "Make sure the items with allergens",
      "items with allergens are properly labeled.",
      "Make sure the items with allergens are properly labeled.",
    ],
    [
      "Confirm the ingredient commitments.\n\nAg",
      "commitments.\n\nAgree on a time.",
      "Confirm the ingredient commitments.\n\nAgree on a time.",
    ],
  ])("joins a continuation that repeats the end of %j without a seam", async (cut, more, whole) => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, cut))
      .mockImplementation(() => streamedReply(plain, more));
    const events = await run(request(plain));
    expect(texts(events).join("")).toBe(whole);
    expect(events.at(-1)).toEqual({ type: "done", text: whole });
  });

  it.each(["", "Your login just", "…Your login just"])(
    "retries a continuation that adds no text: %j",
    async (more) => {
      providerState.stream
        .mockImplementationOnce(() => replyAtLimit(plain, "Your login just"))
        .mockImplementationOnce(() => streamedReply(plain, more))
        .mockImplementation(() => streamedReply(plain, "login just expired."));
      const events = await run(request(plain));
      expect(providerState.stream).toHaveBeenCalledTimes(3);
      expect(texts(events).join("")).toBe("Your login just expired.");
      expect(events.at(-1)).toEqual({ type: "done", text: "Your login just expired." });
    },
  );

  it.each(["", "Your login just", "…Your login just"])(
    "fails when continuations keep adding no text: %j",
    async (more) => {
      providerState.stream
        .mockImplementationOnce(() => replyAtLimit(plain, "Your login just"))
        .mockImplementation(() => streamedReply(plain, more));
      await expect(run(request(plain))).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
      expect(providerState.stream).toHaveBeenCalledTimes(4);
    },
  );

  it("shares the recovery allowance with continuations that hit the limit again", async () => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, "Part one. "))
      .mockImplementationOnce(() => replyAtLimit(plain, "Part two. "))
      .mockImplementation(() => streamedReply(plain, ""));
    await expect(run(request(plain))).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
    expect(providerState.stream).toHaveBeenCalledTimes(4);
  });

  it("drops a continuation's repeat of the cut text", async () => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, "Your login just"))
      .mockImplementation(() => streamedReply(plain, "login just expired."));
    const events = await run(request(plain));
    expect(events.at(-1)).toEqual({ type: "done", text: "Your login just expired." });
  });

  it("thinks less for the continuation when the budget is already at its ceiling", async () => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(reasoner, "Step one, then"))
      .mockImplementation(() => streamedReply(reasoner, " step two."));
    const events = await run(request(reasoner, { thinkingLevel: "high" }));
    expect(sentOptions().map(({ maxTokens, reasoning }) => [maxTokens, reasoning])).toEqual([
      [32_768, "high"],
      [32_768, "medium"],
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Step one, then step two." });
  });

  it("continues again while the run has recoveries, with more room each time", async () => {
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(plain, "Part one. "))
      .mockImplementationOnce(() => replyAtLimit(plain, "Part two. "))
      .mockImplementation(() => streamedReply(plain, "Part three."));
    const events = await run(request(plain));
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192, 16_384]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Part one. Part two. Part three." });
  });

  it("still continues in a fresh call when there is no more room to give", async () => {
    // A user-set budget and thinking turned off leave nothing to raise or lower.
    providerState.stream
      .mockImplementationOnce(() => replyAtLimit(reasoner, "Your login just"))
      .mockImplementation(() => streamedReply(reasoner, " expired."));
    const events = await run(request(reasoner, { maxTokens: 2_000, thinkingLevel: "off" }));
    expect(sentOptions().map(({ maxTokens, reasoning }) => [maxTokens, reasoning])).toEqual([
      [2_000, undefined],
      [2_000, undefined],
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Your login just expired." });
  });

  it("stops at the run's recoveries when there is no more room to give", async () => {
    let call = 0;
    providerState.stream.mockImplementation(() => {
      call += 1;
      return replyAtLimit(reasoner, `Part ${call}. `);
    });
    await expect(
      run(request(reasoner, { maxTokens: 2_000, thinkingLevel: "off" })),
    ).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
    expect(providerState.stream).toHaveBeenCalledTimes(4);
  });

  it("fails with the cut-reply error, keeping the text, once the continuations run out", async () => {
    let call = 0;
    providerState.stream.mockImplementation(() => {
      call += 1;
      return replyAtLimit(plain, `Part ${call}. `);
    });
    const events: AgentRuntimeEvent[] = [];
    const consume = async () => {
      for await (const event of new PiAgentRuntime().run(request(plain), {
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
    // The first call and three continuations, the run's three recoveries.
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    // Everything written reaches the executor, which keeps it above the error.
    expect(texts(events).join("")).toBe("Part 1. Part 2. Part 3. Part 4. ");
  });

  it("fails with the cut-reply error once the run's recoveries are spent", async () => {
    // Three thinking-only run-outs use the run's recoveries; the cut reply then fails.
    let call = 0;
    providerState.stream.mockImplementation(() => {
      call += 1;
      if (call <= 6) {
        return call % 2 === 1 ? thinkingOnly(plain, "length") : toolCall(plain, `effect-${call}`);
      }
      return replyAtLimit(plain, "Your login just");
    });
    const events: AgentRuntimeEvent[] = [];
    const consume = async () => {
      for await (const event of new PiAgentRuntime().run(request(plain), {
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
    expect(providerState.stream).toHaveBeenCalledTimes(7);
    expect(texts(events).join("")).toContain("Your login just");
  });

  it("says the reply was cut when a tool call after reply text runs out of recoveries", async () => {
    providerState.stream.mockImplementation(() =>
      stream(
        message(
          plain,
          [
            { type: "text", text: "Saving it." },
            { type: "toolCall", id: "half", name: "write_effect", arguments: {} },
          ],
          "length",
        ),
        undefined,
        "Saving it.",
      ),
    );
    const input = request(plain);
    await expect(run(input)).rejects.toThrow(MODEL_OUTPUT_CUT_ERROR);
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it("keeps re-issuing a tool call cut at the limit with more room, without a continuation", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          message(
            plain,
            [
              { type: "text", text: "Saving it." },
              { type: "toolCall", id: "half", name: "write_effect", arguments: {} },
            ],
            "length",
          ),
          undefined,
          "Saving it.",
        ),
      )
      .mockImplementation(() => reply(plain, "Saved."));
    const input = request(plain);
    const events = await run(input);
    expect(sentOptions().map((options) => options.maxTokens)).toEqual([4_096, 8_192]);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(sentContexts()[1]).not.toContain("hit the output limit");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("never continues a run that was stopped", async () => {
    const controller = new AbortController();
    providerState.stream.mockImplementation(() => {
      controller.abort();
      return replyAtLimit(plain, "Your login just");
    });
    // Stopping is the executor's to finish; no call goes out after it.
    const events = await run(request(plain), controller.signal);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(texts(events).join("")).toBe("Your login just");
  });
});

describe("coarse thinking lifecycle from real Pi stream events", () => {
  it("emits explicit start/end without leaking thinking text into runtime events", async () => {
    providerState.stream.mockImplementationOnce(() =>
      stream(
        message(reasoner, [{ type: "text", text: "Public answer." }], "stop"),
        "private fixture reasoning",
        "Public answer.",
      ),
    );
    const events = await run(request(reasoner));
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", active: true },
      { type: "thinking", active: false },
    ]);
    expect(JSON.stringify(events)).not.toContain("private fixture reasoning");
    expect(events.findIndex((event) => event.type === "text")).toBeGreaterThan(
      events.findIndex((event) => event.type === "thinking" && !event.active),
    );
  });
  it("ends thinking before retry recovery and requires a fresh start on the next attempt", async () => {
    providerState.stream.mockImplementationOnce(() => thinkingOnly(reasoner, "length"));
    providerState.stream.mockImplementationOnce(() => reply(reasoner));
    const events = await run(request(reasoner));
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", active: true },
      { type: "thinking", active: false },
    ]);
    expect(texts(events)).toContain("Recovered.");
  });
  it("does not invent a thinking signal for a text-only model", async () => {
    providerState.stream.mockImplementationOnce(() => reply(plain));
    expect((await run(request(plain))).filter((event) => event.type === "thinking")).toEqual([]);
  });
});

it("stops the public thinking marker immediately when an active provider turn is aborted", async () => {
  const controller = new AbortController();
  providerState.stream.mockImplementationOnce(
    (_model: unknown, _ctx: unknown, options: { signal?: AbortSignal }) => {
      const pending = new AssistantMessageEventStream();
      const empty = message(reasoner, [], "stop");
      pending.push({ type: "start", partial: empty });
      pending.push({ type: "thinking_start", contentIndex: 0, partial: empty });
      options.signal?.addEventListener(
        "abort",
        () => {
          const aborted = { ...empty, stopReason: "aborted" as const, errorMessage: "Aborted" };
          pending.push({ type: "error", reason: "aborted", error: aborted });
          pending.end(aborted);
        },
        { once: true },
      );
      return pending;
    },
  );
  const observed: AgentRuntimeEvent[] = [];
  try {
    for await (const item of new PiAgentRuntime().run(request(reasoner), {
      signal: controller.signal,
    })) {
      observed.push(item);
      if (item.type === "thinking" && item.active) controller.abort();
    }
  } catch {
    /* The original cancellation remains a runtime failure, never a completion. */
  }
  expect(observed.filter((item) => item.type === "thinking")).toEqual([
    { type: "thinking", active: true },
    { type: "thinking", active: false },
  ]);
});
