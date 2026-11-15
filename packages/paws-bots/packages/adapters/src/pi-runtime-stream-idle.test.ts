import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import {
  MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
  modelStreamIdleWatchdog,
  reliableModelStream,
} from "./pi-runtime-stream.js";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.1-codex",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function abortedByPi(): Parameters<AssistantMessageEventStream["push"]>[0] {
  // pi surfaces any request-signal abort as this generic terminal event.
  return {
    type: "error",
    reason: "aborted",
    error: assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" }),
  };
}

const codexModel = { provider: "openai-codex", api: "openai-codex-responses" } as Model<Api>;
const context = { messages: [] } as Context;

describe("Model stream idle watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows prolonged inactivity when the idle timeout is disabled", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "0");

    const watchdog = modelStreamIdleWatchdog(undefined);
    watchdog.ping();

    await vi.advanceTimersByTimeAsync(13_800_000);

    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    watchdog.dispose();
  });

  it("preserves explicit cancellation with the idle timeout disabled", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "0");

    const upstream = new AbortController();
    const watchdog = modelStreamIdleWatchdog(upstream.signal);
    watchdog.ping();

    await vi.advanceTimersByTimeAsync(13_800_000);
    expect(watchdog.signal.aborted).toBe(false);

    const reason = new Error("User cancelled the agent");
    upstream.abort(reason);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);

    watchdog.dispose();
  });

  it("waits out a configured idle bound longer than the default", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "240000");
    const watchdog = modelStreamIdleWatchdog(undefined);
    watchdog.ping();
    await vi.advanceTimersByTimeAsync(240_000 - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((watchdog.signal.reason as Error).message).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
    watchdog.dispose();
  });

  it("allows an active stream to continue for an hour", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();
    let pending = iterator.next();
    inner.push({ type: "start", partial: assistantMessage() });
    await pending;
    for (let minute = 0; minute < 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      pending = iterator.next();
      inner.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() });
      await pending;
      expect(watchdog.signal.aborted).toBe(false);
    }
    pending = iterator.next();
    inner.push({ type: "done", reason: "stop", message: assistantMessage() });
    inner.end();
    await pending;
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("aborts the composed signal after the idle bound and relabels the terminal error", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    // No idle budget burns before response headers land.
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);

    inner.push({ type: "start", partial: assistantMessage() });
    await pending;

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBeInstanceOf(Error);
    expect((watchdog.signal.reason as Error).message).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);

    const errored = iterator.next();
    inner.push(abortedByPi());
    inner.end();
    const { value } = await errored;
    expect(value).toEqual({
      type: "error",
      reason: "error",
      error: expect.objectContaining({
        stopReason: "error",
        errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
      }),
    });
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds silence once response headers land, even before the first event", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    // Pre-headers wait consumes no idle budget.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);

    // Headers landed — pi's onResponse seam pings the watchdog — but the body
    // then stays silent: the idle bound applies from here.
    watchdog.ping();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect((watchdog.signal.reason as Error).message).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);

    inner.push(abortedByPi());
    inner.end();
    expect((await pending).value).toMatchObject({
      reason: "error",
      error: { errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE },
    });
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
    });
  });

  it("never aborts a retry that succeeds after an earlier attempt stalled out", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    // Attempt one burns its full headers timeout plus the retry backoff; a
    // second attempt then needs its own timeoutMs to deliver headers. No
    // leftover idle budget may kill it.
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS + MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(watchdog.signal.aborted).toBe(false);

    // The retried attempt's headers arrive: the first event arms the timer.
    inner.push({ type: "start", partial: assistantMessage() });
    expect((await pending).value).toMatchObject({ type: "start" });
    expect(watchdog.signal.aborted).toBe(false);

    const done = iterator.next();
    inner.push({ type: "done", reason: "stop", message: assistantMessage() });
    inner.end();
    expect((await done).value).toMatchObject({ type: "done" });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("re-arms on every delivered event so a busy stream never aborts", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    let pending = iterator.next();
    inner.push({ type: "start", partial: assistantMessage() });
    await pending;

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);

    pending = iterator.next();
    inner.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() });
    expect((await pending).value).toMatchObject({ type: "text_delta", delta: "x" });

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
  });

  it("propagates a caller abort without relabeling it", async () => {
    vi.useFakeTimers();
    const upstream = new AbortController();
    const watchdog = modelStreamIdleWatchdog(upstream.signal);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    upstream.abort("caller stop");
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe("caller stop");

    inner.push(abortedByPi());
    inner.end();
    expect((await pending).value).toMatchObject({
      reason: "aborted",
      error: { errorMessage: "Request was aborted" },
    });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
  });

  it("clears the watchdog once the stream completes", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);

    const eventTypes: string[] = [];
    const done = (async () => {
      for await (const event of stream) eventTypes.push(event.type);
    })();
    inner.push({ type: "start", partial: assistantMessage() });
    inner.push({ type: "done", reason: "stop", message: assistantMessage() });
    inner.end();
    await done;

    expect(eventTypes).toEqual(["start", "done"]);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when the consumer stops iterating early", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    inner.push({ type: "start", partial: assistantMessage() });
    await iterator.next();
    await iterator.return?.(undefined);

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each([
  codexModel,
  { provider: "openrouter", api: "openai-completions" } as Model<Api>,
  { provider: "openai-compatible", api: "openai-completions" } as Model<Api>,
  { provider: "anthropic", api: "anthropic-messages" } as Model<Api>,
])("reliableModelStream idle gating for $provider", (model) => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("bounds silence without aborting the caller", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    const models = { streamSimple } as unknown as Models;
    const callerFetch = vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>();
    const options: SimpleStreamOptions = { signal: caller.signal, fetch: callerFetch };

    const guarded = reliableModelStream(models, model, context, options, undefined);
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    expect(guardedOptions?.signal).not.toBe(caller.signal);
    expect(guardedOptions?.fetch).not.toBe(callerFetch);
    expect(guardedOptions?.timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
    expect(guardedOptions?.transport).toBe(model === codexModel ? "sse" : undefined);
    expect(guarded).not.toBe(inner);
    expect(guarded).toBeInstanceOf(AssistantMessageEventStream);

    // Before the first event the idle budget stays unarmed, so a headers
    // timeout leaves a retried attempt its own full timeoutMs.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);

    // Once events flow, silence is bounded — and the watchdog aborts only its
    // own request signal, never the caller's.
    const pending = guarded[Symbol.asyncIterator]().next();
    inner.push({ type: "start", partial: assistantMessage() });
    await pending;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(guardedOptions?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("arms only on successful responses, leaving retry backoff uncovered", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    const models = { streamSimple } as unknown as Models;
    const onResponse = vi.fn();

    reliableModelStream(models, model, context, { signal: caller.signal, onResponse }, undefined);
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    expect(guardedOptions?.onResponse).not.toBe(onResponse);

    // Attempt 1 stalls until its headers timeout and pi retries: no response
    // callback has fired, so no idle budget has been spent.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS + MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    // A retryable response's headers must not arm the watchdog: error
    // responses emit no stream events, and pi's backoff sleep sits outside the
    // idle bound. The caller's own onResponse still observes every response.
    await guardedOptions?.onResponse?.({ status: 429, headers: {} }, model);
    expect(onResponse).toHaveBeenCalledWith({ status: 429, headers: {} }, model);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    // The retried attempt's 2xx headers arm a fresh full budget; a body that
    // then stays silent aborts at the idle bound.
    await guardedOptions?.onResponse?.({ status: 200, headers: {} }, model);
    expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: {} }, model);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(guardedOptions?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("fails a stalled retryable error body at the configured idle bound without aborting the request", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "240000");
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const callerFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
          { status: 429, headers: { "retry-after": "30" } },
        ),
    );
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    reliableModelStream(
      { streamSimple } as unknown as Models,
      model,
      context,
      { signal: caller.signal, fetch: callerFetch },
      undefined,
    );
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    const response = await guardedOptions!.fetch!("https://example.test/codex", { method: "POST" });
    expect(callerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");

    let settled = false;
    const outcome = response.text().then(
      (text) => {
        settled = true;
        return { text };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await vi.advanceTimersByTimeAsync(240_000 - 1);
    expect(settled).toBe(false);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(outcome).resolves.toEqual({
      error: expect.objectContaining({ message: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE }),
    });
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a finished error body and leaves successful responses unwrapped", async () => {
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const ok = new Response("event: done\n\n", { status: 200 });
    const callerFetch = vi
      .fn<NonNullable<SimpleStreamOptions["fetch"]>>()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(ok);
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    reliableModelStream(
      { streamSimple } as unknown as Models,
      model,
      context,
      { signal: caller.signal, fetch: callerFetch },
      undefined,
    );
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    const retryable = await guardedOptions!.fetch!("https://example.test/codex", {});
    expect(retryable.status).toBe(429);
    expect(retryable.headers.get("retry-after")).toBe("2");
    await expect(retryable.text()).resolves.toBe("slow down");

    const succeeded = await guardedOptions!.fetch!("https://example.test/codex", {});
    expect(succeeded).toBe(ok);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
  });

  it("disposes the watchdog when streamSimple throws synchronously", () => {
    vi.useFakeTimers();
    const models = {
      streamSimple: vi.fn(() => {
        throw new Error("no api key");
      }),
    } as unknown as Models;

    expect(() => reliableModelStream(models, model, context, undefined, undefined)).toThrow(
      "no api key",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(["google-generative-ai", "google-vertex"] as const)(
  "reliableModelStream fetch options for %s",
  (api) => {
    afterEach(() => vi.useRealTimers());

    it.each([false, true])(
      "preserves caller fetch (supplied: %s) and the idle watchdog",
      async (supplied) => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const fetch = supplied ? vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>() : undefined;
        const onResponse = vi.fn();
        const inner = new AssistantMessageEventStream();
        const streamSimple = vi.fn(
          (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
        );
        const model = { provider: "fixture", api } as Model<Api>;
        const stream = reliableModelStream(
          { streamSimple } as unknown as Models,
          model,
          context,
          { signal: caller.signal, fetch, onResponse },
          undefined,
        );
        const options = streamSimple.mock.calls[0]![2]!;
        expect(options.fetch).toBe(fetch);
        expect(options.signal).not.toBe(caller.signal);
        expect(options.timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
        await options.onResponse?.({ status: 200, headers: {} }, model);
        expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: {} }, model);
        await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
        expect(options.signal?.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(false);
        inner.push(abortedByPi());
        inner.end();
        await expect(stream.result()).resolves.toMatchObject({
          errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
        });
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  },
);

it.each(["google-generative-ai", "google-vertex"] as const)(
  "streams a reply through the real Pi %s provider without a custom fetch",
  async (api) => {
    const fetch = vi.fn(async () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const model: Model<typeof api> = {
        provider: api === "google-generative-ai" ? "google" : "google-vertex",
        api,
        id: "gemini-2.5-flash",
        name: "Fixture",
        baseUrl: "https://models.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      };
      const stream = reliableModelStream(
        builtinModels(),
        model,
        { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] },
        { apiKey: "fake-key", maxRetries: 0 },
        undefined,
      );
      const events: string[] = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      expect(result.errorMessage ?? "").not.toContain("Custom fetch is not supported");
      expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "hi" }] });
      expect(events).toContain("text_delta");
      expect(events.at(-1)).toBe("done");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("terminates a silent compatible HTTP stream through the real Pi provider", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  try {
    let headersArrived!: () => void;
    const headers = new Promise<void>((resolve) => {
      headersArrived = resolve;
    });
    const fetch = vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>(async (_input, init) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const model: Model<"openai-completions"> = {
      provider: "openrouter",
      api: "openai-completions",
      id: "fixture",
      name: "Fixture",
      baseUrl: "https://models.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    };
    const stream = reliableModelStream(
      builtinModels(),
      model,
      { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] },
      {
        apiKey: "fake-key",
        signal: caller.signal,
        fetch,
        onResponse: () => headersArrived(),
      },
      undefined,
    );
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of stream) events.push(event.type);
    })();
    await headers;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);
    await consume;
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
    });
    expect(events).toEqual(["start", "error"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    caller.abort();
    vi.useRealTimers();
  }
});

it("pairs the default stream transport with the compatible provider's guarded dispatcher", async () => {
  const inner = new AssistantMessageEventStream();
  const streamSimple = vi.fn(
    (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
  );
  reliableModelStream(
    { streamSimple } as unknown as Models,
    { provider: "openai-compatible", api: "openai-completions" } as Model<Api>,
    context,
    undefined,
    undefined,
  );
  const options = streamSimple.mock.calls[0]![2]!;
  const resolve = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);
  const safeFetch = createOpenAiCompatibleFetch(options.fetch, resolve, { allowPublic: true });

  await expect(safeFetch("https://models.example.test/v1/models")).rejects.toMatchObject({
    cause: { message: "Public model server hostname resolved to a private address" },
  });
  expect(resolve).toHaveBeenCalledOnce();
});
