import { expect, it } from "vitest";
import type { LedgerCall } from "./step-accounting.js";
import { measureWorkflowSteps } from "./step-accounting.js";

const call = (id: string, fields: Partial<LedgerCall> = {}): LedgerCall => ({
  id,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 4,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  totalTokens: 16,
  costUsd: 0.01,
  costSource: "provider-reported",
  operation: "answer",
  ...fields,
});

it("partitions final durable usage by step, including delegated calls, without publishing identifiers", () => {
  const rows = [
    call("private-first", { runId: "private-run-one", operation: "setup" }),
    call("private-child", {
      runId: "private-child-run",
      parentRunId: "private-run-one",
      operation: "subagent",
    }),
    call("private-second", { runId: "private-run-two" }),
    call("private-summary", { runId: "private-run-one", operation: "compaction" }),
    call("private-unmapped", { runId: "private-unknown" }),
  ];
  const result = measureWorkflowSteps(
    rows,
    new Map([
      ["private-run-one", 1],
      ["private-run-two", 3],
    ]),
  );
  expect(result.steps.map((step) => [step.step, step.modelCalls, step.costUsd])).toEqual([
    [1, 2, 0.02],
    [3, 1, 0.01],
  ]);
  expect(result.background.compaction.modelCalls).toBe(1);
  expect(result.background.unattributed.modelCalls).toBe(1);
  expect(result.reconciliation).toMatchObject({
    allCallsAccounted: true,
    modelCalls: 5,
    costMatches: true,
    workflowCostUsd: 0.05,
  });
  expect(JSON.stringify(result)).not.toContain("private-");
});

it("deduplicates final records, preserves unknown incurred costs, and distinguishes empty steps", () => {
  const known = call("one", { runId: "run-one" });
  const result = measureWorkflowSteps(
    [known, known, call("unknown", { operation: "compaction", costUsd: null, costSource: null })],
    new Map([
      ["run-one", 1],
      ["run-empty", 2],
    ]),
  );
  expect(result.steps[0]!.modelCalls).toBe(1);
  expect(result.steps[1]).toMatchObject({ step: 2, modelCalls: 0, costUsd: null });
  expect(result.background.compaction.costUsd).toBeNull();
  expect(result.reconciliation).toMatchObject({
    allCallsAccounted: true,
    modelCalls: 2,
    workflowCostUsd: null,
    partitionCostUsd: null,
    costMatches: null,
  });
});

it("reconciles measured token buckets and keeps unavailable buckets unknown", () => {
  const result = measureWorkflowSteps(
    [
      call("first", { runId: "run", cacheReadTokens: null }),
      call("background", { operation: "compaction" }),
    ],
    new Map([["run", 1]]),
  );
  expect(result.reconciliation.tokenMatches.inputTokens).toBe(true);
  expect(result.reconciliation.tokenMatches.outputTokens).toBe(true);
  expect(result.reconciliation.tokenMatches.cacheReadTokens).toBeNull();
  expect(result.steps[0]!.cacheReadTokens).toBeNull();
  expect(result.background.compaction.cacheReadTokens).toBe(4);
});

it("lists a step's calls in the order they were made, so tool round trips can be told apart", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
  const result = measureWorkflowSteps(
    [
      call("later", { runId: "run", operation: "retrieval", outputTokens: 7, createdAt: at(2) }),
      call("first", { runId: "run", operation: "retrieval", outputTokens: 3, createdAt: at(1) }),
    ],
    new Map([["run", 1]]),
  );
  expect(
    result.steps[0]!.calls.map((c) => [c.ordered, c.operation, c.outputTokens, c.costUsd]),
  ).toEqual([
    [true, "retrieval", 3, 0.01],
    [true, "retrieval", 7, 0.01],
  ]);
});

it("marks calls recorded at the same time as unordered instead of naming one first", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
  const rows = [
    call("b", { runId: "run", outputTokens: 7, createdAt: at(1) }),
    call("c", { runId: "run", outputTokens: 9, createdAt: at(2) }),
    call("a", { runId: "run", outputTokens: 3, createdAt: at(1) }),
    call("d", { runId: "run", outputTokens: 1 }),
  ];
  const listed = (input: LedgerCall[]) =>
    measureWorkflowSteps(input, new Map([["run", 1]])).steps[0]!.calls.map((c) => [
      c.ordered,
      c.outputTokens,
    ]);
  // Tied and undated calls keep one fixed order whatever order the ledger returned them in.
  expect(listed(rows)).toEqual([
    [false, 1],
    [false, 3],
    [false, 7],
    [true, 9],
  ]);
  expect(listed([...rows].reverse())).toEqual(listed(rows));
});
