import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { codexComputeResidency } from "./pi-oauth.js";
import {
  modelStreamIdleTimeoutMs,
  modelStreamMaxRetries,
  modelStreamTimeoutMs,
  operatorMaxTokens,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

/** Stable OpenCode affinity id for a bot conversation (and optional nested agent). */
export function conversationSessionId(threadId: string, botId: string, agentId?: string): string {
  return agentId ? `${threadId}:${botId}:${agentId}` : `${threadId}:${botId}`;
}

export function isOpenCodeProvider(provider: string): boolean {
  return provider === "opencode" || provider === "opencode-go";
}

export function isCodexModel(model: Pick<Model<Api>, "api" | "provider">): boolean {
  return model.provider === "openai-codex" || model.api === "openai-codex-responses";
}

/** Abort reason recorded when a model stream goes silent past the idle bound. */
export const MODEL_STREAM_IDLE_TIMEOUT_MESSAGE = "Model stream idle timeout";

export interface StreamIdleWatchdog {
  signal: AbortSignal;
  /** Re-arms the idle bound; invoke on response headers and each delivered event. */
  ping(): void;
  /** Wraps the provider stream so every delivered event re-arms the idle bound. */
  wrap(stream: AssistantMessageEventStream): AssistantMessageEventStream;
  dispose(): void;
}

/**
 * `timeoutMs` bounds only time-to-headers; after that pi reads the body until it
 * ends or the signal aborts, so silence can stall a run. The watchdog arms only on
 * a 2xx response, keeping time-to-headers and retry backoff outside the idle bound.
 * pi reports any abort as "Request was aborted", so the wrapper relabels it as an
 * idle timeout when the watchdog fired.
 */
export function modelStreamIdleWatchdog(
  upstream: AbortSignal | undefined,
  idleTimeoutMs: number = modelStreamIdleTimeoutMs(),
): StreamIdleWatchdog {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) controller.abort(upstream.reason);
  else upstream?.addEventListener("abort", onUpstreamAbort, { once: true });

  const arm = () => {
    if (disposed || controller.signal.aborted || idleTimeoutMs === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new Error(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE));
    }, idleTimeoutMs);
    timer.unref?.();
  };

  const dispose = () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    upstream?.removeEventListener("abort", onUpstreamAbort);
  };

  // Nothing arms the timer before a successful response's headers land: the
  // pre-headers window is bounded per attempt by timeoutMs and retry backoff
  // by maxRetryDelayMs, so idle budget must not burn there and a retry always
  // starts from a fresh full budget.
  const ping = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    arm();
  };

  const describeTimeout = (message: AssistantMessage): AssistantMessage =>
    timedOut && message.stopReason === "aborted"
      ? {
          ...message,
          stopReason: "error",
          errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
        }
      : message;

  const rewrite = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (event.type !== "error") return event;
    const error = describeTimeout(event.error);
    return error === event.error ? event : { type: "error", reason: "error", error };
  };

  return {
    signal: controller.signal,
    ping,
    dispose,
    wrap(inner) {
      class Watched extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
          try {
            for await (const event of inner) {
              ping();
              yield rewrite(event);
            }
          } finally {
            dispose();
          }
        }
        override result(): Promise<AssistantMessage> {
          return inner.result().then(describeTimeout).finally(dispose);
        }
      }
      return new Watched();
    },
  };
}

/**
 * Fails a non-2xx body that stays open. The shared idle watchdog stays
 * unarmed: aborting it would skip pi's retry backoff, and a thrown read error
 * is retried like any other transport failure.
 */
