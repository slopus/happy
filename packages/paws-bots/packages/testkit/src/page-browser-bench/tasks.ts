import type { BrowserActStep, PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";
import {
  browserResultForModel,
  serializeToolResult,
  TOOL_RESULT_TEXT_LIMIT,
} from "@rakazo/adapters";

/** The site under test and a second site for cross-site frames, both served inside the computer. */
export const SITE = "https://localhost:8443";
export const PARTNER_SITE = "https://127.0.0.1:8444";

/**
 * A step's target, found by name (and role, when the name alone is ambiguous) in the latest page.
 * Only a name's first line counts: some drivers name a select after its options too.
 */
type Target = { name: string; role?: string };
type ActSpec =
  | { kind: "click"; target: Target }
  | { kind: "fill" | "type"; target: Target; text: string; field?: "username" | "password" }
  | { kind: "card"; cardField: "number" | "expiry" | "cvc" | "postal_code"; text: string };

export type ScriptStep =
  | { navigate: string }
  | { snapshot: true }
  /**
   * Snapshot again until the target shows up, as a model waiting on a slow page would, or with a
   * query, as one looking for a control the snapshot left out would.
   */
  | { until: Target; tries: number; query?: string }
  | { wait: number }
  /**
   * `staleRefs` acts on refs from the first page this task saw, not the latest. An `optional` step is
   * skipped when its target is gone, as after a stale click that already went through.
   */
  | { act: ActSpec[]; staleRefs?: boolean; optional?: boolean };

export type Expect = { submitted: Record<string, string> } | { url: string };

export type BenchTask = { id: string; covers: string; steps: ScriptStep[]; expect: Expect };

export const TASKS: BenchTask[] = [
  {
    id: "link",
    covers: "follow a link (URL check)",
    steps: [{ navigate: "/index.html" }, { act: [{ kind: "click", target: { name: "Pricing" } }] }],
    expect: { url: "/pricing.html" },
  },
  {
    id: "form",
    covers: "text, email and textarea fields",
    steps: [
      { navigate: "/form.html" },
      {
        act: [
          { kind: "fill", target: { name: "Full name" }, text: "Ada Lovelace" },
          { kind: "fill", target: { name: "Email" }, text: "ada@example.test" },
          { kind: "fill", target: { name: "Message" }, text: "Please call me back." },
          { kind: "click", target: { name: "Send message" } },
        ],
      },
    ],
    expect: {
      submitted: {
        name: "Ada Lovelace",
        email: "ada@example.test",
        message: "Please call me back.",
      },
    },
  },
  {
    id: "dropdown",
    covers: "native select",
    steps: [
      { navigate: "/dropdown.html" },
      {
        act: [
          { kind: "fill", target: { name: "Country" }, text: "Canada" },
          { kind: "click", target: { name: "Save country" } },
        ],
      },
    ],
    expect: { submitted: { country: "ca" } },
  },
  {
    id: "checkbox",
    covers: "checkbox",
    steps: [
      { navigate: "/checkbox.html" },
      {
        act: [
          { kind: "click", target: { name: "Send me the newsletter" } },
          { kind: "click", target: { name: "Save preferences" } },
        ],
      },
    ],
    expect: { submitted: { newsletter: "yes" } },
  },
  {
    id: "frame-same-site",
    covers: "same-site iframe",
    steps: [
      { navigate: "/frames.html" },
      { until: { name: "Local code" }, tries: 2 },
      {
        act: [
          { kind: "fill", target: { name: "Local code" }, text: "L-100" },
          { kind: "click", target: { name: "Save local code" } },
        ],
      },
    ],
    expect: { submitted: { code: "L-100" } },
  },
  {
    id: "frame-cross-site",
    covers: "cross-site iframe",
    steps: [
      { navigate: "/frames.html" },
      { until: { name: "Partner code" }, tries: 2 },
      {
        act: [
          { kind: "fill", target: { name: "Partner code" }, text: "P-200" },
          { kind: "click", target: { name: "Save partner code" } },
        ],
      },
    ],
    expect: { submitted: { code: "P-200" } },
  },
  {
    id: "below-fold",
    covers: "controls 4000px below the fold",
    steps: [
      { navigate: "/below-fold.html" },
      {
        act: [
          { kind: "fill", target: { name: "Promo code" }, text: "SPRING" },
          { kind: "click", target: { name: "Apply promo" } },
        ],
      },
    ],
    expect: { submitted: { promo: "SPRING" } },
  },
  {
    id: "long-page",
    covers: "snapshot query on a page with 660 controls and the form last",
    steps: [
      { navigate: "/long.html" },
      { until: { name: "Newsletter email" }, tries: 1, query: "newsletter" },
      {
        act: [
          { kind: "fill", target: { name: "Newsletter email" }, text: "reader@example.test" },
          { kind: "click", target: { name: "Subscribe" } },
        ],
      },
    ],
    expect: { submitted: { email: "reader@example.test" } },
  },
  {
    id: "stale-refs",
    covers: "page replaces its form after load",
    steps: [
      { navigate: "/stale.html" },
      { wait: 1500 },
      { act: [{ kind: "click", target: { name: "Continue" } }], staleRefs: true },
      { act: [{ kind: "click", target: { name: "Continue" } }], optional: true },
    ],
    expect: { submitted: { version: "2" } },
  },
  {
    id: "slow-load",
    covers: "HTML and its data each arrive 2s late",
    steps: [
      { navigate: "/slow.html" },
      { until: { name: "Order number" }, tries: 4 },
      {
        act: [
          { kind: "fill", target: { name: "Order number" }, text: "A-123" },
          { kind: "click", target: { name: "Track order" } },
        ],
      },
    ],
    expect: { submitted: { order: "A-123" } },
  },
  {
    id: "search",
    covers: "suggestions 300 ms after typing stops, then 200 ms to answer",
    steps: [
      { navigate: "/search.html" },
      { act: [{ kind: "type", target: { name: "Search countries" }, text: "Can" }] },
      { act: [{ kind: "click", target: { name: "Canada" } }] },
    ],
    expect: { submitted: { country: "ca" } },
  },
  {
    id: "login",
    covers: "saved login fill bound to the site",
    steps: [
      { navigate: "/login.html" },
      {
        act: [
          { kind: "fill", target: { name: "Username" }, text: "ada", field: "username" },
          {
            kind: "fill",
            target: { name: "Password" },
            text: "fake-password-1",
            field: "password",
          },
          { kind: "click", target: { name: "Sign in", role: "button" } },
        ],
      },
    ],
    expect: { submitted: { username: "ada", password: "fake-password-1" } },
  },
  {
    id: "card",
    covers: "card fill by card field, without refs",
    steps: [
      { navigate: "/card.html" },
      {
        act: [
          { kind: "card", cardField: "number", text: "4242424242424242" },
          { kind: "card", cardField: "expiry", text: "12/34" },
          { kind: "card", cardField: "cvc", text: "123" },
          { kind: "card", cardField: "postal_code", text: "94110" },
          { kind: "click", target: { name: "Pay now" } },
        ],
      },
    ],
    expect: {
      // The driver types an expiry's digits only and leaves the formatting to the field.
      submitted: { number: "4242424242424242", expiry: "1234", cvc: "123", postal: "94110" },
    },
  },
];

/** Opt-in public pages, measured for snapshot size and latency only. */
export const LIVE_SITES = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://news.ycombinator.com/",
  "https://github.com/microsoft/playwright",
];

