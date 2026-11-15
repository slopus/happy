import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AgentRuntimeEvent,
  AgentUsage,
  ModelCallObserver,
  UsageOperationKind,
} from "@rakazo/adapter-kit";
import { Dispatcher } from "undici";
import { withChatCompletionsCompatibility } from "./chat-completions-compat.js";
import type { ContextBudget } from "./context-selection.js";
import { estimateTextTokens, lowTextTokens } from "./context-selection.js";
import { withGoogleToolHistory } from "./google-tool-history.js";
import { estimateModelContextTokens } from "./model-context.js";
import { openRouterInferenceFetch } from "./openrouter-usage.js";
import { requestedPiCacheWriteRetention, resolvePiCacheRetention } from "./pi-cache-retention.js";
import { recordPiTelemetryContent, withPiTelemetrySpan } from "./pi-telemetry.js";
import type { RejectedProviderRequest } from "./provider-request-shape.js";
import { withRejectedRequestCapture } from "./provider-request-shape.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

/** Pi initializes absent usage to zero. Only raw numeric fields can prove reported zero. */
export type ReportedUsageFields = Set<keyof AgentUsage>;
const reportedRequestIds = new WeakMap<ReportedUsageFields, string>();
const rejectedRequests = new WeakSet<ReportedUsageFields>();
const sseObserved = new WeakSet<ReportedUsageFields>();
const dispatchedRequests = new WeakSet<ReportedUsageFields>();
const reportedCosts = new WeakMap<ReportedUsageFields, number>();
const reportedValues = new WeakMap<ReportedUsageFields, Map<keyof AgentUsage, number>>();
export function normalizePiUsage(
  usage: Partial<Usage> | undefined,
  model: Pick<Model<Api>, "cost">,
  reported: ReportedUsageFields = new Set(),
): AgentUsage {
  // A rejected request never generated, so every token count is zero — even if the
  // error payload carries numbers. Decide this before normalizing any token field.
  const rejected = rejectedRequests.has(reported);
  const token = (value: number | undefined, key: keyof AgentUsage) =>
    rejected
      ? 0
      : typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          (value > 0 || (reported.has(key) && (reportedValues.get(reported)?.get(key) ?? 0) === 0))
        ? value
        : null;
  const inputTokens = token(usage?.input, "inputTokens");
  const outputTokens = token(usage?.output, "outputTokens");
  const cacheReadTokens = token(usage?.cacheRead, "cacheReadTokens");
  const cacheWriteTokens = token(usage?.cacheWrite, "cacheWriteTokens");
  const rawTotal = reportedValues.get(reported)?.get("totalTokens");
  const buckets = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens];
  const derivedTotal = buckets.every((value) => value !== null)
    ? buckets.reduce<number>((sum, value) => sum + value!, 0)
    : null;
  // Pi synthesizes totals using zero placeholders for absent cache measurements.
  // Trust a reported total, or derive one only from a complete measured breakdown.
  const totalTokens = reported.has("totalTokens")
    ? token(rawTotal ?? usage?.totalTokens, "totalTokens")
    : derivedTotal !== null && Number.isSafeInteger(derivedTotal)
      ? derivedTotal
      : null;
  const costKnown =
    !!model.cost &&
    [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some(
      (rate) => rate > 0,
    ) &&
    inputTokens !== null &&
    outputTokens !== null &&
    (model.cost.cacheRead === 0 || cacheReadTokens !== null) &&
    (model.cost.cacheWrite === 0 || cacheWriteTokens !== null);
  const providerCost = reportedCosts.get(reported);
  return {
    providerRequestId: reportedRequestIds.get(reported) ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: token(usage?.cacheWrite1h, "cacheWrite1hTokens"),
    reasoningTokens: token(usage?.reasoning, "reasoningTokens"),
    totalTokens,
    costUsd:
      (rejected ? 0 : providerCost) ??
      (costKnown && typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : null),
    costSource: rejected
      ? "provider-rejection"
      : providerCost !== undefined
        ? "provider-reported"
        : costKnown
          ? "pi-catalog-estimate"
          : null,
    pricingSnapshot: model.cost ? JSON.parse(JSON.stringify(model.cost)) : null,
    pricingVersion:
      rejected || providerCost !== undefined ? null : costKnown ? "pi-ai-1.3.0" : null,
    usageSource: rejected
      ? "provider-rejected"
      : reported.size
        ? "provider-reported-via-pi"
        : "pi-normalized",
  };
}

