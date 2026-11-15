import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentUsage,
  DecisionProvider,
  DecisionProviderOptions,
  DecisionRequest,
  DecisionResult,
} from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import { z } from "zod";
import { estimateTextTokens, lowTextTokens } from "./context-selection.js";
import { decisionModel } from "./decision-models.js";
import { readBodyCapped } from "./web-ssrf.js";

const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

/** Two implementations of the same decision protocol; endpoint and auth never come from model output. */
export class HttpDecisionProvider implements DecisionProvider {
  constructor(
    private readonly provider: "openrouter" | "typesafe",
    private readonly options: DecisionProviderOptions,
  ) {
    if (!options.apiKey.trim()) throw new DecisionProviderError("authentication");
  }

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResult> {
    context.signal.throwIfAborted();
    const body = JSON.stringify(request);
    const callId = randomUUID();
    const pricing = decisionModel(this.provider, request.model);
    // Byte count plus a generous protocol allowance bounds tokenizer expansion.
    const inputTokensEstimate = Buffer.byteLength(body, "utf8") + 4096;
    const reservation = await this.options.callObserver?.beforeCall({
      callId,
      runId: context.runId,
      provider: this.provider,
      modelId: request.model,
      operationKind: "setup",
      inputTokensEstimate,
      maxOutputTokens: 0,
      maxCostUsd: pricing
        ? (inputTokensEstimate * pricing.inputUsdPerMillion) / 1_000_000
        : undefined,
    });
    let usage: AgentUsage | null = null;
    const pricingSnapshot = pricing ? { input: pricing.inputUsdPerMillion } : null;
    // Deliberately low, for a sent request whose usage never arrives.
    const countedTokens = {
      inputTokens: lowTextTokens(body),
      outputTokens: 0,
    };
    let sent = false;
    try {
      sent = true;
      const response = await (this.options.fetch ?? fetch)(
        this.provider === "openrouter"
          ? "https://openrouter.ai/api/alpha/decisions"
          : "https://api.typesafe.ai/v1/systemone",
        {
          method: "POST",
          redirect: "error",
          signal: context.signal,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body,
        },
      ).catch((error: unknown) => {
        // A connection failure the caller did not cause never reached the provider.
        if (!context.signal.aborted) sent = false;
        throw error;
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, usageSource: "provider-rejected" };
        void response.body?.cancel().catch(() => undefined);
        throw new DecisionProviderError(
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 422
              ? "invalid"
              : response.status === 429 || response.status === 529
                ? "busy"
                : "unavailable",
        );
      }
      const parsed = responseSchema.parse(
        JSON.parse(
          new TextDecoder().decode(await readBodyCapped(response, 64_000, context.signal)),
        ),
      );
      if (parsed.id && reservation)
        await this.options.callObserver?.onRequestId?.(reservation, parsed.id);
      usage = {
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
        costUsd: parsed.usage?.cost ?? null,
        costSource: parsed.usage?.cost === undefined ? null : "provider-reported",
        pricingSnapshot,
        ...(parsed.usage?.cost === undefined ? { countedTokens } : {}),
        providerRequestId: parsed.id ?? null,
        usageSource: "response",
        operationKind: "setup",
      };
      const answers: DecisionResult["answers"] = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = answerSchema.safeParse(parsed.answers[id]);
        if (!answer.success || !Object.hasOwn(question.criteria, answer.data.choice))
          throw new DecisionProviderError("invalid_response");
        answers[id] = answer.data;
      }
      return { model: parsed.model ?? request.model, answers, usage };
    } catch (error) {
      if (error instanceof DecisionProviderError) throw error;
      // Transport and validation errors can contain credentials or supplied state.
      throw new DecisionProviderError("unavailable");
    } finally {
      try {
        if (usage)
          await this.options.onUsage?.({
            type: "usage",
            ...usage,
            provider: this.provider,
            model: request.model,
            callId,
          });
      } finally {
        if (reservation)
          await this.options.callObserver?.afterCall(
            reservation,
            usage ??
              (sent
                ? {
                    inputTokens: null,
                    outputTokens: null,
                    costUsd: null,
                    operationKind: "setup",
                    pricingSnapshot,
                    countedTokens: context.signal.aborted
                      ? {
                          ...countedTokens,
                          ifStopped: { inputTokens: estimateTextTokens(body), outputTokens: 0 },
                        }
                      : countedTokens,
                  }
                : null),
          );
      }
    }
  }
}
