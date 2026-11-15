import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
} from "@rakazo/adapter-kit";
import type { CacheDecisionMeasurement, EvalPricing, MeasuredCall } from "./measurement.js";
import { measureCalls } from "./measurement.js";

/** Controlled prefix replay, not a retention-time test. No keepalive requests are issued. */
export async function runCachePrefixProbe(
  runtime: AgentRuntime,
  model: AgentRunModel,
  pricing: EvalPricing,
  decisions: readonly CacheDecisionMeasurement[] = [],
) {
  const experiment = randomUUID();
  const scope = {
    operationId: "synthetic-cache-probe",
    traceId: "synthetic-cache-probe",
    spaceId: experiment,
    userId: experiment,
  };
  const phases = [
    "fresh-prefix",
    "same-prefix-replay",
    "changed-prefix",
    "changed-prefix-replay",
  ] as const;
  const rows = [];
  for (const [index, phase] of phases.entries()) {
    const calls = new Map<string, MeasuredCall>();
    const firstDecision = decisions.length;
    const runId = randomUUID();
    const collect = (event: Parameters<NonNullable<AgentRunRequest["onUsage"]>>[0]) => {
      calls.set(event.callId ?? "single-probe-call", {
        id: event.callId ?? "single-probe-call",
        ...event,
        operation: event.operationKind ?? "setup",
      });
    };
    const started = Date.now();
    let failed = false;
    let firstResponseMs: number | null = null;
    const prefix =
      `Synthetic cache probe ${experiment} cohort ${index < 2 ? "A" : "B"}.\n` +
      Array.from(
        { length: 240 },
        (_, i) =>
          `Neutral synthetic observation ${i}: preserve the requested output; take no external actions.`,
      ).join("\n");
    const context: AdapterContext = { ...scope, signal: AbortSignal.timeout(60000) };
    try {
      for await (const event of runtime.run(
        {
          botId: experiment,
          threadId: experiment,
          runId,
          contextStrategy: "current",
          usageOperationKind: "setup",
          prompt: "Reply only PROBE-OK.",
          instructions: prefix,
          history: [],
          tools: [],
          model: { ...model, maxTokens: 256, thinkingLevel: "minimal" },
          onUsage: collect,
        },
        context,
      )) {
        if (event.type === "text" && firstResponseMs === null)
          firstResponseMs = Date.now() - started;
        if (event.type === "usage") collect(event);
      }
    } catch {
      failed = true;
    } finally {
      await runtime.abort(runId);
    }
    rows.push({
      phase,
      failed,
      latencyMs: Date.now() - started,
      firstResponseMs,
      cacheDecisions: decisions.slice(firstDecision),
      ...measureCalls([...calls.values()], pricing, model.cacheCapabilities?.minimumTokens),
    });
    if (failed) break; // Never continue after a failed reservation or incomplete provider call.
  }
  return {
    fixtureVersion: "cache-prefix-v1",
    modelLimits: { contextWindow: model.contextWindow ?? null, maxOutputTokens: 256 },
    retentionExperiment: false,
    cacheState:
      "Fresh random prefix then immediate identical replay; change prefix and replay again. Provider routing and cache state are not controlled.",
    phases: rows,
    modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
    costUsd:
      rows.length && rows.every((r) => r.costUsd !== null)
        ? rows.reduce((n, r) => n + r.costUsd!, 0)
        : null,
  };
}
