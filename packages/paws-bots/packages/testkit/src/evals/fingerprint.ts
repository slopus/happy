import { createHash } from "node:crypto";
import type { ModelConnectInput } from "@rakazo/contracts";
import type { EvalCase } from "./cases.js";

/**
 * What changes between two trials of an unchanged case without changing what the model is asked:
 * record ids, loopback ports, and the clock with dates written relative to it. Ids become numbered
 * placeholders in order of appearance, so two different ids in one request stay distinct.
 */
const IDS: Array<[RegExp, string | null]> = [
  [/\bc[a-z0-9]{24}\b/g, null],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, null],
  [/\b(?:127\.0\.0\.1|localhost):\d+/g, "<loopback>"],
  [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
    "<date>",
  ],
  [/\b\d{4}\/\d{2}\/\d{2}\b/g, "<date>"],
];
/**
 * Also written relative to the clock in a request (its current date line, relative fixture dates),
 * but a case's own data keeps them: a deadline moved from Friday to Tuesday is a new case.
 */
const CLOCK: Array<[RegExp, string | null]> = [
  ...IDS,
  [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? {1,2}\d{1,2}(?:, \d{4})?\b/g,
    "<date>",
  ],
  [/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day|sday|nesday|rsday|urday)?\b/g, "<day>"],
];

/**
 * JSON with keys sorted and every string normalized by `patterns`, so equal content hashes equal.
 * A string that is not JSON is normalized as text.
 */
function canonical(value: unknown, patterns = CLOCK): string {
  const ids = new Map<string, string>();
  const text = (input: string) => {
    let out = input;
    for (const [pattern, replacement] of patterns)
      out = out.replace(pattern, (match) => {
        if (replacement !== null) return replacement;
        if (!ids.has(match)) ids.set(match, `<id${ids.size + 1}>`);
        return ids.get(match)!;
      });
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, walk((v as Record<string, unknown>)[key])]),
      );
    return v;
  };
  return JSON.stringify(walk(value));
}

/** A model request body as sent, reduced to what drives the reply. */
export function canonicalModelRequest(body: string): string {
  try {
    return canonical(JSON.parse(body));
  } catch {
    return canonical(body);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Connection settings that shape replies; the key, label and save options do not. */
export function modelSettings(connection: ModelConnectInput) {
  const {
    apiKey: _apiKey,
    label: _label,
    credentialId: _credentialId,
    makeDefault: _makeDefault,
    scope: _scope,
    ...settings
  } = connection;
  return settings;
}

/**
 * One case and strategy's fingerprint: its first model request as sent, the model and its settings,
 * the case's fixture version and data, and the trial controls the product reads. The judge is kept
 * out, so a new rubric regrades stored replies instead of rerunning the bot.
 */
export function caseFingerprint(input: {
  request: string;
  connection: ModelConnectInput;
  caseVersion: string;
  scenario: EvalCase;
  strategy: string;
  replyMode: string;
  maxToolCalls: number;
}): string {
  return sha256(
    canonical(
      {
        v: 1,
        request: canonicalModelRequest(input.request),
        model: modelSettings(input.connection),
        caseVersion: input.caseVersion,
        // Functions drop out; the steps, files and scripts a case feeds the bot later stay.
        caseData: JSON.parse(JSON.stringify(input.scenario)),
        strategy: input.strategy,
        replyMode: input.replyMode,
        maxToolCalls: input.maxToolCalls,
      },
      IDS,
    ),
  );
}

/**
 * The run's fingerprint over its cases' fingerprints. A case that never reached the model, or
 * whose first request changed between trials, has none and is left out; with none at all, null.
 */
export function runFingerprint(cases: Record<string, string | null>): string | null {
  const entries = Object.entries(cases)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return null;
  return sha256(entries.map(([key, value]) => `${key}\n${value}\n`).join(""));
}

export const caseKey = (caseId: string, strategy: string | undefined) =>
  `${caseId}/${strategy ?? "current"}`;

/**
 * Hands the first request for the eval model to `onFirst` before it is sent. When that returns
 * false, the request and every later one fail without reaching the provider.
 */
export function firstRequestFetch(
  upstream: typeof fetch,
  modelId: string,
  onFirst: (body: string) => boolean,
  scenario?: EvalCase,
): typeof fetch {
  // A new bot's intro run can race the case's first turn; only a request carrying that turn counts.
  const first = scenario?.steps[0];
  const turn = first && ("ask" in first ? first.ask : "slack" in first ? first.slack : null);
  const marker = turn ? JSON.stringify(turn).slice(1, -1) : null;
  let seen = false;
  let open = true;
  return (input, init) => {
    if (
      !seen &&
      typeof init?.body === "string" &&
      isFor(input, init.body, modelId) &&
      (!marker || init.body.includes(marker))
    ) {
      seen = true;
      open = onFirst(init.body);
    }
    if (!open) return Promise.reject(new Error("Stored trials replace this run"));
    return upstream(input, init);
  };
}

/** Most protocols name the model in the body; some put it in the path. */
function isFor(input: Parameters<typeof fetch>[0], body: string, modelId: string) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes(`/${encodeURIComponent(modelId)}`) || url.includes(`/${modelId}`)) return true;
  try {
    return (JSON.parse(body) as { model?: unknown }).model === modelId;
  } catch {
    return false;
  }
}
