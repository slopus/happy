import type { UsageOperationKind } from "@rakazo/adapter-kit";

/** Prices are USD per million tokens. Output includes reasoning; never price it twice. */
export type EvalPricing = {
  source: string;
  version: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  longContext?: {
    thresholdTokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
  };
};
export type UsageMeasurement = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};
export type Operation = UsageOperationKind;
export const OPERATION_KINDS = [
  "answer",
  "setup",
  "retrieval",
  "subagent",
  "compaction",
] as const satisfies readonly Operation[];
export type MeasuredCall = Partial<UsageMeasurement> & {
  operation?: string;
  id: string;
  costSource?: string | null;
  /** The model that served the call, when known. A call to another model never uses the
   * explicit pricing of the model an evaluation runs on. */
  provider?: string;
  modelId?: string;
};
export function validatePricing(value: unknown): EvalPricing {
  const p = value as EvalPricing;
  if (
    !p ||
    typeof p.source !== "string" ||
    !p.source.trim() ||
    typeof p.version !== "string" ||
    !p.version.trim() ||
    ["input", "output", "cacheRead", "cacheWrite"].some(
      (k) =>
        typeof p[k as keyof EvalPricing] !== "number" ||
        !Number.isFinite(p[k as keyof EvalPricing]) ||
        Number(p[k as keyof EvalPricing]) < 0,
    )
  )
    throw new Error(
      "Pricing requires source, version and nonnegative USD per million rates for input, output, cacheRead and cacheWrite",
    );
  if (
    p.longContext &&
    (!Number.isSafeInteger(p.longContext.thresholdTokens) ||
      p.longContext.thresholdTokens < 1 ||
      [
        p.longContext.input,
        p.longContext.output,
        p.longContext.cacheRead,
        p.longContext.cacheWrite,
      ].some((v) => !Number.isFinite(v) || v < 0))
  )
    throw new Error("Invalid long-context pricing");
  if (p.cacheWrite1h !== undefined && (!Number.isFinite(p.cacheWrite1h) || p.cacheWrite1h < 0))
    throw new Error("Invalid one-hour cache pricing");
  if (
    p.longContext?.cacheWrite1h !== undefined &&
    (!Number.isFinite(p.longContext.cacheWrite1h) || p.longContext.cacheWrite1h < 0)
  )
    throw new Error("Invalid one-hour cache pricing");
  return p;
}
const buckets = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "totalTokens",
] as const;
export function measureCalls(
  calls: readonly MeasuredCall[],
  pricing?: EvalPricing,
  minimumCacheTokens?: number,
  /** The only model `pricing` applies to; calls served by any other model fall back to
   * their own provider-reported or catalog-estimated charge, and stay unknown without one. */
  pricedModel?: { provider: string; modelId: string },
) {
  const unique = [...new Map(calls.map((c) => [c.id, c])).values()];
  const sum = (key: keyof UsageMeasurement): number | null =>
    unique.length && unique.every((c) => typeof c[key] === "number")
      ? unique.reduce((n, c) => n + Number(c[key]), 0)
      : null;
  const usage = Object.fromEntries(buckets.map((k) => [k, sum(k)])) as Omit<
    UsageMeasurement,
    "costUsd"
  >;
  const ownCharge = (c: MeasuredCall) =>
    c.costSource === "pi-catalog-estimate" && typeof c.costUsd === "number" ? c.costUsd : null; // Unknown catalog placeholders remain unavailable.
  const otherModel = (c: MeasuredCall) =>
    pricedModel !== undefined &&
    (c.provider !== pricedModel.provider || c.modelId !== pricedModel.modelId);
  const priced = unique.map((c) => {
    if (c.costSource === "provider-reported" && typeof c.costUsd === "number") return c.costUsd;
    if (!pricing || otherModel(c)) return ownCharge(c);
    if (
      [c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens].some(
        (v) => typeof v !== "number",
      )
    )
      return null;
    const input = c.inputTokens! + c.cacheReadTokens! + c.cacheWriteTokens!;
    const rates =
      pricing.longContext && input >= pricing.longContext.thresholdTokens
        ? pricing.longContext
        : pricing;
    if (rates.cacheWrite1h !== undefined && typeof c.cacheWrite1hTokens !== "number") return null;
    const oneHour = typeof c.cacheWrite1hTokens === "number" ? c.cacheWrite1hTokens : 0;
    if (oneHour > c.cacheWriteTokens! || (oneHour > 0 && rates.cacheWrite1h === undefined))
      return null;
    return (
      (c.inputTokens! * rates.input +
        c.outputTokens! * rates.output +
        c.cacheReadTokens! * rates.cacheRead +
        (c.cacheWriteTokens! - oneHour) * rates.cacheWrite +
        oneHour * (rates.cacheWrite1h ?? rates.cacheWrite)) /
      1_000_000
    );
  });
  const costUsd =
    unique.length && priced.every((v) => v !== null)
      ? priced.reduce<number>((n, v) => n + v!, 0)
      : null;
  const eligibilityKnown =
    unique.length > 0 &&
    unique.every(
      (call) =>
        typeof call.inputTokens === "number" &&
        typeof call.cacheReadTokens === "number" &&
        typeof call.cacheWriteTokens === "number" &&
        (minimumCacheTokens !== undefined || call.cacheReadTokens! + call.cacheWriteTokens! > 0),
    );
  const eligibleCalls = eligibilityKnown
    ? unique.filter(
        (call) =>
          minimumCacheTokens === undefined ||
          call.inputTokens! + call.cacheReadTokens! + call.cacheWriteTokens! >= minimumCacheTokens,
      )
    : [];
  const eligible = eligibleCalls.reduce(
    (n, call) => n + call.inputTokens! + call.cacheReadTokens! + call.cacheWriteTokens!,
    0,
  );
  const reads = eligibleCalls.reduce((n, call) => n + call.cacheReadTokens!, 0);
  const operationCosts = Object.fromEntries(
    OPERATION_KINDS.map((operation) => {
      const indexes = unique.flatMap((c, i) =>
        (c.operation ?? "answer") === operation ? [i] : [],
      );
      return [
        operation,
        indexes.every((i) => priced[i] !== null)
          ? indexes.reduce((n, i) => n + priced[i]!, 0)
          : null,
      ];
    }),
  ) as Record<Operation, number | null>;
  return {
    ...usage,
    costUsd,
    costSources: [
      ...new Set(
        unique.flatMap((call, index) =>
          priced[index] === null
            ? []
            : [
                call.costSource === "provider-reported"
                  ? "provider-reported"
                  : pricing && !otherModel(call)
                    ? "explicit-pricing-estimate"
                    : "pi-catalog-estimate",
              ],
        ),
      ),
    ],
    modelCalls: unique.length,
    cacheHitRate: eligibilityKnown && eligible ? reads / eligible : null,
    operationCosts,
  };
}
/** Concurrency-safe reservations. This guard estimates spend; it is not a billing guarantee. */
export class SpendBudget {
  private spent = 0;
  private reservations = new Map<string, { estimate: number; pricing?: EvalPricing }>();
  private serial = 0;
  private unavailablePricing = false;
  constructor(
    readonly capUsd = 5,
    readonly pricing?: EvalPricing,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("Spend cap must be positive");
  }
  reserve(
    inputTokens: number,
    maxOutputTokens: number,
    cacheWriteRetention?: "1h",
    pricing = this.pricing,
  ): string {
    if (this.unavailablePricing)
      throw new Error("Eval model has no configured pricing for observed cache writes");
    if (!pricing) throw new Error("Live inference requires explicit pricing");
    if (![inputTokens, maxOutputTokens].every((v) => Number.isSafeInteger(v) && v >= 0))
      throw new Error("A conservative token estimate is required before inference");
    // The input estimate is an upper bound: actual usage may fall into either tier.
    // Reserve the largest reachable input bucket and output rate, even for cheaper long tiers.
    const tiers: Array<
      Pick<EvalPricing, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">
    > = [pricing];
    if (pricing.longContext && inputTokens >= pricing.longContext.thresholdTokens)
      tiers.push(pricing.longContext);
    if (cacheWriteRetention === "1h" && tiers.some((rates) => rates.cacheWrite1h === undefined))
      throw new Error("Eval model has no configured pricing for requested one-hour cache writes");
    const estimate =
      (inputTokens *
        Math.max(
          ...tiers.flatMap((rates) => [
            rates.input,
            rates.cacheRead,
            rates.cacheWrite,
            rates.cacheWrite1h ?? rates.cacheWrite,
          ]),
        ) +
        maxOutputTokens * Math.max(...tiers.map((rates) => rates.output))) /
      1_000_000;
    if (
      this.spent + [...this.reservations.values()].reduce((n, v) => n + v.estimate, 0) + estimate >
      this.capUsd
    )
      throw new Error("Eval spend cap would be exceeded");
    const id = String(++this.serial);
    this.reservations.set(id, { estimate, pricing });
    return id;
  }
  /** Reserves a call to a model the eval has no per-token pricing for, at that model's own
   * conservative cost bound; its provider-reported or catalog-estimated charge settles it. */
  reserveCostBound(estimateUsd: number): string {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0)
      throw new Error("A conservative cost bound is required before inference");
    if (
      this.spent +
        [...this.reservations.values()].reduce((n, v) => n + v.estimate, 0) +
        estimateUsd >
      this.capUsd
    )
      throw new Error("Eval spend cap would be exceeded");
    const id = String(++this.serial);
    this.reservations.set(id, { estimate: estimateUsd });
    return id;
  }
  settle(id: string, actualUsd: number | null) {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) throw new Error("Unknown spend reservation");
    this.reservations.delete(id);
    this.spent += actualUsd ?? reservation.estimate; // Missing usage must not restore potentially incurred spend.
  }
  settleUsage(
    id: string,
    usage: (Partial<UsageMeasurement> & { costSource?: string | null }) | null,
  ) {
    const pricing = this.reservations.get(id)?.pricing;
    const priced = usage ? measureCalls([{ id, ...usage }], pricing).costUsd : null;
    // A bounded reservation has no per-token rates; its own bound already covers the write.
    if (
      pricing &&
      usage &&
      typeof usage.cacheWrite1hTokens === "number" &&
      usage.cacheWrite1hTokens > 0
    ) {
      const inputBuckets = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
      const promptTokens = inputBuckets.every((value) => typeof value === "number")
        ? inputBuckets.reduce<number>((sum, value) => sum + Number(value), 0)
        : typeof usage.totalTokens === "number" && typeof usage.outputTokens === "number"
          ? Math.max(0, usage.totalTokens - usage.outputTokens)
          : undefined;
      const longTier = pricing?.longContext;
      const applicable =
        longTier && promptTokens !== undefined && promptTokens >= longTier.thresholdTokens
          ? longTier
          : pricing;
      if (
        applicable?.cacheWrite1h === undefined ||
        (promptTokens === undefined && longTier && longTier.cacheWrite1h === undefined)
      )
        this.unavailablePricing = true;
    }
    if (priced !== null) return this.settle(id, priced);
    if (this.unavailablePricing) return this.settle(id, null);
    if (
      usage &&
      pricing &&
      typeof usage.inputTokens === "number" &&
      typeof usage.outputTokens === "number" &&
      typeof usage.totalTokens === "number"
    ) {
      const unknownInput = Math.max(0, usage.totalTokens - usage.inputTokens - usage.outputTokens);
      const promptTokens = usage.inputTokens + unknownInput;
      const rates =
        pricing.longContext && promptTokens >= pricing.longContext.thresholdTokens
          ? pricing.longContext
          : pricing;
      // Charge an upper bound for unclassified prompt buckets; report cost remains unknown.
      return this.settle(
        id,
        (usage.inputTokens * rates.input +
          unknownInput *
            Math.max(
              rates.input,
              rates.cacheRead,
              rates.cacheWrite,
              rates.cacheWrite1h ?? rates.cacheWrite,
            ) +
          usage.outputTokens * rates.output) /
          1_000_000,
      );
    }
    this.settle(id, null);
  }
  get usedUsd() {
    return this.spent;
  }
  get reservedUsd() {
    return [...this.reservations.values()].reduce((n, v) => n + v.estimate, 0);
  }
}

