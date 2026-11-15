import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { runCachePrefixProbe } from "./cache-probe.js";

it("replays exact prefixes and changes them without inferring a retention deadline", async () => {
  const instructions: string[] = [];
  const abort = vi.fn(async () => {});
  const runtime = {
    abort,
    describe: vi.fn(),
    async *run(request: AgentRunRequest) {
      instructions.push(request.instructions);
      const usage = {
        type: "usage" as const,
        provider: "fixture",
        model: "fixture",
        callId: "single",
        operationKind: request.usageOperationKind,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 110,
      };
      await request.onUsage?.(usage);
      yield { type: "text" as const, text: "PROBE-OK" };
      yield usage;
    },
  } as AgentRuntime;
  const report = await runCachePrefixProbe(
    runtime,
    { provider: "fixture", id: "fixture" },
    { source: "fixture", version: "v1", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 },
  );
  expect(report.modelCalls).toBe(4); // Producer sink and consumer stream do not double count.
  expect(instructions[0]).toBe(instructions[1]);
  expect(instructions[2]).toBe(instructions[3]);
  expect(instructions[0]).not.toBe(instructions[2]);
  expect(report.retentionExperiment).toBe(false);
  expect(report.costUsd).toBeCloseTo(0.00048);
  for (const phase of report.phases) {
    expect(phase.operationCosts.setup).toBe(phase.costUsd);
    expect(phase.operationCosts.answer).toBe(0);
    expect(phase.modelCalls).toBe(1);
  }
  expect(abort).toHaveBeenCalledTimes(4);
});
