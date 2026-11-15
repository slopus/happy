import type { AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";

/** Attribution is restricted to OpenRouter inference endpoints, never compatible/custom hosts. */
export function openRouterInferenceFetch(fetcher: typeof fetch, userId?: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://openrouter.ai" ||
      !["/api/v1/chat/completions", "/api/v1/responses"].includes(url.pathname)
    )
      return fetcher(input, init);
    const headers = new Headers(
      init?.headers !== undefined
        ? init.headers
        : input instanceof Request
          ? input.headers
          : undefined,
    );
    headers.set("HTTP-Referer", "https://rakazo.com");
    headers.set("X-OpenRouter-Title", "Rakazo");
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== "string") throw new Error("OpenRouter inference requires a JSON body");
    const payload = JSON.parse(body);
    if (userId) payload.user = userId;
    return fetcher(input, { ...init, headers, body: JSON.stringify(payload) });
  };
}

const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;
// The lookup accepts only OpenRouter's own generation ids; an upstream message id is a 400.
const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/;

/** The provider's error message, never echoed request data, so a failed lookup is diagnosable. */
async function errorDetail(response: Response): Promise<string> {
  const { text } = await readBoundedText(response, 2048).catch(() => ({ text: "" }));
  let detail = text;
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === "string") detail = message;
  } catch {
    /* Not JSON: keep the raw prefix. */
  }
  return detail
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 200);
}
const tokens = z.number().int().nonnegative().nullable().optional();
const generationSchema = z.object({
  data: z.object({
    id: z.string(),
    total_cost: z.number().finite().nonnegative().nullable(),
    is_byok: z.boolean().nullable().optional(),
    upstream_inference_cost: z.number().finite().nonnegative().nullable().optional(),
    native_tokens_prompt: tokens,
    native_tokens_completion: tokens,
    native_tokens_cached: tokens,
    native_tokens_reasoning: tokens,
  }),
});

export class OpenRouterUsageLookup implements ModelUsageLookup {
  readonly provider = "openrouter";
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}
  async lookupUsage(providerRequestId: string): Promise<AgentUsage | null> {
    if (!GENERATION_ID.test(providerRequestId)) return null;
    const response = await this.fetcher(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(providerRequestId)}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 404) {
      cancelResponseBody(response);
      return null;
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new Error(
        `OpenRouter usage lookup failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const { data } = generationSchema.parse(
      await readBoundedJsonResponse(response, MAX_USAGE_RESPONSE_BYTES),
    );
    if (data.id !== providerRequestId) throw new Error("Provider returned a different generation");
    // A bring-your-own-key generation's total is only OpenRouter's fee.
    const upstreamCost = data.is_byok ? data.upstream_inference_cost : 0;
    if (data.total_cost === null || upstreamCost == null) return null;
    return {
      providerRequestId: data.id,
      inputTokens:
        data.native_tokens_prompt == null
          ? null
          : Math.max(0, data.native_tokens_prompt - (data.native_tokens_cached ?? 0)),
      totalTokens:
        data.native_tokens_prompt != null && data.native_tokens_completion != null
          ? data.native_tokens_prompt + data.native_tokens_completion
          : null,
      outputTokens: data.native_tokens_completion ?? null,
      cacheReadTokens: data.native_tokens_cached ?? null,
      reasoningTokens: data.native_tokens_reasoning ?? null,
      costUsd: data.total_cost + upstreamCost,
      costSource: "provider-reported",
      usageSource: "provider-reconciled",
    };
  }
}
