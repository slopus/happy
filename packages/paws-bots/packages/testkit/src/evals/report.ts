import type { Criterion } from "./cases.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "./history-observer.js";
import type { Judgment } from "./judge.js";
import type { CacheDecisionMeasurement, Operation } from "./measurement.js";
import { OPERATION_KINDS, summarizeCacheDecisions } from "./measurement.js";
import type { measureWorkflowSteps } from "./step-accounting.js";
import type { DiagnosticWireObservation } from "./wire-observer.js";

export type FailureCategory = "agent" | "product" | "provider" | "harness" | "incomplete";
export type TrialResult = {
  caseId: string;
  trial: number;
  strategy?: string;
  stepAccounting?: ReturnType<typeof measureWorkflowSteps>;
  cacheDecisions?: CacheDecisionMeasurement[];
  historyDiagnostics?: HistoryDiagnostic[];
  toolLoopDiagnostics?: DiagnosticToolObservation[];
  wireDiagnostics?: DiagnosticWireObservation[];
  /** Largest tool list offered on a run's first model call. */
  offeredTools?: { count: number; bytes: number };
  backgroundFailures?: Record<string, number>;
  historyPreparationState?: {
    beforeCursor: number | null;
    afterCursor: number | null;
    remainingMessages: number;
    summaryPresent: boolean;
    /** The compaction summary the run read, synthetic like the fixture it came from. */
    summary?: string | null;
    generation: number;
  };
  status: "passed" | "failed" | "not-run";
  category: FailureCategory | null;
  reason: string | null;
  criteria: Criterion[];
  judgment?: Judgment;
  /** What the trial was graded on, so a new rubric can grade it again without running the bot. */
  evidence?: unknown;
  /** What the offline sandbox could not do in the trial; a regrade weighs a failure as the run did. */
  harnessIssues?: string[];
  /** Whether this run ran the trial, or took it from a stored run with the same fingerprint. */
  origin?: { kind: "reused" | "regraded"; fingerprint: string; startedAt: string };
  /** Recorded behaviour; `present` is null when the judge could not grade it. */
  observations?: Record<string, { present: boolean | null; reason?: string }>;
  assisted: false;
  cleanupFailed: boolean;
  latencyMs: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costSources: string[];
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  modelCalls: number;
  cacheHitRate: number | null;
  firstResponseMs: number | null;
  operationCosts: Record<Operation, number | null>;
  trace: Array<{ step: number; status: string; tools: string[] }>;
  artifacts: Record<string, string | null>;
};

export function summarize(results: readonly TrialResult[]) {
  return [...new Set(results.map((r) => JSON.stringify([r.caseId, r.strategy])))].map((key) => {
    const [caseId, strategy] = JSON.parse(key) as [string, string | undefined];
    const trials = results.filter(
      (r) => r.caseId === caseId && (r.strategy ?? null) === (strategy ?? null),
    );
    const attempted = trials.filter((r) => r.status !== "not-run");
    const passed = trials.filter((r) => r.status === "passed").length;
    return {
      caseId,
      ...(strategy ? { strategy } : {}),
      cacheTelemetry: summarizeCacheDecisions(
        attempted.flatMap((r) => r.cacheDecisions ?? []),
        attempted.reduce((n, r) => n + r.modelCalls, 0),
      ),
      modelCalls: attempted.reduce((n, r) => n + r.modelCalls, 0),
      costSources: [...new Set(attempted.flatMap((r) => r.costSources ?? []))],
      costUsd:
        attempted.length && attempted.every((r) => r.costUsd !== null)
          ? attempted.reduce((n, r) => n + r.costUsd!, 0)
          : null,
      inputTokens:
        attempted.length && attempted.every((r) => r.inputTokens !== null)
          ? attempted.reduce((n, r) => n + r.inputTokens!, 0)
          : null,
      outputTokens:
        attempted.length && attempted.every((r) => r.outputTokens !== null)
          ? attempted.reduce((n, r) => n + r.outputTokens!, 0)
          : null,
      cacheReadTokens: sumMeasured(attempted, "cacheReadTokens"),
      cacheWriteTokens: sumMeasured(attempted, "cacheWriteTokens"),
      cacheWrite1hTokens: sumMeasured(attempted, "cacheWrite1hTokens"),
      reasoningTokens: sumMeasured(attempted, "reasoningTokens"),
      totalTokens: sumMeasured(attempted, "totalTokens"),
      meanFirstResponseMs:
        attempted.length && attempted.every((r) => r.firstResponseMs !== null)
          ? attempted.reduce((n, r) => n + r.firstResponseMs!, 0) / attempted.length
          : null,
      latencyP50Ms: percentile(
        attempted.map((r) => r.latencyMs),
        0.5,
      ),
      latencyP95Ms: percentile(
        attempted.map((r) => r.latencyMs),
        0.95,
      ),
      operationCosts: Object.fromEntries(
        OPERATION_KINDS.map((kind) => {
          const values = attempted.map((r) => r.operationCosts[kind]);
          return [
            kind,
            values.length && values.every((v) => v !== null)
              ? values.reduce<number>((n, v) => n + v!, 0)
              : null,
          ];
        }),
      ),
      planned: trials.length,
      attempted: attempted.length,
      /** Trials this run ran, took unchanged from the store, or took and graded again. */
      origin: {
        run: attempted.filter((r) => !r.origin).length,
        reused: attempted.filter((r) => r.origin?.kind === "reused").length,
        regraded: attempted.filter((r) => r.origin?.kind === "regraded").length,
      },
      passed,
      failed: trials.filter((r) => r.status === "failed").length,
      notRun: trials.filter((r) => r.status === "not-run").length,
      firstAttemptPassed: trials.find((r) => r.trial === 1)?.status === "passed",
      autonomousSuccessRate: attempted.length ? passed / attempted.length : null,
      meanLatencyMs: attempted.length
        ? Math.round(attempted.reduce((n, r) => n + r.latencyMs, 0) / attempted.length)
        : null,
    };
  });
}