export type RunDriver = (command: PageBrowserCommand) => Promise<PageBrowserResult>;

/** What the model reads of a result: its length after the runtime shortens it, and whether it did. */
export function modelSize(result: PageBrowserResult): Pick<StepRecord, "modelChars" | "clipped"> {
  const length = modelText(result).length;
  if (length <= TOOL_RESULT_TEXT_LIMIT) return { modelChars: length };
  const view = browserResultForModel(result);
  const sent =
    view && typeof view === "object" && "kind" in view
      ? TOOL_RESULT_TEXT_LIMIT
      : serializeToolResult(view, undefined, "browser_snapshot", {}).length;
  return { modelChars: Math.min(sent, TOOL_RESULT_TEXT_LIMIT), clipped: true };
}

export type StepRecord = {
  command: PageBrowserCommand["command"] | "wait";
  ms: number;
  ok: boolean;
  /** Characters of the tool result as the model reads it, after the runtime shortens it. */
  modelChars: number;
  /** The result was longer than the runtime sends, so the model saw it shortened. */
  clipped?: boolean;
  elements?: number;
  loading?: boolean;
  fallback?: boolean;
  uncertain?: boolean;
  error?: string;
};

export type TaskRecord = {
  id: string;
  success: boolean;
  /** Why the task failed, in the harness's words (never the driver's). */
  failure?: string;
  steps: StepRecord[];
};

/** A rough count for comparing drivers, not a tokenizer: about four characters per token. */
export function estimateTokens(chars: number) {
  return Math.ceil(chars / 4);
}

