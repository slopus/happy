import { z } from "zod";
import type { Criterion, EvalCase, Evidence } from "./cases.js";
import { readCasesFile } from "./cases.js";

export const TOOL_CHOICE_FIXTURE_VERSION = "tool-choice-v1";

/**
 * A string starting with `~` matches case-insensitively as a substring, `*` matches any present
 * value, an array matches any of its members, and anything else must be equal.
 */
const MatcherSchema: z.ZodType<Matcher> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(MatcherSchema)]),
);
type Matcher = string | number | boolean | null | Matcher[];

const CallSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), MatcherSchema).optional(),
});
export type CallExpectation = z.infer<typeof CallSchema>;

const ExpectSchema = z
  .object({
    /** Every listed call must happen. */
    calls: z.array(CallSchema).optional(),
    /** At least one listed call must happen. */
    anyOf: z.array(CallSchema).min(1).optional(),
    /** None of these tools may be called; `*` forbids every tool. */
    notCalls: z.array(z.string()).optional(),
    /** No call may match any of these. */
    callsMustNot: z.array(CallSchema).optional(),
    /** These tools must first appear in this order. */
    order: z.array(z.string()).min(2).optional(),
    maxCalls: z.record(z.string(), z.number().int().min(0)).optional(),
    /** Bot settings after the turn. */
    bot: z.record(z.string(), MatcherSchema).optional(),
    /** Account settings after the turn. */
    user: z.record(z.string(), MatcherSchema).optional(),
    /** The turn must leave the bot's and the account's settings as they were. */
    settingsUnchanged: z.literal(true).optional(),
  })
  .strict();
export type ToolChoiceExpect = z.infer<typeof ExpectSchema>;

const BotSetupSchema = z
  .object({
    instructions: z.string().optional(),
    notifyOnFinish: z.boolean().optional(),
    autoSpeak: z.boolean().optional(),
    thinkingLevel: z.string().optional(),
  })
  .strict();
export type BotSetup = z.infer<typeof BotSetupSchema>;

export const ToolChoiceCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    area: z.string().min(1),
    /** guard: the request needs a specific tool. control: ordinary work that must not touch it. */
    kind: z.enum(["guard", "control"]),
    purpose: z.string().min(1),
    bot: BotSetupSchema.optional(),
    /** Earlier user turns, run for real before the graded prompt. */
    priorTurns: z.array(z.string().min(1)).optional(),
    /** Clear the conversation after the prior turns, so only durable state carries over. */
    clearBeforePrompt: z.literal(true).optional(),
    prompt: z.string().min(1),
    expect: ExpectSchema,
  })
  .strict()
  .refine(
    ({ kind, expect }) =>
      kind === "control" ||
      Boolean(
        expect.calls?.length ||
          expect.anyOf ||
          expect.order ||
          Object.keys({ ...expect.bot, ...expect.user }).length,
      ),
    { message: "A guard needs a call, setting or order it must produce, not only prohibitions" },
  );
export type ToolChoiceCase = z.infer<typeof ToolChoiceCaseSchema>;

const SETTINGS_TOOLS = ["update_bot", "update_preferences"];