/** Domains reserved for examples (RFC 2606) can only hold fixture data, so they stay readable. */
const RESERVED_DOMAIN = /(?:^|[.@])example(?:\.(?:com|net|org))?$/i;
/** Keeps a fixture link's scheme, host and path; its query and fragment could carry anything. */
function fixtureUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!RESERVED_DOMAIN.test(parsed.hostname) || parsed.username || parsed.password) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Report content comes from synthetic fixtures, but model output is still untrusted. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(secret, "[redacted]");
  return safe
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, (url) => fixtureUrl(url) ?? "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (email) =>
      RESERVED_DOMAIN.test(email) ? email : "[email]",
    )
    .replace(/(?:\/Users\/|\/home\/)[^\s"']+/g, "[local-path]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:bearer|basic|token)\s+)?[^\s"',;&]+)/gi,
      "$1[redacted]",
    );
}

/**
 * What a trial was graded on, as JSON. Configured secrets and credential-shaped tokens are removed;
 * synthetic fixture paths, links and addresses stay, because a regrade must see what the live grade
 * saw (recall checks rerun recorded commands against fixture paths). Maps and Sets (an app's
 * drafts) are tagged so `restoreEvidence` gives judges the same shapes back.
 */
export function evidenceSnapshot(value: unknown, secrets: readonly string[]): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v,
    ),
    (_, v) => (typeof v === "string" ? withoutCredentials(v, secrets) : v),
  );
}

function withoutCredentials(text: string, secrets: readonly string[]) {
  let safe = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(secret, "[redacted]");
  return safe.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]");
}

export function restoreEvidence(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, v) =>
    v && typeof v === "object" && Array.isArray(v.$map)
      ? new Map(v.$map)
      : v && typeof v === "object" && Array.isArray(v.$set)
        ? new Set(v.$set)
        : v,
  );
}

export function emptyTrial(caseId: string, trial: number): TrialResult {
  return {
    caseId,
    trial,
    status: "not-run",
    category: "incomplete",
    reason: "Not started",
    criteria: [],
    assisted: false,
    cleanupFailed: false,
    latencyMs: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costSources: [],
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    modelCalls: 0,
    cacheHitRate: null,
    firstResponseMs: null,
    operationCosts: {
      answer: null,
      setup: null,
      retrieval: null,
      subagent: null,
      compaction: null,
    },
    trace: [],
    artifacts: {},
  };
}

export function validateControls(input: {
  trials: number;
  timeoutMs: number;
  maxToolCalls: number;
}) {
  for (const [name, value, max] of [
    ["trials", input.trials, 20],
    ["timeoutMs", input.timeoutMs, 900_000],
    ["maxToolCalls", input.maxToolCalls, 100],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function sumMeasured(
  rows: readonly TrialResult[],
  key:
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "cacheWrite1hTokens"
    | "reasoningTokens"
    | "totalTokens",
) {
  return rows.length && rows.every((r) => r[key] !== null)
    ? rows.reduce((n, r) => n + r[key]!, 0)
    : null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * p) - 1)]!;
}