type RawUsage = Record<string, unknown> & {
  prompt_tokens_details?: Record<string, unknown>;
  input_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
  cache_creation?: Record<string, unknown>;
  cost_details?: Record<string, unknown>;
};

type RawUsageEvent = {
  id?: unknown;
  usage?: RawUsage;
  response?: { id?: unknown; usage?: RawUsage };
  message?: { id?: unknown; usage?: RawUsage };
};

async function observeRequestId(
  id: unknown,
  reported: ReportedUsageFields,
  onRequestId?: (id: string) => void | Promise<void>,
): Promise<void> {
  if (
    reportedRequestIds.has(reported) ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 256
  )
    return;
  reportedRequestIds.set(reported, id);
  await onRequestId?.(id);
}

async function observeUsageEvent(
  raw: unknown,
  reported: ReportedUsageFields,
  onRequestId?: (id: string) => void | Promise<void>,
): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  const event = raw as RawUsageEvent;
  await observeRequestId(
    event.response?.id ?? event.message?.id ?? event.id,
    reported,
    onRequestId,
  );
  try {
    const usage = event.usage ?? event.response?.usage ?? event.message?.usage;
    if (!usage || typeof usage !== "object") return;
    const mark = (value: unknown, key: keyof AgentUsage) => {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        reported.add(key);
        const values = reportedValues.get(reported) ?? new Map();
        values.set(key, value);
        reportedValues.set(reported, values);
      }
    };
    const rawInput = usage.prompt_tokens ?? usage.input_tokens;
    const includesCache =
      usage.prompt_tokens !== undefined ||
      event.response !== undefined ||
      usage.input_tokens_details !== undefined;
    const rawRead =
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cached_tokens;
    const rawWrite =
      usage.prompt_tokens_details?.cache_write_tokens ??
      usage.input_tokens_details?.cache_write_tokens;
    mark(
      typeof rawInput === "number" && includesCache
        ? Math.max(
            0,
            rawInput -
              (typeof rawRead === "number" ? rawRead : 0) -
              (typeof rawWrite === "number" ? rawWrite : 0),
          )
        : rawInput,
      "inputTokens",
    );
    mark(usage.completion_tokens ?? usage.output_tokens, "outputTokens");
    mark(usage.total_tokens, "totalTokens");
    // With a bring-your-own-key upstream, OpenRouter's cost is only its fee; the upstream
    // provider bills the inference separately.
    const upstream = usage.is_byok === true ? usage.cost_details?.upstream_inference_cost : 0;
    if (
      typeof usage.cost === "number" &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0 &&
      typeof upstream === "number" &&
      Number.isFinite(upstream) &&
      upstream >= 0
    )
      reportedCosts.set(reported, usage.cost + upstream);
    mark(rawRead ?? usage.cache_read_input_tokens, "cacheReadTokens");
    mark(rawWrite ?? usage.cache_creation_input_tokens, "cacheWriteTokens");
    mark(usage.cache_creation?.ephemeral_1h_input_tokens, "cacheWrite1hTokens");
    mark(
      usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens,
      "reasoningTokens",
    );
  } catch {
    /* Invalid/non-JSON stream frames are handled by the provider parser. */
  }
}