function boundRetryableErrorBody(response: Response, idleTimeoutMs: number): Response {
  if (idleTimeoutMs === 0 || response.ok || response.body == null) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = reader.read().then(
        (chunk) => ({ kind: "chunk" as const, chunk }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), idleTimeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([read, timeout]);
      clear();
      if (outcome.kind === "timeout") {
        const error = new Error(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      if (outcome.kind === "error") {
        controller.error(outcome.error);
        return;
      }
      if (outcome.chunk.done) controller.close();
      else controller.enqueue(outcome.chunk.value);
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function modelRequestFetch(
  fetchImpl: ModelsSimpleStreamOptions["fetch"],
  idleTimeoutMs: number,
): NonNullable<ModelsSimpleStreamOptions["fetch"]> {
  return async (input, init) => {
    // Compatible providers attach a package undici Agent after this wrapper is
    // installed. Pair that dispatcher without replacing other providers' fetch.
    const transport =
      init && "dispatcher" in init
        ? fetchPairedWithDispatcher(fetchImpl)
        : (fetchImpl ?? globalThis.fetch);
    const response = await transport(input, init);
    return boundRetryableErrorBody(response, idleTimeoutMs);
  };
}

// These Pi adapters reject fetch overrides other than globalThis.fetch.
const APIS_WITHOUT_CUSTOM_FETCH = new Set<Api>(["google-generative-ai", "google-vertex"]);

export function reliableModelStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions | undefined,
  configuredMaxTokens: number | undefined,
  accessToken?: string | (() => string | undefined),
  runStream?: (options: ModelsSimpleStreamOptions) => AssistantMessageEventStream,
  cacheRetention?: ModelsSimpleStreamOptions["cacheRetention"],
): AssistantMessageEventStream {
  const watchdog = modelStreamIdleWatchdog(options?.signal);
  try {
    const preparedOptions = reliableStreamOptions(
      model,
      {
        ...options,
        signal: watchdog.signal,
        fetch: APIS_WITHOUT_CUSTOM_FETCH.has(model.api)
          ? options?.fetch
          : modelRequestFetch(options?.fetch, modelStreamIdleTimeoutMs()),
        // Only a 2xx arms the shared watchdog. Error bodies are bounded by
        // the fetch wrapper where supported; caller hooks still see every status.
        onResponse: (response, requestModel) => {
          if (response.status >= 200 && response.status < 300) watchdog.ping();
          return options?.onResponse?.(response, requestModel);
        },
      },
      configuredMaxTokens,
      accessToken,
      cacheRetention,
    );
    const stream = runStream
      ? runStream(preparedOptions)
      : models.streamSimple(model, context, preparedOptions);
    return watchdog.wrap(stream);
  } catch (error) {
    watchdog.dispose();
    throw error;
  }
}

const CODEX_RESIDENCY_HEADER = "x-openai-internal-codex-residency";

/** Header names are case-insensitive: any caller-set casing counts as explicit. */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

export function reliableStreamOptions(
  model: Pick<Model<Api>, "api" | "provider" | "maxTokens" | "reasoning"> &
    Partial<Pick<Model<Api>, "contextWindow">>,
  options?: ModelsSimpleStreamOptions,
  configuredMaxTokens?: number,
  accessToken?: string | (() => string | undefined),
  cacheRetention?: ModelsSimpleStreamOptions["cacheRetention"],
): ModelsSimpleStreamOptions {
  let next: ModelsSimpleStreamOptions = {
    ...options,
    ...(cacheRetention ? { cacheRetention } : {}),
    timeoutMs: options?.timeoutMs ?? modelStreamTimeoutMs(),
    maxRetries: options?.maxRetries ?? modelStreamMaxRetries(),
    maxTokens: resolveCompletionMaxTokens(
      model.maxTokens,
      configuredMaxTokens,
      options?.maxTokens,
      model.reasoning,
      model.contextWindow,
      operatorMaxTokens(model),
    ),
  };

  if (isCodexModel(model)) {
    // Pi cannot fall back after a WebSocket has emitted its start event. Long tool
    // runs then surface abnormal close 1006 as a terminal model error. SSE has
    // bounded network retries and no long-lived connection between tool turns.
    next = { ...next, transport: "sse" };
    // Compute residency routes the Codex backend to the right region. An OAuth
    // refresh can swap the credential after these options are built, so the claim
    // is read in transformHeaders at request time. Explicit headers win.
    const callerTransform = next.transformHeaders;
    next = {
      ...next,
      transformHeaders: (headers) => {
        const residency = codexComputeResidency(
          typeof accessToken === "function" ? accessToken() : accessToken,
        );
        const merged =
          residency && !hasHeader(headers, CODEX_RESIDENCY_HEADER)
            ? { ...headers, [CODEX_RESIDENCY_HEADER]: residency }
            : headers;
        return callerTransform ? callerTransform(merged) : merged;
      },
    };
  }

  // OpenCode Go/Zen require a sticky x-opencode-session header (affinity + some
  // models 400 without it). Pi 0.85.1 does not attach that header on its own.
  if (isOpenCodeProvider(model.provider)) {
    const sessionId = next.sessionId?.trim() || randomUUID();
    next = {
      ...next,
      sessionId,
      headers: {
        "x-opencode-session": sessionId,
        "x-opencode-client": "rakazo",
        ...next.headers,
      },
    };
  }

  return next;
}