function matches(expected: Matcher, actual: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((option) => matches(option, actual));
  if (expected === "*") return actual !== undefined && actual !== null && actual !== "";
  if (typeof expected === "string" && expected.startsWith("~")) {
    const text = typeof actual === "string" ? actual : JSON.stringify(actual ?? "");
    return text.toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  return expected === actual;
}

function callMatches(expected: CallExpectation, call: { name: string; args: unknown }) {
  if (expected.tool !== call.name) return false;
  const args = (call.args ?? {}) as Record<string, unknown>;
  return Object.entries(expected.args ?? {}).every(([key, value]) => matches(value, args[key]));
}

const describeCall = (call: CallExpectation) =>
  call.args ? `${call.tool}(${JSON.stringify(call.args)})` : call.tool;

const stateCriteria = (
  label: "bot" | "user",
  expected: Record<string, Matcher> | undefined,
  actual: Record<string, unknown>,
): Criterion[] =>
  Object.entries(expected ?? {}).map(([key, value]) => ({
    id: `${label}.${key}=${JSON.stringify(value)}`,
    pass: matches(value, actual[key]),
  }));

/** Grades only the final turn; prior turns are setup. */
export function gradeToolChoice(expect: ToolChoiceExpect, evidence: Evidence): Criterion[] {
  const calls = evidence.toolCalls.filter((call) => call.step === evidence.finalStep);
  const names = calls.map((call) => call.name);
  const criteria: Criterion[] = [];
  for (const call of expect.calls ?? [])
    criteria.push({
      id: `calls ${describeCall(call)}`,
      pass: calls.some((c) => callMatches(call, c)),
    });
  if (expect.anyOf)
    criteria.push({
      id: `calls one of ${expect.anyOf.map(describeCall).join(" | ")}`,
      pass: expect.anyOf.some((call) => calls.some((c) => callMatches(call, c))),
    });
  for (const tool of expect.notCalls ?? [])
    criteria.push({
      id: tool === "*" ? "calls no tool" : `does not call ${tool}`,
      pass: tool === "*" ? calls.length === 0 : !names.includes(tool),
    });
  for (const call of expect.callsMustNot ?? [])
    criteria.push({
      id: `does not call ${describeCall(call)}`,
      pass: !calls.some((c) => callMatches(call, c)),
    });
  if (expect.order) {
    const positions = expect.order.map((tool) => names.indexOf(tool));
    criteria.push({
      id: `order ${expect.order.join(" > ")}`,
      pass: positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)),
    });
  }
  for (const [tool, max] of Object.entries(expect.maxCalls ?? {}))
    criteria.push({
      id: `at most ${max} ${tool}`,
      pass: names.filter((name) => name === tool).length <= max,
    });
  if (calls.some((call) => call.viaUseTool || call.name === "use_tool"))
    criteria.push({
      id: "use_tool runs only tools find_tool loaded",
      pass: calls.every((call) => call.name !== "use_tool" && (!call.viaUseTool || call.loaded)),
    });
  criteria.push(...stateCriteria("bot", expect.bot, evidence.settings.bot));
  criteria.push(...stateCriteria("user", expect.user, evidence.settings.user));
  if (expect.settingsUnchanged)
    criteria.push({
      id: "settings unchanged",
      pass:
        JSON.stringify(evidence.settings) === JSON.stringify(evidence.settingsBefore) &&
        !names.some((name) => SETTINGS_TOOLS.includes(name) && !isSettingsRead(calls, name)),
    });
  return criteria;
}

/** `update_bot` with no fields only reads; providers may send omitted fields as null or blank. */
function isSettingsRead(calls: Evidence["toolCalls"], name: string) {
  return calls
    .filter((call) => call.name === name)
    .every((call) =>
      Object.values((call.args ?? {}) as Record<string, unknown>).every(
        (value) => value === null || (typeof value === "string" && !value.trim()),
      ),
    );
}

export function toolChoiceEvalCase(definition: ToolChoiceCase): EvalCase {
  const parsed = ToolChoiceCaseSchema.parse(definition);
  return {
    id: parsed.id,
    purpose: `[${parsed.area}/${parsed.kind}] ${parsed.purpose}`,
    connections: [],
    pauseEndsTurn: true,
    ...(parsed.bot ? { botSetup: parsed.bot } : {}),
    steps: [
      ...(parsed.priorTurns ?? []).map((ask) => ({ ask })),
      ...(parsed.clearBeforePrompt ? [{ clear: true as const }] : []),
      { ask: parsed.prompt },
    ],
    grade: (evidence) => gradeToolChoice(parsed.expect, evidence),
  };
}

/** Reads extra cases (JSON array or one JSON object per line) from a file kept outside the repo. */
export function loadToolChoiceCases(file: string): EvalCase[] {
  return readCasesFile(file).map((entry) => toolChoiceEvalCase(ToolChoiceCaseSchema.parse(entry)));
}