export type CacheDecisionMeasurement = {
  predictedCache: "likely-warm" | "likely-cold" | "unknown";
  observedReuse: boolean | null;
  estimatedInputTokens: number;
  droppedMessages: number;
  truncatedToolResults: number;
  costUsd?: number | null;
  cacheReadTokens?: number | null;
};
export function summarizeCacheDecisions(
  decisions: readonly CacheDecisionMeasurement[],
  modelCalls = decisions.length,
) {
  const observed = decisions.filter((d) => d.observedReuse !== null);
  const known = observed.filter((d) => d.predictedCache !== "unknown");
  return {
    measuredCalls: decisions.length,
    untrackedModelCalls: Math.max(0, modelCalls - decisions.length),
    observedHits: observed.filter((d) => d.observedReuse === true).length,
    observedMisses: observed.filter((d) => d.observedReuse === false).length,
    unavailableObservations: decisions.length - observed.length,
    predictionAccuracy: known.length
      ? known.filter((d) => (d.predictedCache === "likely-warm") === d.observedReuse).length /
        known.length
      : null,
    droppedMessages: decisions.reduce((n, d) => n + d.droppedMessages, 0),
    truncatedToolResults: decisions.reduce((n, d) => n + d.truncatedToolResults, 0),
    byPrediction: Object.fromEntries(
      ["likely-warm", "likely-cold", "unknown"].map((prediction) => {
        const calls = decisions.filter((d) => d.predictedCache === prediction);
        return [
          prediction,
          {
            calls: calls.length,
            costUsd:
              calls.length && calls.every((c) => typeof c.costUsd === "number")
                ? calls.reduce((n, c) => n + c.costUsd!, 0)
                : null,
            cacheReadTokens:
              calls.length && calls.every((c) => typeof c.cacheReadTokens === "number")
                ? calls.reduce((n, c) => n + c.cacheReadTokens!, 0)
                : null,
          },
        ];
      }),
    ),
  };
}