export function modelText(result: PageBrowserResult) {
  const view = browserResultForModel(result);
  if (view && typeof view === "object" && "kind" in view && view.kind === "agent_tool_result") {
    const part = view.content[0];
    return part?.type === "text" ? part.text : "";
  }
  return JSON.stringify(view);
}

function findRef(result: PageBrowserResult | undefined, target: Target) {
  const wanted = target.name.toLowerCase();
  return result?.elements?.find(
    (element) =>
      (element.name.split("\n")[0] ?? "").trim().toLowerCase() === wanted &&
      (!target.role || element.role === target.role),
  )?.ref;
}

function actSteps(
  specs: ActSpec[],
  page: PageBrowserResult | undefined,
): BrowserActStep[] | string {
  const steps: BrowserActStep[] = [];
  for (const spec of specs) {
    if (spec.kind === "card") {
      steps.push({
        kind: "fill",
        text: spec.text,
        origin: SITE,
        field: "card",
        cardField: spec.cardField,
      });
      continue;
    }
    const ref = findRef(page, spec.target);
    if (!ref)
      return `"${spec.target.name}" was not among ${JSON.stringify(page?.elements?.slice(0, 8).map((e) => `${e.role} ${e.name}`))}`;
    if (spec.kind === "click") steps.push({ kind: "click", ref });
    else
      steps.push({
        kind: spec.kind,
        ref,
        text: spec.text,
        ...(spec.field ? { field: spec.field, origin: SITE } : {}),
      });
  }
  return steps;
}

export type Submission = { referer: string; host: string; fields: Record<string, string> };

