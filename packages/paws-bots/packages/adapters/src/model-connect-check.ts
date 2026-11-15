import type { Context } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { MODEL_REQUEST_LIMIT_ERROR, normalizeRunError } from "@rakazo/core";
import { Type } from "typebox";
import { withChatCompletionsCompatibility } from "./chat-completions-compat.js";
import { withCloudflareAuth } from "./cloudflare-ai-gateway.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { reliableModelStream } from "./pi-runtime-stream.js";

/** Long enough for a cold provider to answer headers, short enough to keep Connect snappy. */
export const MODEL_CONNECT_CHECK_TIMEOUT_MS = 15_000;

/**
 * The check stops at the first accepted response, but providers reserve credit against the
 * requested output ceiling, so keep it small: a key funded for real runs must pass.
 */
const MODEL_CONNECT_CHECK_MAX_TOKENS = 1024;

const CHECK_CONTEXT: Context = {
  systemPrompt: "Reply with OK.",
  messages: [{ role: "user", content: "OK?", timestamp: 0 }],
  tools: [{ name: "noop", description: "Does nothing.", parameters: Type.Object({}) }],
};

/**
 * Failures that every run on this key and model would hit too. Rate limits, outages, and
 * timeouts are left to the run, so a slow or busy provider never blocks a connection.
 */
const BLOCKING_KINDS = new Set(["auth", "access", "model", "key", "credit", "spending"]);

/**
 * Send one minimal agent request and stop as soon as the provider accepts it, so a key without
 * credit, an app-only free tier, a retired model, or one without tool support is refused at
 * connect with the reason runs would show. Anything inconclusive passes.
 */
export async function verifyModelServesAgents(
  config: Pick<
    AgentRunModel,
    "provider" | "id" | "apiKey" | "accountId" | "gatewayId" | "maxTokens"
  >,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const { models, model, apiKey } = resolveRuntimeModel(config);
  if (!model || !apiKey) return;
  const accepted = new AbortController();
  const signal = AbortSignal.any([
    accepted.signal,
    AbortSignal.timeout(MODEL_CONNECT_CHECK_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const stream = reliableModelStream(
    models,
    model,
    CHECK_CONTEXT,
    withChatCompletionsCompatibility(
      model,
      withCloudflareAuth(config, {
        apiKey,
        signal,
        maxRetries: 0,
        maxTokens: MODEL_CONNECT_CHECK_MAX_TOKENS,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }) ?? {},
    ),
    config.maxTokens,
  );
  // Providers emit `start` only after a successful HTTP response.
  for await (const event of stream) {
    if (event.type === "start") {
      accepted.abort();
      break;
    }
  }
  if (accepted.signal.aborted) return;
  options.signal?.throwIfAborted();
  const result = await stream.result();
  if (result.stopReason !== "error" || !result.errorMessage) return;
  const failure = normalizeRunError(result.errorMessage);
  if (failure.kind === "context") throw new Error(MODEL_REQUEST_LIMIT_ERROR);
  if (failure.kind && BLOCKING_KINDS.has(failure.kind)) throw new Error(failure.summary);
}