/** Read only bounded SSE frames, retaining field presence, never provider text or payloads. */
export function usageReportingFetch(
  fetcher: typeof fetch,
  reported: ReportedUsageFields,
  onRequestId?: (id: string) => void | Promise<void>,
): typeof fetch {
  return async (input, init) => {
    // The wrapper hides the default fetch identity from the SSRF guard. Pair
    // its transport when the guard attaches a package dispatcher (a plain or proxy-aware
    // agent); keep injected fetches.
    const transport =
      init && "dispatcher" in init && init.dispatcher instanceof Dispatcher
        ? fetchPairedWithDispatcher(fetcher)
        : fetcher;
    rejectedRequests.delete(reported);
    sseObserved.delete(reported);
    dispatchedRequests.add(reported);
    let response: Response;
    try {
      response = await transport(input, init);
    } catch (error) {
      // A connection failure the caller did not cause never reached the provider; a stop
      // before any response may have, so it keeps counting as sent.
      if (!init?.signal?.aborted) dispatchedRequests.delete(reported);
      throw error;
    }
    // OpenRouter's Anthropic-format stream carries the upstream message id; its usage
    // lookup accepts only the generation id from this header.
    await observeRequestId(response.headers.get("x-generation-id"), reported, onRequestId);
    // These HTTP responses reject the request before generation. Timeouts,
    // transport failures, and server errors remain uncertain and retain their holds.
    if (
      !response.headers.get("content-type")?.includes("text/event-stream") &&
      [400, 401, 402, 403, 404, 405, 406, 413, 415, 422, 429].includes(response.status)
    )
      rejectedRequests.add(reported);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      return response;
    sseObserved.add(reported);
    let buffer = "";
    let dropping = false;
    const decoder = new TextDecoder();
    const observe = async (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      await observeUsageEvent(event, reported, onRequestId);
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            if (!dropping && frame.length <= 262144) await observe(frame);
            dropping = false;
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
          if (buffer.length > 262144) {
            buffer = buffer.slice(-1);
            dropping = true;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** One exclusive bucket per whole model call, including any answer alongside retrieval.
 * Setup, compaction and subagent attribution takes precedence. Only immediately consumed
 * trailing tool results count; an old search in retained history does not reclassify new work.
 */
function usageOperationKind(
  base: UsageOperationKind,
  context: Context,
  message: AssistantMessage,
): UsageOperationKind {
  if (base !== "answer") return base;
  const historyTool = (name: string) => name === "search_history" || name === "read_history";
  if (message.content.some((part) => part.type === "toolCall" && historyTool(part.name)))
    return "retrieval";
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const previous = context.messages[index]!;
    if (previous.role !== "toolResult") break;
    if (historyTool(previous.toolName)) return "retrieval";
  }
  return base;
}

/** Guard and account every actual model invocation, including tools, failures and subagents. */
export function observedPiStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  push: (event: AgentRuntimeEvent) => void,
  observer?: ModelCallObserver,
  attribution: {
    operationKind: UsageOperationKind;
    agentId?: string;
    userId?: string;
    runId?: string;
  } = {
    operationKind: "answer",
  },
  hooks?: {
    prepareContext?: (context: Context, model: Model<Api>) => Context;
    imageTokens?: ContextBudget["imageTokens"];
    onUsage?: (usage: AgentUsage) => void;
    recordUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => void | Promise<void>;
    /** Provider failures only; excludes context, reservations and usage settlement. */
    onProviderError?: (message: AssistantMessage) => void;
    onRejectedRequest?: (rejection: RejectedProviderRequest | undefined, model: Model<Api>) => void;
  },
) {
  const stream = createAssistantMessageEventStream();
  const reported: ReportedUsageFields = new Set();
  const callId = randomUUID();
  const emitUsage = async (usage: AgentUsage, operationKind = attribution.operationKind) => {
    const event = {
      type: "usage" as const,
      ...usage,
      provider: model.provider,
      model: model.id,
      callId,
      agentId: attribution.agentId,
      operationKind,
    };
    try {
      await hooks?.recordUsage?.(event);
    } catch (error) {
      push(event);
      throw error;
    }
    push({ ...event, ...(hooks?.recordUsage ? { accounted: true } : {}) });
  };
  void withPiTelemetrySpan(
    "pi.ai.request",
    {
      "pi.ai.operation": "stream",
      "pi.ai.provider": model.provider,
      "pi.ai.model": model.id,
      "pi.ai.api": model.api,
      "pi.ai.streaming": true,
    },
    async (span) => {
      let normalized: AgentUsage | null = null;
      let reservation: string | undefined;
      let started = false;
      let settled = false;
      let partialMessage: AssistantMessage | undefined;
      let providerError: unknown;
      let providerThrew = false;
      let inputTokensEstimate = 0;
      let collectRawUsage = false;
      let sendFailed = false;
      // A call sent to the provider that ended without its cost keeps our own count,
      // so the reconciler can price it if the provider never reports one.
      const receipt = (usage: AgentUsage, message?: AssistantMessage): AgentUsage => {
        if (usage.costUsd != null) return usage;
        const text = message ? receivedText(message) : "";
        // The provider may bill a prompt it received even if no response ever arrived.
        const dispatched = !sendFailed && (!collectRawUsage || dispatchedRequests.has(reported));
        if (!dispatched && !usage.providerRequestId && !text) return usage;
        return {
          ...usage,
          countedTokens: {
            inputTokens: inputTokensEstimate,
            outputTokens: lowTextTokens(text),
            // A deploy, a stalled stream, or the user can abort; the reconciler tells them apart.
            ...(options?.signal?.aborted
              ? {
                  ifStopped: {
                    inputTokens: inputTokensEstimate,
                    outputTokens: estimateTextTokens(text),
                  },
                }
              : {}),
          },
        };
      };
      try {
        // A tool-budget or cancellation stop can reach Pi's next-turn hook after
        // aborting. It is not a model invocation and must not create unknown usage.
        options?.signal?.throwIfAborted();
        // Reject an unsupported declared control before reserving or making any request.
        const cacheRetention = resolvePiCacheRetention(model, options?.cacheRetention);
        const preparedContext = hooks?.prepareContext?.(context, model) ?? context;
        recordPiTelemetryContent(span, "pi.ai.prompt", preparedContext);
        inputTokensEstimate = observer
          ? estimateModelContextTokens(preparedContext, hooks?.imageTokens)
          : 0;
        const cacheWriteRetention = requestedPiCacheWriteRetention(model, cacheRetention);
        reservation = observer
          ? await observer.beforeCall({
              callId,
              runId: attribution.runId,
              operationKind: attribution.operationKind,
              provider: model.provider,
              modelId: model.id,
              inputTokensEstimate,
              maxOutputTokens: options?.maxTokens ?? model.maxTokens,
              maxCostUsd: maximumModelCallCost(
                model.cost,
                inputTokensEstimate,
                options?.maxTokens ?? model.maxTokens,
                cacheWriteRetention,
              ),
              cacheWriteRetention,
            })
          : undefined;
        options?.signal?.throwIfAborted();
        started = true;
        // Some Pi adapters reject custom fetch outright. Only audited SSE families opt in.
        collectRawUsage =
          /^(openai-|anthropic-)/.test(model.api) && !model.provider.startsWith("google");
        // Each guarded reservation covers one HTTP attempt, not hidden SDK retries.
        const historyOptions = withGoogleToolHistory(
          model,
          withChatCompletionsCompatibility(model, {
            ...options,
            ...(cacheRetention ? { cacheRetention } : {}),
            ...(observer ? { maxRetries: 0 } : {}),
          }),
        );
        const streamOptions = hooks?.onRejectedRequest
          ? withRejectedRequestCapture(historyOptions, hooks.onRejectedRequest)
          : historyOptions;
        let upstream: ReturnType<Models["streamSimple"]>;
        try {
          const reportRequestId = (id: string) =>
            reservation !== undefined ? observer?.onRequestId?.(reservation, id) : undefined;
          const callerOnProviderStreamEvent = streamOptions?.onProviderStreamEvent;
          upstream = models.streamSimple(
            model,
            preparedContext,
            collectRawUsage
              ? {
                  ...streamOptions,
                  fetch: usageReportingFetch(
                    model.provider === "openrouter"
                      ? openRouterInferenceFetch(
                          streamOptions?.fetch ?? globalThis.fetch,
                          attribution.userId,
                        )
                      : (streamOptions?.fetch ?? globalThis.fetch),
                    reported,
                    reportRequestId,
                  ),
                  onProviderStreamEvent: async (event, eventModel) => {
                    if (!sseObserved.has(reported)) {
                      await observeUsageEvent(event, reported, reportRequestId);
                    }
                    await callerOnProviderStreamEvent?.(event, eventModel);
                  },
                }
              : streamOptions,
          );
        } catch (error) {
          // The request is sent while the stream is consumed, so this one never left.
          sendFailed = true;
          providerThrew = true;
          providerError = error;
          throw error;
        }
        const events = hooks?.onProviderError
          ? (async function* () {
              try {
                yield* upstream;
              } catch (error) {
                providerThrew = true;
                providerError = error;
                throw error;
              }
            })()
          : upstream;
        for await (const event of events) {
          // A terminal error can arrive with empty content after a partial answer streamed.
          const received = partialMessage;
          partialMessage =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            normalized = normalizePiUsage(message.usage, model, reported);
            span?.setAttributes({
              "pi.ai.response.stop_reason": message.stopReason,
              "pi.ai.usage.input_tokens": normalized.inputTokens ?? undefined,
              "pi.ai.usage.output_tokens": normalized.outputTokens ?? undefined,
              "pi.ai.usage.cache_read_tokens": normalized.cacheReadTokens ?? undefined,
              "pi.ai.usage.cache_write_tokens": normalized.cacheWriteTokens ?? undefined,
              "pi.ai.usage.reasoning_tokens": normalized.reasoningTokens ?? undefined,
              "pi.ai.usage.total_tokens": normalized.totalTokens ?? undefined,
              "pi.ai.usage.cost": normalized.costUsd ?? undefined,
            });
            if (event.type === "error") span?.setStatus({ status: "error" });
            recordPiTelemetryContent(span, "pi.ai.response", message.content);
            const operationKind = usageOperationKind(
              attribution.operationKind,
              preparedContext,
              message,
            );
            if (observer && reservation !== undefined) {
              await observer.afterCall(
                reservation,
                receipt(
                  { ...normalized, operationKind },
                  message.content.length ? message : (received ?? message),
                ),
              );
              settled = true;
            }
            await emitUsage(normalized, operationKind);
            try {
              hooks?.onUsage?.(normalized);
            } catch {
              /* Cache telemetry cannot discard accounted spend. */
            }
          }
          if (event.type === "error") hooks?.onProviderError?.(event.error);
          stream.push(event);
        }
        stream.end(await upstream.result());
      } catch (error) {
        span?.setStatus({ status: "error" });
        let terminalError = error;
        if (started && normalized === null) {
          try {
            await emitUsage(normalizePiUsage(undefined, model, reported));
          } catch (accountingError) {
            terminalError = accountingError;
          }
        }
        if (observer && reservation !== undefined && !settled) {
          // Keep the reservation alive until settlement finishes, before exposing termination.
          settled = true;
          try {
            await observer.afterCall(
              reservation,
              started
                ? receipt(
                    normalized ?? normalizePiUsage(undefined, model, reported),
                    partialMessage,
                  )
                : { ...normalizePiUsage(undefined, model), costUsd: 0, usageSource: "not-started" },
            );
          } catch {
            /* Already failing. */
          }
        }
        // Preserve a proper Pi terminal message so Agent and cancellation both settle.
        const message = {
          role: "assistant" as const,
          content: hooks?.onProviderError ? (partialMessage?.content ?? []) : [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error" as const,
          errorMessage:
            terminalError instanceof Error ? terminalError.message : String(terminalError),
          timestamp: Date.now(),
        };
        if (providerThrew && terminalError === providerError) hooks?.onProviderError?.(message);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    },
  );
  return stream;
}

function receivedText(message: AssistantMessage): string {
  return message.content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "thinking"
          ? part.thinking
          : part.type === "toolCall"
            ? part.name + JSON.stringify(part.arguments ?? {})
            : "",
    )
    .join("");
}

/** Includes higher context tiers and long-lived cache writes before any request can spend. */
export function maximumModelCallCost(
  cost: Model<Api>["cost"],
  inputTokens: number,
  outputTokens: number,
  cacheWriteRetention?: "1h",
): number | undefined {
  const tiers = [cost, ...(cost.tiers ?? [])];
  if (
    !tiers.every((tier) =>
      [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(
        (rate) => Number.isFinite(rate) && rate >= 0,
      ),
    ) ||
    // An unlisted model gets zero placeholder rates; with no positive rate anywhere
    // the price is unknown, not free, so reservation must refuse the call.
    !tiers.some((tier) =>
      [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].some((rate) => rate > 0),
    )
  )
    return undefined;
  const inputRate = Math.max(
    ...tiers.flatMap((tier) => [
      tier.input,
      tier.cacheRead,
      tier.cacheWrite * (cacheWriteRetention === "1h" ? 2 : 1),
    ]),
  );
  const outputRate = Math.max(...tiers.map((tier) => tier.output));
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}
