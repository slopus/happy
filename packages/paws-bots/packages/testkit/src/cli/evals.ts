import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { ModelConnectInputSchema, ReplyModeSchema } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  APPS_EVAL_CASES,
  APPS_FIXTURE_VERSION,
  APPS_JUDGE_CALIBRATION,
  APPS_JUDGE_VERSION,
} from "../evals/apps.js";
import { BOT_FILES_EVAL_CASES, BOT_FILES_FIXTURE_VERSION } from "../evals/bot-files.js";
import type { EvalCase } from "../evals/cases.js";
import { EVAL_CASES, HISTORY_EVAL_CASES, wakesRoutines } from "../evals/cases.js";
import {
  DELIBERATION_EVAL_CASES,
  DELIBERATION_FIXTURE_VERSION,
  DELIBERATION_JUDGE_CALIBRATION,
  DELIBERATION_JUDGE_VERSION,
} from "../evals/deliberation.js";
import {
  caseFingerprint,
  caseKey,
  firstRequestFetch,
  runFingerprint,
} from "../evals/fingerprint.js";
import { regradeTrial } from "../evals/grading.js";
import {
  GROUP_EVAL_CASES,
  GROUP_FIXTURE_VERSION,
  GROUP_JUDGE_CALIBRATION,
  GROUP_JUDGE_VERSION,
} from "../evals/group.js";
import { GROUP_ROUTING_EVAL_CASES, GROUP_ROUTING_FIXTURE_VERSION } from "../evals/group-routing.js";
import { HISTORY_FIXTURE_VERSION } from "../evals/history-fixtures.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "../evals/history-observer.js";
import { observeSyntheticHistory } from "../evals/history-observer.js";
import {
  INITIATIVE_EVAL_CASES,
  INITIATIVE_FIXTURE_VERSION,
  INITIATIVE_JUDGE_CALIBRATION,
  INITIATIVE_JUDGE_VERSION,
} from "../evals/initiative.js";
import type { EvalJudge, JudgeInput } from "../evals/judge.js";
import { createEvalJudge } from "../evals/judge.js";
import type { CacheDecisionMeasurement, EvalPricing, MeasuredCall } from "../evals/measurement.js";
import { measureCalls, SpendBudget, validatePricing } from "../evals/measurement.js";
import {
  MEMORY_EVAL_CASES,
  MEMORY_FIXTURE_VERSION,
  MEMORY_JUDGE_CALIBRATION,
  MEMORY_JUDGE_VERSION,
} from "../evals/memory.js";
import {
  loadRecallCases,
  RECALL_EVAL_CASES,
  RECALL_FIXTURE_VERSION,
  RECALL_JUDGE_CALIBRATION,
  RECALL_JUDGE_VERSION,
} from "../evals/recall.js";
import type { TrialResult } from "../evals/report.js";
import { emptyTrial, redact, summarize, validateControls } from "../evals/report.js";
import type { CasePlan } from "../evals/run-store.js";
import { judgeIdentity, RunStore } from "../evals/run-store.js";
import {
  SILENCE_EVAL_CASES,
  SILENCE_FIXTURE_VERSION,
  SILENCE_JUDGE_CALIBRATION,
  SILENCE_JUDGE_VERSION,
} from "../evals/silence.js";
import type { ObservedToolCall, ObservedToolList } from "../evals/tool-calls.js";
import { loadToolChoiceCases, TOOL_CHOICE_FIXTURE_VERSION } from "../evals/tool-choice.js";
import { TOOL_CHOICE_CASES } from "../evals/tool-choice-cases.js";
import type { DiagnosticWireObservation } from "../evals/wire-observer.js";
import { diagnosticWireFetch } from "../evals/wire-observer.js";
import { runApprovalSuite } from "./approval-eval.js";
import type { DisposablePostgres } from "./postgres.js";
import { disposableDatabaseEnv, startPostgres } from "./postgres.js";

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "product" },
      strategy: { type: "string", multiple: true },
      pricing: { type: "string" },
      "cache-probe": { type: "boolean", default: false },
      "cache-capabilities": { type: "string" },
      "spend-cap-usd": { type: "string", default: "5" },
      live: { type: "boolean", default: false },
      "stop-on-failure": { type: "boolean", default: false },
      "wire-diagnostics": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      connection: { type: "string" },
      "judge-connection": { type: "string" },
      "judge-pricing": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      "base-url": { type: "string" },
      "context-window": { type: "string" },
      "max-output-tokens": { type: "string" },
      trials: { type: "string", default: "3" },
      case: { type: "string", multiple: true },
      "cases-file": { type: "string" },
      "timeout-ms": { type: "string", default: "180000" },
      "max-tool-calls": { type: "string", default: "30" },
      "reply-mode": { type: "string" },
      output: { type: "string", default: "test-report/evals/report.json" },
      /** A private folder of finished runs; reuses stored trials whose fingerprint matches. */
      store: { type: "string" },
      fresh: { type: "boolean", default: false },
      /** Adds an existing report file to the store, without running anything. */
      import: { type: "string" },
      label: { type: "string" },
    },
  });
  const storeDir = values.store ?? process.env.EVAL_RUN_STORE;
  const store = storeDir ? new RunStore(path.resolve(storeDir)) : undefined;
  if (values.import) {
    if (!store) throw new Error("--import needs --store or EVAL_RUN_STORE");
    const entry = store.save(JSON.parse(readFileSync(values.import, "utf8")), {
      label: values.label,
    });
    console.log(`Stored ${entry.legacy ? "legacy " : ""}run ${entry.fingerprint}`);
    return;
  }
  if (values.fresh && !store) throw new Error("--fresh only applies with --store");
  if (values["cases-file"] && values.suite !== "tool-choice" && values.suite !== "recall")
    throw new Error("--cases-file adds tool-choice or recall cases; use one of those suites");
  const replyMode = ReplyModeSchema.safeParse(values["reply-mode"] ?? "chat");
  if (!replyMode.success) throw new Error("Unknown reply mode; use chat or messages");
  if (values["reply-mode"] && values.suite === "approval")
    throw new Error("--reply-mode sets the trial's bots; the approval suite has none");
  if (values.suite === "approval")
    return runApprovalSuite(values, {
      codeRevision: codeRevision(),
      workingDiffHash: workingDiffHash(),
      readConnection,
    });
  const suites: Record<
    string,
    {
      cases: EvalCase[];
      fixtureVersion: string;
      judge?: { version: string; calibration: Array<{ input: JudgeInput; pass: boolean }> };
    }
  > = {
    product: { cases: EVAL_CASES, fixtureVersion: "product-v1" },
    history: { cases: HISTORY_EVAL_CASES, fixtureVersion: HISTORY_FIXTURE_VERSION },
    silence: {
      cases: SILENCE_EVAL_CASES,
      fixtureVersion: SILENCE_FIXTURE_VERSION,
      judge: { version: SILENCE_JUDGE_VERSION, calibration: SILENCE_JUDGE_CALIBRATION },
    },
    initiative: {
      cases: INITIATIVE_EVAL_CASES,
      fixtureVersion: INITIATIVE_FIXTURE_VERSION,
      judge: { version: INITIATIVE_JUDGE_VERSION, calibration: INITIATIVE_JUDGE_CALIBRATION },
    },
    memory: {
      cases: MEMORY_EVAL_CASES,
      fixtureVersion: MEMORY_FIXTURE_VERSION,
      judge: { version: MEMORY_JUDGE_VERSION, calibration: MEMORY_JUDGE_CALIBRATION },
    },
    recall: {
      cases: RECALL_EVAL_CASES,
      fixtureVersion: RECALL_FIXTURE_VERSION,
      judge: { version: RECALL_JUDGE_VERSION, calibration: RECALL_JUDGE_CALIBRATION },
    },
    deliberation: {
      cases: DELIBERATION_EVAL_CASES,
      fixtureVersion: DELIBERATION_FIXTURE_VERSION,
      judge: { version: DELIBERATION_JUDGE_VERSION, calibration: DELIBERATION_JUDGE_CALIBRATION },
    },
    group: {
      cases: GROUP_EVAL_CASES,
      fixtureVersion: GROUP_FIXTURE_VERSION,
      judge: { version: GROUP_JUDGE_VERSION, calibration: GROUP_JUDGE_CALIBRATION },
    },
    "group-routing": {
      cases: GROUP_ROUTING_EVAL_CASES,
      fixtureVersion: GROUP_ROUTING_FIXTURE_VERSION,
    },
    "tool-choice": { cases: TOOL_CHOICE_CASES, fixtureVersion: TOOL_CHOICE_FIXTURE_VERSION },
    "bot-files": { cases: BOT_FILES_EVAL_CASES, fixtureVersion: BOT_FILES_FIXTURE_VERSION },
    apps: {
      cases: APPS_EVAL_CASES,
      fixtureVersion: APPS_FIXTURE_VERSION,
      judge: { version: APPS_JUDGE_VERSION, calibration: APPS_JUDGE_CALIBRATION },
    },
  };
  if (!Object.hasOwn(suites, values.suite!))
    throw new Error(
      "Unknown suite; use product, history, group, group-routing, silence, initiative, deliberation, memory, recall, tool-choice, bot-files, apps, or approval",
    );
  const suite = suites[values.suite!]!;
  const suiteJudge = suite.judge;
  const extraCases = values["cases-file"]
    ? (values.suite === "recall" ? loadRecallCases : loadToolChoiceCases)(values["cases-file"])
    : [];
  const cases = [...suite.cases, ...extraCases];
  const fixtureVersion = extraCases.length
    ? `${suite.fixtureVersion}+${extraCases.length}-local`
    : suite.fixtureVersion;
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("Case ids must be unique across the suite and --cases-file");
  if (values["wire-diagnostics"] && values.suite !== "history")
    throw new Error("Synthetic wire diagnostics require the history suite");
  const strategies = [...new Set(values.strategy?.length ? values.strategy : ["current"])];
  if (
    strategies.some(
      (strategy) => !["current", "retrieval", "snapshots", "cache-aware"].includes(strategy),
    )
  )
    throw new Error("Unknown context strategy");
  if (values.list) {
    for (const scenario of cases) console.log(`${scenario.id}: ${scenario.purpose}`);
    return;
  }
  const controls = {
    trials: Number(values.trials),
    timeoutMs: Number(values["timeout-ms"]),
    maxToolCalls: Number(values["max-tool-calls"]),
  };
  validateControls(controls);
  const selected = values.case?.length ? cases.filter((c) => values.case!.includes(c.id)) : cases;
  if (!selected.length || values.case?.some((id) => !cases.some((c) => c.id === id)))
    throw new Error("Unknown eval case; use --list");
  const trials = selected
    .flatMap((c, caseIndex) =>
      Array.from({ length: controls.trials }, (_, i) =>
        strategies.map((_, position) => {
          const strategy = strategies[(position + caseIndex + i) % strategies.length]!;
          return { ...emptyTrial(c.id, i + 1), strategy };
        }),
      ),
    )
    .flat()
    // Only the current strategy compacts, so a compaction case under another one cannot run.
    .filter(
      (trial) =>
        trial.strategy === "current" ||
        !selected.find((c) => c.id === trial.caseId)?.history?.compact,
    );
  if (!trials.length)
    throw new Error("Compaction cases run only under the current strategy; add --strategy current");
  const output = path.resolve(values.output!);
  let budget: SpendBudget | undefined;
  let probeTotals: { costUsd: number | null; modelCalls: number } | undefined;
  const standIns: TrialResult[] = [];
  const judgeCalls = new Map<string, MeasuredCall>();
  const report = {
    version: 2,
    kind: "real-model-product-eval",
    suite: values.suite!,
    startedAt: new Date().toISOString(),
    model: values.model ?? process.env.PI_DEFAULT_MODEL ?? null,
    provider: values.provider ?? null,
    modelLimits: {
      contextWindow: values["context-window"] ? Number(values["context-window"]) : null,
      maxOutputTokens: values["max-output-tokens"] ? Number(values["max-output-tokens"]) : null,
    },
    controls,
    replyMode: replyMode.data,
    strategy: strategies.length === 1 ? strategies[0] : "comparison",
    strategies,
    executionOrder:
      "Rotate strategy order deterministically within each seeded case and trial; provider cache state is not controlled.",
    historyPreparation:
      values.suite === "history"
        ? "Short chats use originals. Larger ordinary cases use a synthetic prepared summary retaining common facts and omitting rare identifiers; backlog, failed-summary and oversized cases retain raw compaction stress."
        : null,
    fixtureVersion,
    caseFixtureVersions: Object.fromEntries(
      selected.map((c) => [c.id, c.history?.version ?? fixtureVersion]),
    ),
    codeRevision: codeRevision(),
    workingDiffHash: workingDiffHash(),
    /**
     * Per case and strategy: a hash of the first model request as sent (ids and dates
     * normalized), the model settings, the case's fixture version and data, and the trial
     * controls. The run's combines them. The judge is separate, so a new rubric regrades.
     */
    fingerprint: {
      run: null as string | null,
      cases: {} as Record<string, string | null>,
    },
    promptOrder: "stable guidance before changing context",
    pricing: null as EvalPricing | null,
    judge: null as null | {
      model: string;
      provider: string;
      rubricVersion: string;
      pricing: EvalPricing;
      calibration: Array<{ expected: boolean; pass: boolean; reason: string }>;
      modelCalls: number;
      costUsd: number | null;
    },
    spendCapUsd: Number(values["spend-cap-usd"]),
    workflowTotals: { modelCalls: 0, costUsd: null as number | null },
    guardAccounting: {
      settledUpperBoundUsd: null as number | null,
      reservedUsd: null as number | null,
    },
    costSource:
      "Per-call provider reported charge when available, otherwise explicit pricing estimate; unavailable remains null",
    firstResponseDefinition:
      "First persisted streamed text event after run creation, or final bot message if no text streamed; excludes activity/tool-only events. Polling does not define the timestamp.",
    fixtures: "synthetic services, messaging and fake sandbox",
    assistedRetries: false,
    limitations: [
      "Does not evaluate browser perception, native recording perception, or real external services.",
      "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
      "Silence replies and memory contents are graded by meaning with a calibrated LLM judge; other suites retain their existing task-specific graders.",
      "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.",
      "Tool trace contains names and statuses only; raw requests and responses are omitted. The tool-calls artifact keeps model-supplied arguments, with only configured secrets redacted.",
    ],
    trials,
    summary: summarize(trials),
  };
  const save = () => {
    report.fingerprint.run = runFingerprint(report.fingerprint.cases);
    report.summary = summarize(report.trials);
    if (report.judge) {
      const measured = measureCalls([...judgeCalls.values()], report.judge.pricing);
      report.judge.modelCalls = measured.modelCalls;
      report.judge.costUsd = measured.costUsd;
    }
    // Only new spend: trials taken from the store were paid for by the run that made them.
    // A stand-in run stopped for stored trials still paid for any call before its first turn;
    // the calls it stopped were refused before reaching the provider and cost nothing.
    const attempted = [
      ...trials.filter((trial) => trial.status !== "not-run" && !trial.origin),
      ...standIns.filter((trial) => (trial.costUsd ?? 0) > 0),
    ];
    const costs = [
      ...attempted.map((trial) => trial.costUsd),
      ...(probeTotals ? [probeTotals.costUsd] : []),
    ];
    report.workflowTotals = {
      modelCalls:
        attempted.reduce((n, trial) => n + trial.modelCalls, 0) + (probeTotals?.modelCalls ?? 0),
      costUsd:
        (costs.length || trials.some((trial) => trial.origin)) &&
        costs.every((cost) => cost !== null)
          ? costs.reduce<number>((n, cost) => n + cost!, 0)
          : null,
    };
    if (budget)
      report.guardAccounting = {
        settledUpperBoundUsd: budget.usedUsd,
        reservedUsd: budget.reservedUsd,
      };
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  save();
  const notRun = (reason: string): never => {
    for (const trial of trials) {
      trial.reason = reason;
      trial.category = "incomplete";
    }
    save();
    throw new Error(reason);
  };
  if (!values.live) notRun("Live model execution requires --live; report marks all trials not-run");
  loadRootEnv();
  const rawConnection: unknown = values.connection
    ? readConnection(values.connection)
    : {
        provider: values.provider,
        modelId: values.model ?? process.env.PI_DEFAULT_MODEL,
        apiKey: values["api-key-env"] ? process.env[values["api-key-env"]] : undefined,
        baseUrl: values["base-url"],
        cacheCapabilities: values["cache-capabilities"]
          ? readConnection(values["cache-capabilities"])
          : undefined,
        contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
        maxTokens: values["max-output-tokens"] ? Number(values["max-output-tokens"]) : undefined,
        label: "Eval model",
      };
  const parsedConnection = ModelConnectInputSchema.safeParse(rawConnection);
  if (!parsedConnection.success || !parsedConnection.data.modelId?.trim())
    return notRun(
      "A valid model connection is required: --connection with models/connect JSON, or --provider --model --api-key-env (and --base-url for compatible servers). All trials remain not-run.",
    );
  let pricing: EvalPricing;
  try {
    pricing = validatePricing(
      values.pricing ? JSON.parse(readFileSync(values.pricing, "utf8")) : null,
    );
  } catch {
    return notRun(
      "Live execution requires --pricing with explicit source, version and USD per million rates. All trials remain not-run.",
    );
  }
  report.pricing = pricing;
  budget = new SpendBudget(report.spendCapUsd, pricing);
  const liveBudget = budget;
  const connection = parsedConnection.data;
  report.model = connection.modelId!;
  report.provider = connection.provider;
  Object.assign(report, { cacheCapabilities: connection.cacheCapabilities ?? null });
  report.modelLimits = {
    contextWindow: connection.contextWindow ?? null,
    maxOutputTokens: connection.maxTokens ?? null,
  };
  let judge: EvalJudge | undefined;
  if (selected.some((c) => c.judge) && !values["cache-probe"]) {
    if (!suiteJudge) return notRun("This suite has no judge rubric; no inference was scheduled");
    if (!values["judge-connection"] || !values["judge-pricing"])
      return notRun(
        "Semantic cases require --judge-connection and --judge-pricing; no inference was scheduled",
      );
    let rawJudgeConnection: unknown;
    try {
      rawJudgeConnection = readConnection(values["judge-connection"]);
    } catch {
      return notRun("A valid judge model connection file is required; no inference was scheduled");
    }
    const parsedJudge = ModelConnectInputSchema.safeParse(rawJudgeConnection);
    if (!parsedJudge.success || !parsedJudge.data.modelId?.trim())
      return notRun("A valid judge model connection is required");
    const judgeConnection = parsedJudge.data;
    let judgePricing: EvalPricing;
    try {
      judgePricing = validatePricing(JSON.parse(readFileSync(values["judge-pricing"], "utf8")));
    } catch {
      return notRun(
        "A valid judge pricing file with explicit rates is required; no inference was scheduled",
      );
    }
    report.judge = {
      model: judgeConnection.modelId!,
      provider: judgeConnection.provider,
      rubricVersion: suiteJudge.version,
      pricing: judgePricing,
      calibration: [],
      modelCalls: 0,
      costUsd: null,
    };
    const { PiAgentRuntime } = await import("../../../adapters/src/pi-runtime.ts");
    const runtime = new PiAgentRuntime({
      modelCallObserver: {
        beforeCall: (call) => {
          if (
            call.provider !== judgeConnection.provider ||
            call.modelId !== judgeConnection.modelId
          )
            throw new Error("Judge model has no configured pricing");
          return liveBudget.reserve(
            call.inputTokensEstimate,
            call.maxOutputTokens,
            call.cacheWriteRetention,
            judgePricing,
          );
        },
        afterCall: (id, usage) => liveBudget.settleUsage(id, usage),
      },
    });
    const collect: NonNullable<AgentRunRequest["onUsage"]> = (usage) => {
      if (usage.callId) judgeCalls.set(usage.callId, { id: usage.callId, ...usage });
    };
    const rawJudge = createEvalJudge(
      runtime,
      {
        ...judgeConnection,
        id: judgeConnection.modelId!,
        allowPrivateEndpoint: true,
        maxImagesPerPrompt: judgeConnection.maxImagesPerPrompt ?? undefined,
        maxTokens: judgeConnection.maxTokens ?? 2048,
      },
      collect,
    );
    const judgeSecrets = [judgeConnection.apiKey ?? "", judgeConnection.baseUrl ?? ""];
    judge = async (input, signal) => {
      try {
        const verdict = await rawJudge(input, signal);
        return { ...verdict, reason: redact(verdict.reason, judgeSecrets) };
      } catch (error) {
        throw new Error(
          redact(error instanceof Error ? error.message : "Unknown judge failure", judgeSecrets),
        );
      }
    };
    try {
      for (const anchor of suiteJudge.calibration) {
        const verdict = await judge(anchor.input, AbortSignal.timeout(60_000));
        report.judge.calibration.push({
          expected: anchor.pass,
          pass: verdict.pass,
          reason: verdict.reason,
        });
        save();
        if (verdict.pass !== anchor.pass)
          throw new Error(
            "Judge disagreed with a calibration label; review the rubric before qualification",
          );
      }
    } catch (error) {
      return notRun(
        `Judge calibration failed: ${error instanceof Error ? error.message : "Unknown failure"}`,
      );
    }
  }
  save();
  if (values["cache-probe"]) {
    const { PiAgentRuntime } = await import("../../../adapters/src/pi-runtime.ts");
    const { runCachePrefixProbe } = await import("../evals/cache-probe.js");
    const decisions: CacheDecisionMeasurement[] = [];
    const runtime = new PiAgentRuntime({
      onContextDecision: (decision) => {
        const measured = measureCalls([{ id: "call", ...decision.usage }], pricing);
        decisions.push({
          predictedCache: decision.predictedCache,
          observedReuse: decision.observedReuse,
          estimatedInputTokens: decision.estimatedInputTokens,
          droppedMessages: decision.droppedMessages,
          truncatedToolResults: decision.truncatedToolResults,
          costUsd: measured.costUsd,
          cacheReadTokens: decision.usage.cacheReadTokens ?? null,
        });
      },
      modelCallObserver: {
        beforeCall: (call) => {
          if (call.provider !== connection.provider || call.modelId !== connection.modelId)
            throw new Error("Eval model has no configured pricing");
          return liveBudget.reserve(
            call.inputTokensEstimate,
            call.maxOutputTokens,
            call.cacheWriteRetention,
          );
        },
        afterCall: (id, usage) => liveBudget.settleUsage(id, usage),
      },
    });
    const probe = await runCachePrefixProbe(
      runtime,
      {
        ...connection,
        id: connection.modelId!,
        allowPrivateEndpoint: true,
        maxImagesPerPrompt: connection.maxImagesPerPrompt ?? undefined,
        maxTokens: connection.maxTokens ?? undefined,
      },
      pricing,
      decisions,
    );
    trials.length = 0;
    probeTotals = probe;
    Object.assign(report, {
      kind: "cache-prefix-probe",
      fixtureVersion: probe.fixtureVersion,
      caseFixtureVersions: {},
      modelLimits: probe.modelLimits,
      firstResponseDefinition:
        "First direct runtime text event after starting each probe call; no database or polling timestamps.",
      fixtures: "Direct synthetic prefixes; no database, service emulators, or tools.",
      limitations: [
        "Four direct synthetic model calls; does not evaluate product workflows, database persistence, or tools.",
        "Immediate replay measures observed warm versus fresh changed-prefix reuse; provider routing and eviction are uncontrolled, live expiry is not tested, and four calls are not a reliability estimate.",
        "Cost uses provider-reported charges where available and explicit pricing estimates otherwise; spend reservations are a guard, not a billing guarantee.",
      ],
      cacheProbe: probe,
    });
    for (const key of [
      "controls",
      "executionOrder",
      "historyPreparation",
      "promptOrder",
      "assistedRetries",
    ])
      Reflect.deleteProperty(report, key);
    save();
    if (probe.phases.some((phase) => phase.failed)) process.exitCode = 1;
    return;
  }
  // This CLI owns a disposable database. Never migrate or evaluate against an inherited database.
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-evals-"));
  let postgres: DisposablePostgres | undefined;
  let stopRequested = false;
  const stop = new AbortController();
  const requestStop = () => {
    stopRequested = true;
    stop.abort();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    const started = await startPostgres(stop.signal);
    postgres = started;
    const databaseUrl = started.getConnectionUri();
    Object.assign(process.env, {
      ...disposableDatabaseEnv(databaseUrl),
      WAKEUP_DRIVER: "memory",
      BETTER_AUTH_SECRET: "synthetic-eval-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "synthetic-eval-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "synthetic-eval-supervisor-token-at-least-32-characters",
      SCREEN_PROXY_SECRET: "synthetic-eval-screen-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      SANDBOX_PROVIDER: "fake",
      AGENT_RUNTIME: "pi",
      DATA_DIR: dataDir,
      MAX_TOOL_CALLS_PER_TURN: String(controls.maxToolCalls),
      WEB_PROVIDER: "fake",
      LOG_LEVEL: "error",
      COMPOSIO_API_KEY: "",
      PIPEDREAM_CLIENT_ID: "",
      PIPEDREAM_CLIENT_SECRET: "",
      PIPEDREAM_PROJECT_ID: "",
      SMTP_URL: "",
      BOT_EMAIL_SMTP_URL: "",
      EMAIL_PROVIDER: "none",
      EMAIL_API_KEY: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      WHATSAPP_ACCESS_TOKEN: "",
      LARK_APP_ID: "",
      SENDBLUE_API_KEY_ID: "",
      CURSOR_API_KEY: "",
      CLOUD_AGENT_PROVIDER: "",
      MODEL_API_KEY: "",
      // A developer .env with Stripe keys would put the disposable app behind billing.
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_ID: "",
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    // Import runtime modules only after generation; their barrel exports load Prisma.
    const { createApp } = await import("@rakazo/api/app");
    const { runTrial } = await import("../evals/runner.js");
    const { dispatcherFetch, PiAgentRuntime } = await import("@rakazo/adapters");
    const { EvalSandboxProvider } = await import("../evals/sandbox.js");
    const { observeToolCalls } = await import("../evals/tool-calls.js");
    type StoredPlan = Exclude<CasePlan, { kind: "run" }>;
    const plans = new Map<string, CasePlan>();
    const fromStore = async (
      plan: StoredPlan,
      trial: number,
      scenario: EvalCase,
    ): Promise<TrialResult> => {
      const source = plan.trials.find((t) => t.trial === trial)!;
      const origin = {
        kind: plan.kind === "reuse" ? ("reused" as const) : ("regraded" as const),
        fingerprint: plan.from.fingerprint,
        startedAt: plan.from.startedAt,
      };
      if (plan.kind === "regrade")
        return {
          ...(await regradeTrial(scenario, source, judge, controls.timeoutMs)),
          trial,
          origin,
        };
      // A trial reused again still names the run that paid for it.
      return {
        ...structuredClone(source),
        trial,
        origin: source.origin?.kind === "reused" ? source.origin : origin,
      };
    };
    for (let i = 0; i < trials.length; i++) {
      if (stopRequested) {
        for (const remaining of trials.slice(i))
          remaining.reason =
            "Not run because graceful stop was requested; the in-flight workflow drained before scheduling stopped";
        Object.assign(report, { termination: "graceful-stop-after-workflow" });
        save();
        process.exitCode = 130;
        break;
      }
      const planned = trials[i]!;
      const scenario = selected.find((c) => c.id === planned.caseId)!;
      const wireDiagnostics: DiagnosticWireObservation[] = [];
      const observeWire =
        values["wire-diagnostics"] &&
        (scenario.id === "history-1000-long-tool-loop" ||
          scenario.id === "history-10000-long-tool-loop");
      const key = caseKey(scenario.id, planned.strategy);
      const known = plans.get(key);
      // Set when this trial's first request matches a stored run: the run stops before it is sent.
      const stored: { plan?: StoredPlan } =
        known && known.kind !== "run" && known.trials.some((t) => t.trial === planned.trial)
          ? { plan: known }
          : {};
      const modelFetch = firstRequestFetch(
        observeWire
          ? diagnosticWireFetch(dispatcherFetch, connection.modelId!, wireDiagnostics)
          : dispatcherFetch,
        connection.modelId!,
        (body) => {
          const fingerprint = caseFingerprint({
            request: body,
            connection,
            caseVersion: report.caseFixtureVersions[scenario.id] ?? fixtureVersion,
            scenario,
            strategy: planned.strategy!,
            replyMode: replyMode.data,
            maxToolCalls: controls.maxToolCalls,
          });
          const seen = report.fingerprint.cases[key];
          // A case whose first request differs between trials has no stable fingerprint.
          report.fingerprint.cases[key] =
            seen === undefined || seen === fingerprint ? fingerprint : null;
          if (plans.has(key)) return true;
          const plan: CasePlan =
            store && !values.fresh
              ? store.plan({
                  scenario,
                  trials: controls.trials,
                  strategy: planned.strategy!,
                  fingerprint,
                  judge: judgeIdentity(report.judge),
                })
              : { kind: "run" };
          plans.set(key, plan);
          if (plan.kind === "run" || !plan.trials.some((t) => t.trial === planned.trial))
            return true;
          stored.plan = plan;
          return false;
        },
        scenario,
      );
      if (!stored.plan) {
        const ran = {
          ...(await runTrial(scenario, planned.trial, {
            ...controls,
            replyMode: replyMode.data,
            connection,
            pricing,
            judge,
            createApp: async (composio, messaging, witnesses) => {
              const sandbox = new EvalSandboxProvider(scenario.computer);
              let acceptingCalls = true;
              const cacheDecisions: CacheDecisionMeasurement[] = [];
              const runtime = new PiAgentRuntime({
                modelFetch,
                onContextDecision: (decision) => {
                  const measured = measureCalls([{ id: "call", ...decision.usage }], pricing);
                  cacheDecisions.push({
                    predictedCache: decision.predictedCache,
                    observedReuse: decision.observedReuse,
                    estimatedInputTokens: decision.estimatedInputTokens,
                    droppedMessages: decision.droppedMessages,
                    truncatedToolResults: decision.truncatedToolResults,
                    costUsd: measured.costUsd,
                    cacheReadTokens: decision.usage.cacheReadTokens ?? null,
                  });
                },
                modelCallObserver: {
                  // Other models the product calls, such as the Auto Review checker, run too, but
                  // only ever at their own pricing: the eval model's rates would undercharge them
                  // whenever their provider reports no cost.
                  beforeCall: ({
                    inputTokensEstimate,
                    maxOutputTokens,
                    provider,
                    modelId,
                    cacheWriteRetention,
                    maxCostUsd,
                  }) => {
                    if (!acceptingCalls) throw new Error("Eval trial stopped scheduling inference");
                    if (provider === connection.provider && modelId === connection.modelId)
                      return liveBudget.reserve(
                        inputTokensEstimate,
                        maxOutputTokens,
                        cacheWriteRetention,
                      );
                    if (typeof maxCostUsd !== "number")
                      throw new Error("Other model has no configured pricing");
                    return liveBudget.reserveCostBound(maxCostUsd);
                  },
                  afterCall: (id, usage) => liveBudget.settleUsage(id, usage),
                },
              });
              const historyDiagnostics: HistoryDiagnostic[] = [];
              const toolLoopDiagnostics: DiagnosticToolObservation[] = [];
              const observedRuntime = observeSyntheticHistory(
                runtime,
                historyDiagnostics,
                [connection.apiKey ?? "", connection.baseUrl ?? ""],
                toolLoopDiagnostics,
              );
              const toolCallObservations: ObservedToolCall[] = [];
              const toolLists: ObservedToolList[] = [];
              const handles = await createApp({
                runtime: observeToolCalls(observedRuntime, toolCallObservations, toolLists),
                contextStrategy: planned.strategy as
                  | "current"
                  | "retrieval"
                  | "snapshots"
                  | "cache-aware",
                sandbox,
                databaseUrl,
                realtimeDatabaseUrl: databaseUrl,
                dataDir: path.join(dataDir, `${scenario.id}-${planned.strategy}-${planned.trial}`),
                sandboxProvider: "fake",
                agentRuntime: "pi",
                wakeupDriver: "memory",
                composio,
                messaging,
                ...(wakesRoutines(scenario) ? witnesses : {}),
                messagingOpenSignup: false,
                defaultProvider: connection.provider,
                defaultModel: connection.modelId!,
                deploymentModelKey: undefined,
                composioApiKey: undefined,
                cursorApiKey: undefined,
                cloudAgentProvider: "none",
                signupsEnabled: "true",
                signupAllowlist: "",
                // The operator runs evals against the model server they chose, often on loopback.
                mcpAllowPrivateEndpoint: true,
                emailEmulator: true,
                pipedreamClientId: undefined,
                pipedreamClientSecret: undefined,
                pipedreamProjectId: undefined,
                smtpUrl: undefined,
                emailProvider: "none",
                emailApiKey: undefined,
                emailFrom: undefined,
                sendblueApiKeyId: undefined,
                sendblueApiSecret: undefined,
                slackBotToken: undefined,
                whatsappAccessToken: undefined,
                telegramBotToken: undefined,
                larkAppId: undefined,
                mcpStdioEnabled: false,
                mcpStdioAllowedCommands: [],
              });
              return {
                ...handles,
                harnessIssues: sandbox.harnessIssues,
                cacheDecisions,
                historyDiagnostics,
                toolLoopDiagnostics,
                toolCallObservations,
                toolLists,
                finalizeBackground: async () => {
                  acceptingCalls = false;
                  await handles.jobs.close();
                },
                stop: async () => {
                  acceptingCalls = false;
                  await handles.stop();
                },
                awaitIdle: async () => {
                  if (!handles.awaitIdle) throw new Error("Eval queue cannot await idle");
                  await handles.awaitIdle();
                },
              };
            },
          })),
          strategy: planned.strategy,
          ...(observeWire ? { wireDiagnostics } : {}),
        };
        // A stand-in whose cleanup failed is kept, so the checks below stop the run.
        if (!stored.plan || ran.cleanupFailed) {
          trials[i] = ran;
          stored.plan = undefined;
        } else standIns.push(ran);
      }
      if (stored.plan)
        trials[i] = {
          ...(await fromStore(stored.plan, planned.trial, scenario)),
          strategy: planned.strategy,
        };
      save();
      const result = trials[i]!;
      console.log(
        `${result.caseId} ${result.strategy} trial ${result.trial}: ${result.origin ? `${result.origin.kind} ` : ""}${result.status}${result.category ? ` (${result.category})` : ""}; ${result.toolCalls} tool calls; ${result.latencyMs}ms`,
      );
      if (values["stop-on-failure"] && result.status === "failed") {
        for (const remaining of trials.slice(i + 1))
          remaining.reason = "Not run because stop-on-failure ended the bounded diagnostic";
        save();
        process.exitCode = 1;
        break;
      }
      if (result.cleanupFailed || /spend cap|no configured pricing/i.test(result.reason ?? "")) {
        for (const remaining of trials.slice(i + 1))
          remaining.reason = result.cleanupFailed
            ? "Not run because fixture cleanup failed"
            : "Not run because the shared comparison spend cap or pricing guard stopped scheduling";
        save();
        process.exitCode = 1;
        break;
      }
    }
    if (trials.some((r) => r.status !== "passed")) process.exitCode = 1;
    if (store) {
      const fresh = trials.filter((t) => t.status !== "not-run" && t.origin?.kind !== "reused");
      if (fresh.length) {
        const entry = store.save(report);
        console.log(`Stored run ${entry.fingerprint} (${entry.path})`);
      } else console.log("Every trial came from the store; nothing new to save");
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    try {
      await postgres?.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

function workingDiffHash(): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const options = {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    };
    const hash = createHash("sha256").update(execFileSync("git", ["diff", "HEAD"], options));
    const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      ...options,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => /\.(?:ts|tsx|json)$/.test(p) && /^(?:packages|apps)\//.test(p))
      .sort();
    for (const file of added) hash.update(file).update(readFileSync(path.join(root, file)));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function codeRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readConnection(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Parser and filesystem errors may include private file contents or paths.
    throw new Error(
      "Could not read model connection JSON. Check that the file is readable and contains valid JSON. All trials remain not-run.",
    );
  }
}

main().catch((error: unknown) => {
  // Never dump process env, subprocess output, connection JSON, or error stacks into public CI logs.
  console.error(
    redact(
      error instanceof Error ? error.message.split("\n")[0]! : "Eval runner failed",
      Object.entries(process.env)
        .filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD/.test(key))
        .map(([, value]) => value ?? ""),
    ),
  );
  process.exitCode = 1;
});
