import { expect, it } from "vitest";
import { gradeHistory, historyFixture } from "./history-fixtures.js";
import {
  measureCalls,
  SpendBudget,
  summarizeCacheDecisions,
  validatePricing,
} from "./measurement.js";

const pricing = {
  source: "fixture",
  version: "v1",
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: 3,
};
it("accounts cache buckets once, reasoning within output, operations and duplicate events", () => {
  const call = {
    id: "one",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteTokens: 10,
    reasoningTokens: 20,
    totalTokens: 360,
    operation: "compaction",
  };
  const report = measureCalls([call, call], pricing);
  expect(report.costUsd).toBeCloseTo(0.00025);
  expect(report.modelCalls).toBe(1);
  expect(report.cacheHitRate).toBeCloseTo(200 / 310);
  expect(report.operationCosts.compaction).toBe(report.costUsd);
});
it("does not turn missing usage or placeholder catalog costs into free inference", () => {
  expect(measureCalls([{ id: "one", inputTokens: 0, outputTokens: 0 }]).costUsd).toBeNull();
  expect(
    measureCalls([{ id: "one", inputTokens: 0, outputTokens: 0 }], pricing).cacheHitRate,
  ).toBeNull();
  expect(() => validatePricing({ input: 0 })).toThrow();
});
it("reserves concurrent spend and retains estimated spend after failed calls", () => {
  const budget = new SpendBudget(0.005, pricing);
  const id = budget.reserve(1000, 500);
  expect(() => budget.reserve(1000, 500)).toThrow("cap");
  budget.settle(id, null);
  expect(budget.usedUsd).toBe(0.004);
  expect(budget.reservedUsd).toBe(0);
  expect(() => new SpendBudget().reserve(1, 1)).toThrow("pricing");
});
it("reserves another model's call at its own cost bound, never at the eval model's rates", () => {
  const budget = new SpendBudget(5, pricing);
  const id = budget.reserveCostBound(0.36);
  budget.settleUsage(id, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
  // No provider charge and no catalog estimate: the model's own bound is spent, not 0.002 USD
  // of eval-model rates for these tokens.
  expect(budget.usedUsd).toBeCloseTo(0.36);
  expect(() => budget.reserveCostBound(5)).toThrow("cap");
  expect(() => budget.reserveCostBound(Number.NaN)).toThrow("conservative");
});
it("settles a bounded reservation at the call's own reported or catalog-estimated charge", () => {
  const budget = new SpendBudget(5, pricing);
  const reported = budget.reserveCostBound(0.36);
  budget.settleUsage(reported, {
    inputTokens: 10,
    outputTokens: 4,
    costUsd: 0.002,
    costSource: "provider-reported",
  });
  expect(budget.usedUsd).toBeCloseTo(0.002);
  const catalog = budget.reserveCostBound(0.36);
  budget.settleUsage(catalog, {
    inputTokens: 10,
    outputTokens: 4,
    costUsd: 0.02,
    costSource: "pi-catalog-estimate",
  });
  expect(budget.usedUsd).toBeCloseTo(0.022);
});
it("keeps eval-model reservations working after a bounded call reports one-hour writes", () => {
  const budget = new SpendBudget(1, { ...pricing, cacheWrite1h: 6 });
  const id = budget.reserveCostBound(0.01);
  budget.settleUsage(id, {
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 100,
    totalTokens: 110,
  });
  expect(budget.usedUsd).toBeCloseTo(0.01);
  expect(() => budget.reserve(100, 10)).not.toThrow();
});
it("prices another model's reported call at its own charge when the pricing covers the eval model", () => {
  const evalModel = { provider: "compatible", modelId: "cheap-eval-model" };
  const catalogued = measureCalls(
    [
      {
        id: "eval",
        provider: "compatible",
        modelId: "cheap-eval-model",
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        id: "checker",
        provider: "compatible",
        modelId: "expensive-checker-model",
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.36,
        costSource: "pi-catalog-estimate",
      },
    ],
    pricing,
    undefined,
    evalModel,
  );
  expect(catalogued.costUsd).toBeCloseTo(0.001 + 0.36);
  expect(catalogued.costSources).toEqual(["explicit-pricing-estimate", "pi-catalog-estimate"]);
  expect(
    measureCalls(
      [
        {
          id: "checker",
          provider: "compatible",
          modelId: "expensive-checker-model",
          inputTokens: 10,
          outputTokens: 4,
        },
      ],
      pricing,
      undefined,
      evalModel,
    ).costUsd,
  ).toBeNull();
});
it("generates reproducible 10k originals and rejects obsolete decisions and writes", () => {
  const fixture = historyFixture(10000, "changed");
  expect(fixture).toEqual(historyFixture(10000, "changed"));
  expect(fixture.messages).toHaveLength(10000);
  expect(gradeHistory(fixture, "Tuesday graphite", 0).every((c) => c.pass)).toBe(true);
  expect(gradeHistory(fixture, "Friday cobalt", 0).every((c) => c.pass)).toBe(false);
  expect(gradeHistory(fixture, "Tuesday graphite", 1).every((c) => c.pass)).toBe(false);
});

it("uses provider-reported charge when cache buckets are unavailable", () => {
  expect(
    measureCalls(
      [
        {
          id: "one",
          inputTokens: 10,
          outputTokens: 4,
          costUsd: 0.002,
          costSource: "provider-reported",
        },
      ],
      pricing,
    ).costUsd,
  ).toBe(0.002);
});
it("uses long-context rates and bounds missing cache classifications", () => {
  const tiered = {
    ...pricing,
    longContext: { thresholdTokens: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 6 },
  };
  const budget = new SpendBudget(1, tiered);
  const id = budget.reserve(100, 10);
  budget.settleUsage(id, { inputTokens: 50, outputTokens: 10, totalTokens: 110 });
  expect(budget.usedUsd).toBeCloseTo(0.00044);
});

it("cache telemetry compares predictions only against known observations", () => {
  const base = {
    estimatedInputTokens: 100,
    droppedMessages: 2,
    truncatedToolResults: 1,
    costUsd: 0.01,
    cacheReadTokens: 50,
  };
  const telemetry = summarizeCacheDecisions([
    { ...base, predictedCache: "likely-warm", observedReuse: true },
    { ...base, predictedCache: "likely-cold", observedReuse: true },
    { ...base, predictedCache: "unknown", observedReuse: null },
  ]);
  expect(telemetry.observedHits).toBe(2);
  expect(telemetry.unavailableObservations).toBe(1);
  expect(telemetry.predictionAccuracy).toBe(0.5);
  expect(telemetry.byPrediction["likely-warm"]!.costUsd).toBe(0.01);
});

it("prices one-hour writes as a subset without charging them twice", () => {
  const report = measureCalls(
    [
      {
        id: "one",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 100,
        cacheWrite1hTokens: 40,
      },
    ],
    { ...pricing, cacheWrite1h: 6 },
  );
  expect(report.costUsd).toBeCloseTo((60 * 3 + 40 * 6) / 1_000_000);
  expect(
    measureCalls(
      [{ id: "one", inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      pricing,
      100,
    ).cacheHitRate,
  ).toBeNull();
});

it("leaves known one-hour write charges unknown without their price", () => {
  expect(
    measureCalls(
      [
        {
          id: "one",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 100,
          cacheWrite1hTokens: 40,
        },
      ],
      pricing,
    ).costUsd,
  ).toBeNull();
});

it("blocks unpriced requested one-hour writes before reserving spend, using the applicable context tier", () => {
  const ordinary = new SpendBudget(5, pricing);
  expect(() => ordinary.reserve(10, 1, "1h")).toThrow("requested one-hour");
  expect(ordinary.reservedUsd).toBe(0);
  expect(ordinary.usedUsd).toBe(0);
  expect(ordinary.reserve(10, 1)).toBe("1");
  const tiered = new SpendBudget(5, {
    ...pricing,
    cacheWrite1h: 6,
    longContext: { ...pricing, thresholdTokens: 100 },
  });
  tiered.reserve(99, 1, "1h");
  expect(() => tiered.reserve(100, 1, "1h")).toThrow("requested one-hour");
  expect(tiered.reservedUsd).toBeCloseTo((99 * 6 + 2) / 1_000_000);
  const complete = new SpendBudget(5, {
    ...pricing,
    cacheWrite1h: 6,
    longContext: { ...pricing, thresholdTokens: 100, cacheWrite1h: 8 },
  });
  expect(complete.reserve(100, 1, "1h")).toBe("1");
  expect(complete.reservedUsd).toBeCloseTo((100 * 8 + 2) / 1_000_000);
});

it("reserves all reachable pricing tiers when a token upper bound crosses a cheaper long tier", () => {
  const tiered = {
    ...pricing,
    input: 10,
    output: 10,
    cacheRead: 10,
    cacheWrite: 10,
    longContext: { thresholdTokens: 100, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  };
  const budget = new SpendBudget(1, tiered);
  budget.reserve(100, 10);
  const actual = measureCalls(
    [{ id: "actual", inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    tiered,
  ).costUsd!;
  expect(budget.reservedUsd).toBeGreaterThanOrEqual(actual);
  const small = new SpendBudget(0.0005, tiered);
  expect(() => small.reserve(100, 10)).toThrow("cap");
  expect(small.reservedUsd).toBe(0);
});

it("retains spend and blocks further calls when observed one-hour writes lack their applicable tier price", () => {
  const tiered = {
    ...pricing,
    cacheWrite1h: 100,
    longContext: { ...pricing, thresholdTokens: 100 },
  };
  const budget = new SpendBudget(1, tiered);
  const id = budget.reserve(100, 10);
  const reserved = budget.reservedUsd;
  budget.settleUsage(id, {
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 100,
    totalTokens: 110,
  });
  expect(budget.usedUsd).toBe(reserved);
  expect(budget.reservedUsd).toBe(0);
  expect(() => budget.reserve(100, 10)).toThrow("no configured pricing");
  const base = new SpendBudget(1, tiered);
  const baseId = base.reserve(90, 10);
  base.settleUsage(baseId, {
    inputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 90,
    cacheWrite1hTokens: 90,
    totalTokens: 100,
  });
  expect(base.usedUsd).toBeCloseTo((90 * 100 + 10 * 2) / 1_000_000);
  expect(base.reserve(90, 10)).toBe("2");
  const unknown = new SpendBudget(1, tiered);
  const unknownId = unknown.reserve(100, 10);
  const unknownReserved = unknown.reservedUsd;
  unknown.settleUsage(unknownId, { cacheWrite1hTokens: 100 });
  expect(unknown.usedUsd).toBe(unknownReserved);
  expect(() => unknown.reserve(100, 10)).toThrow("no configured pricing");
});
