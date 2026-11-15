import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutoReviewProvider, ModelCallObserver } from "@rakazo/adapter-kit";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { ApprovalCaseResult } from "../evals/approval.js";
import {
  APPROVAL_CASES,
  APPROVAL_FIXTURE_VERSION,
  runApprovalCases,
  summarizeApproval,
} from "../evals/approval.js";
import type { EvalPricing, MeasuredCall } from "../evals/measurement.js";
import { SpendBudget, validatePricing } from "../evals/measurement.js";
import { redact } from "../evals/report.js";

type ApprovalValues = {
  live?: boolean;
  list?: boolean;
  case?: string[];
  trials?: string;
  connection?: string;
  provider?: string;
  model?: string;
  "api-key-env"?: string;
  "base-url"?: string;
  pricing?: string;
  "spend-cap-usd"?: string;
  "timeout-ms"?: string;
  output?: string;
};

/**
 * Live calibration of the Auto approval reviewer against reviewed cases. The reviewer is the
 * product's own adapter, selected from a model connection or the same env the product reads.
 */
export async function runApprovalSuite(
  values: ApprovalValues,
  meta: {
    codeRevision: string | null;
    workingDiffHash: string | null;
    readConnection: (file: string) => unknown;
  },
) {
  if (values.list) {
    for (const c of APPROVAL_CASES) console.log(`${c.id}: expected ${c.expected}`);
    return;
  }
  const selected = values.case?.length
    ? APPROVAL_CASES.filter((c) => values.case!.includes(c.id))
    : APPROVAL_CASES;
  if (!selected.length || values.case?.some((id) => !APPROVAL_CASES.some((c) => c.id === id)))
    throw new Error("Unknown eval case; use --list");
  const trials = Number(values.trials);
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10)
    throw new Error("Trials must be an integer from 1 to 10");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000)
    throw new Error("Timeout must be at least 1000ms");
  const output = path.resolve(values.output!);
  const results: ApprovalCaseResult[] = [];
  const report = {
    version: 1,
    kind: "approval-calibration-eval",
    startedAt: new Date().toISOString(),
    fixtureVersion: APPROVAL_FIXTURE_VERSION,
    rubricVersion: null as string | null,
    reviewer: null as null | { protocol: "decisions" | "llm"; provider: string; model: string },
    codeRevision: meta.codeRevision,
    workingDiffHash: meta.workingDiffHash,
    controls: { trials, timeoutMs },
    pricing: null as EvalPricing | null,
    spendCapUsd: Number(values["spend-cap-usd"]),
    status: "not-run" as "not-run" | "complete" | "stopped",
    reason: null as string | null,
    costSource:
      "Reviewer calls only. Provider reported charge when available, otherwise explicit pricing estimate; unknown stays null.",
    scoring:
      "Agreement is over every result. False-ask rate is over expected-pass results and false-pass rate over expected-ask results. Reviewer errors are unqualified, never passes.",
    limitations: [
      "Each case is a single reviewer call with no matching rules; executor routing, rule matching and Never ask/Ask modes are outside the fixture.",
      "Spend reservations are a guard, not a billing guarantee.",
    ],
    cases: selected.map((c) => c.id),
    results,
    summary: summarizeApproval(results),
  };
  const save = () => {
    report.summary = summarizeApproval(results);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  const notRun = (reason: string): never => {
    report.reason = reason;
    save();
    throw new Error(reason);
  };
  save();
  if (!values.live) notRun("Live reviewer execution requires --live; no case was run");
  loadRootEnv();

  // Direct source imports keep the adapters barrel, and its database client, out of this suite.
  const autoReview = await import("../../../adapters/src/auto-review.ts");
  const { decisionModel } = await import("../../../adapters/src/decision-models.ts");
  const { APPROVAL_DECISION_RUBRIC_VERSION } = await import(
    "../../../adapters/src/decision-auto-review.ts"
  );
  report.rubricVersion = APPROVAL_DECISION_RUBRIC_VERSION;

  let connection: {
    provider: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean;
  };
  if (values.connection || values.provider) {
    const parsed = ModelConnectInputSchema.safeParse(
      values.connection
        ? meta.readConnection(values.connection)
        : {
            provider: values.provider,
            modelId: values.model,
            apiKey: values["api-key-env"] ? process.env[values["api-key-env"]] : undefined,
            baseUrl: values["base-url"],
            label: "Approval reviewer",
          },
    );
    if (!parsed.success || !parsed.data.modelId?.trim())
      return notRun(
        "A valid reviewer connection is required: --connection with models/connect JSON, or --provider --model --api-key-env",
      );
    connection = { ...parsed.data, modelId: parsed.data.modelId, headers: parsed.data.headers };
  } else {
    // The same selection the product makes from RAKAZO_AUTO_REVIEW_* and the deployment model.
    const checker = autoReview.resolveAutoReviewChecker(process.env);
    const envKeys: Record<string, string | undefined> = {
      [autoReview.JEV_AUTO_REVIEW_PROVIDER]: autoReview.typesafeApiKey(process.env),
      openrouter: process.env.OPENROUTER_API_KEY?.trim(),
      anthropic: process.env.ANTHROPIC_API_KEY?.trim(),
    };
    if (!checker || checker.provider === autoReview.SCRIPTED_AUTO_REVIEW_PROVIDER)
      return notRun("No live approval reviewer is configured; pass --connection or set its env");
    const apiKey = envKeys[checker.provider];
    if (!apiKey)
      return notRun(
        "The configured approval reviewer has no key in env; pass --connection for other providers",
      );
    connection = { provider: checker.provider, modelId: checker.model, apiKey };
  }
  const catalog = decisionModel(connection.provider, connection.modelId);
  const isJev = connection.provider === autoReview.JEV_AUTO_REVIEW_PROVIDER;
  const protocol = catalog || isJev ? "decisions" : "llm";
  report.reviewer = { protocol, provider: connection.provider, model: connection.modelId };

  let pricing: EvalPricing;
  try {
    pricing = values.pricing
      ? validatePricing(JSON.parse(readFileSync(values.pricing, "utf8")))
      : validatePricing(
          catalog
            ? {
                source: "adapter decision model catalog",
                version: catalog.id,
                input: catalog.inputUsdPerMillion,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              }
            : null,
        );
  } catch {
    return notRun("Live execution requires --pricing with explicit USD per million rates");
  }
  report.pricing = pricing;
  const budget = new SpendBudget(report.spendCapUsd, pricing);
  const calls: MeasuredCall[] = [];
  const record = (usage: { callId?: string } & Omit<MeasuredCall, "id">) => {
    calls.push({ ...usage, id: usage.callId ?? randomUUID() });
  };
  const callObserver: ModelCallObserver = {
    beforeCall: (call) => {
      if (
        call.provider !== (isJev ? "typesafe" : connection.provider) ||
        call.modelId !== connection.modelId
      )
        throw new Error("Reviewer model has no configured pricing");
      return budget.reserve(
        call.inputTokensEstimate,
        call.maxOutputTokens,
        call.cacheWriteRetention,
      );
    },
    afterCall: (id, usage) => budget.settleUsage(id, usage),
  };
  const apiKey = connection.apiKey ?? "";
  let reviewer: AutoReviewProvider;
  try {
    if (isJev) {
      const { JevAutoReviewProvider } = await import("../../../adapters/src/jev-auto-review.ts");
      reviewer = new JevAutoReviewProvider({
        apiKey,
        model: connection.modelId,
        callObserver,
        onUsage: async (usage) => record(usage),
      });
    } else if (catalog) {
      const { HttpDecisionProvider } = await import("../../../adapters/src/http-decisions.ts");
      const { DecisionAutoReviewProvider } = await import(
        "../../../adapters/src/decision-auto-review.ts"
      );
      reviewer = new DecisionAutoReviewProvider({
        provider: new HttpDecisionProvider("openrouter", {
          apiKey,
          callObserver,
          onUsage: async (usage) => record(usage),
        }),
        providerId: connection.provider,
        model: connection.modelId,
      });
    } else {
      const { PiAgentRuntime } = await import("../../../adapters/src/pi-runtime.ts");
      reviewer = new autoReview.LlmAutoReviewProvider({
        runtime: new PiAgentRuntime({ modelCallObserver: callObserver }),
        checker: { provider: connection.provider, model: connection.modelId },
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        headers: connection.headers,
        // The operator runs evals against the model server they chose, often on loopback.
        allowPrivateEndpoint: true,
        contextWindow: connection.contextWindow ?? undefined,
        maxTokens: connection.maxTokens ?? undefined,
        reasoning: connection.reasoning,
        onUsage: async (usage) => record(usage),
        runId: "approval-eval",
        spaceId: "approval-eval-space",
        userId: "approval-eval-user",
        botId: "approval-eval-bot",
        threadId: "approval-eval-thread",
      });
    }
  } catch {
    return notRun("The approval reviewer could not be constructed from this connection");
  }

  const secrets = [apiKey, connection.baseUrl ?? ""];
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    await runApprovalCases(selected, reviewer, {
      trials,
      timeoutMs,
      pricing,
      drainCalls: () => calls.splice(0),
      shouldStop: () => stopRequested,
      onResult: (result) => {
        result.reason = result.reason === null ? null : redact(result.reason, secrets);
        results.push(result);
        save();
        console.log(
          `${result.caseId} trial ${result.trial}: expected ${result.expected}, got ${result.got} (${result.outcome}); ${result.latencyMs}ms`,
        );
      },
    });
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
  report.status = stopRequested ? "stopped" : "complete";
  save();
  const s = report.summary;
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  console.log(
    `agreement ${pct(s.agreementRate)}; false-ask ${pct(s.falseAskRate)}; false-pass ${pct(s.falsePassRate)}; unqualified ${s.unqualified}; reviewer cost ${s.costUsd === null ? "unknown" : `$${s.costUsd.toFixed(6)}`}`,
  );
  if (stopRequested || s.agreed !== s.results) process.exitCode = 1;
}