export async function runTask(
  task: BenchTask,
  runId: string,
  driver: RunDriver,
  submissions: (runId: string) => Promise<Submission[]>,
): Promise<TaskRecord> {
  const steps: StepRecord[] = [];
  let first: PageBrowserResult | undefined;
  let latest: PageBrowserResult | undefined;
  const call = async (command: PageBrowserCommand) => {
    const started = performance.now();
    const result = await driver(command);
    const ms = Math.round(performance.now() - started);
    steps.push({
      command: command.command,
      ms,
      ok: result.ok,
      ...modelSize(result),
      ...(result.elements ? { elements: result.elements.length } : {}),
      ...(result.loading ? { loading: true } : {}),
      ...(result.fallback ? { fallback: true } : {}),
      ...(result.uncertain ? { uncertain: true } : {}),
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    });
    // A failed step that still carries the page counts as what the model now sees.
    if (result.elements) {
      latest = result;
      first ??= result;
    }
    return result;
  };
  const fail = (failure: string): TaskRecord => ({ id: task.id, success: false, failure, steps });

  for (const step of task.steps) {
    if ("navigate" in step) {
      const sep = step.navigate.includes("?") ? "&" : "?";
      await call({ command: "navigate", url: `${SITE}${step.navigate}${sep}run=${runId}` });
    } else if ("snapshot" in step) {
      await call({ command: "snapshot" });
    } else if ("until" in step) {
      for (let attempt = 0; !findRef(latest, step.until) && attempt < step.tries; attempt += 1) {
        await call({ command: "snapshot", ...(step.query ? { query: step.query } : {}) });
      }
    } else if ("wait" in step) {
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    } else {
      const actions = actSteps(step.act, step.staleRefs ? first : latest);
      if (typeof actions === "string") {
        if (step.optional) continue;
        return fail(actions);
      }
      const result = await call({ command: "act", actions });
      // A stale ref may be refused (expected) or act on the replacement; either way the next step goes on.
      if (!result.ok && !step.staleRefs) return fail("act failed");
    }
  }

  if ("url" in task.expect) {
    const url = latest?.url ?? "";
    return new URL(url, SITE).pathname === task.expect.url ? ok() : fail(`ended on ${url}`);
  }
  const wanted = task.expect.submitted;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = await submissions(runId);
    if (found.some((entry) => Object.entries(wanted).every(([k, v]) => entry.fields[k] === v)))
      return ok();
    if (found.length)
      return fail(`submitted ${JSON.stringify(found.map((entry) => entry.fields))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return fail("nothing was submitted");

  function ok(): TaskRecord {
    return { id: task.id, success: true, steps };
  }
}

export type DriverRun = {
  driver: string;
  tasks: Array<TaskRecord & { repeat: number }>;
  live?: Array<{ url: string; steps: StepRecord[] }>;
};

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(run: DriverRun) {
  const steps = run.tasks.flatMap((task) => task.steps);
  const byCommand = (command: string) =>
    steps.filter((step) => step.command === command).map((step) => step.ms);
  const repeats = new Set(run.tasks.map((task) => task.repeat)).size || 1;
  const modelChars = steps.reduce((sum, step) => sum + step.modelChars, 0);
  const liveSteps = run.live?.flatMap((site) => site.steps) ?? [];
  return {
    passed: run.tasks.filter((task) => task.success).length,
    tasks: run.tasks.length,
    failedTasks: [...new Set(run.tasks.filter((task) => !task.success).map((task) => task.id))],
    driverCalls: steps.filter((step) => step.command !== "wait").length / repeats,
    modelCharsPerSuite: Math.round(modelChars / repeats),
    estTokensPerSuite: estimateTokens(modelChars / repeats),
    largestResultChars: Math.max(0, ...steps.map((step) => step.modelChars)),
    clippedResults: steps.filter((step) => step.clipped).length,
    errors: steps.filter((step) => step.error).length,
    fallbacks: steps.filter((step) => step.fallback).length,
    navigateMs: {
      p50: percentile(byCommand("navigate"), 50),
      p95: percentile(byCommand("navigate"), 95),
    },
    snapshotMs: {
      p50: percentile(byCommand("snapshot"), 50),
      p95: percentile(byCommand("snapshot"), 95),
    },
    actMs: { p50: percentile(byCommand("act"), 50), p95: percentile(byCommand("act"), 95) },
    ...(liveSteps.length
      ? {
          liveSnapshotChars: percentile(
            liveSteps.filter((step) => step.command === "snapshot").map((step) => step.modelChars),
            50,
          ),
          liveNavigateMs: percentile(
            liveSteps.filter((step) => step.command === "navigate").map((step) => step.ms),
            50,
          ),
        }
      : {}),
  };
}

/** One column per driver, so two runs read side by side. */
export function comparisonTable(runs: DriverRun[]) {
  const summaries = runs.map(summarize);
  const rows: Array<[string, (s: ReturnType<typeof summarize>) => string]> = [
    ["Tasks passed", (s) => `${s.passed}/${s.tasks}`],
    ["Failed tasks", (s) => s.failedTasks.join(" ") || "none"],
    ["Driver calls per suite", (s) => String(s.driverCalls)],
    ["Model chars per suite", (s) => String(s.modelCharsPerSuite)],
    ["Est. model tokens per suite", (s) => String(s.estTokensPerSuite)],
    ["Largest result (chars)", (s) => String(s.largestResultChars)],
    ["Results clipped by runtime", (s) => String(s.clippedResults)],
    ["Errors / fallbacks", (s) => `${s.errors} / ${s.fallbacks}`],
    ["navigate ms p50 / p95", (s) => `${s.navigateMs.p50} / ${s.navigateMs.p95}`],
    ["snapshot ms p50 / p95", (s) => `${s.snapshotMs.p50} / ${s.snapshotMs.p95}`],
    ["act ms p50 / p95", (s) => `${s.actMs.p50} / ${s.actMs.p95}`],
  ];
  if (summaries.some((s) => s.liveSnapshotChars !== undefined)) {
    rows.push(["Live snapshot chars p50", (s) => String(s.liveSnapshotChars ?? "-")]);
    rows.push(["Live navigate ms p50", (s) => String(s.liveNavigateMs ?? "-")]);
  }
  const table = [
    ["", ...runs.map((run) => run.driver)],
    ...rows.map(([label, cell]) => [label, ...summaries.map(cell)]),
  ];
  const widths =
    table[0]?.map((_, column) => Math.max(...table.map((row) => row[column]?.length ?? 0))) ?? [];
  const perTask = TASKS.map((task) => [
    task.id,
    ...runs.map((run) => {
      const records = run.tasks.filter((record) => record.id === task.id);
      const passed = records.filter((record) => record.success).length;
      const chars = records
        .flatMap((record) => record.steps)
        .reduce((sum, step) => sum + step.modelChars, 0);
      return `${passed}/${records.length} ${Math.round(chars / Math.max(1, records.length))}c`;
    }),
  ]);
  const taskWidths = widths.map((width, column) =>
    Math.max(width, ...perTask.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(taskWidths[column] ?? 0)).join("  ");
  return [
    ...table.map(line),
    "",
    line(["Per task (passed, model chars)", ...runs.map(() => "")]),
    ...perTask.map(line),
  ].join("\n");
}
