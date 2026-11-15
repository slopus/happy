import { createHash } from "node:crypto";
import type { ToolCallStreak } from "@rakazo/core";
import { trackToolCallStreak } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { toolResultError } from "./tool-result-error.js";

const LOOP_GUARD_STOP_PREFIX = "I got stuck calling ";
const LOOP_GUARD_STOP_COUNT_PATTERN = " with (?:(?:nearly )?the same input|too many actions) ";
const LOOP_GUARD_STOP_SUFFIX =
  " times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
const LOOP_GUARD_STOP_PATTERN = new RegExp(
  `^${LOOP_GUARD_STOP_PREFIX}.+${LOOP_GUARD_STOP_COUNT_PATTERN}\\d+${LOOP_GUARD_STOP_SUFFIX.replaceAll(".", "\\.")}$`,
);

/** Whether the run stopped on one call repeated exactly, and the count its stop message gives. */
export function loopGuardStop(streak: ToolCallStreak): { identical: boolean; count: number } {
  // Short of the similar limit, only a repeated failure stops a run, and that is an identical one.
  const identical =
    streak.count >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS ||
    (streak.shapeCount ?? 0) < MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS;
  return { identical, count: identical ? streak.count : toolCallStreakLength(streak) };
}

export function loopGuardStopText(toolName: string, streak: ToolCallStreak): string {
  const { identical, count } = loopGuardStop(streak);
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with ${identical ? "" : "nearly "}the same input ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function overLimitStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with too many actions ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function isLoopGuardStopText(text: string): boolean {
  return LOOP_GUARD_STOP_PATTERN.test(text);
}

// Same tool, same arguments, failing this many times in a row means the agent is stuck.
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6;
// Arguments that differ only by digits in their text (`echo noop-1`, `echo noop-2`) can be a real
// sequence such as reading a file in chunks or paging through a site, so they get more room. So
// does an identical call that keeps succeeding with the same answer: it may be waiting on a page.
const MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS = 25;
const FAILED_RESULT = "failed:";

// A batch over the action limit is refused unrun. Sending another one is a loop the model rarely
// leaves on its own, so it is told on the repeat and the run ends on this one.
export const MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS = 4;
/** The most actions one `computer_act` or `browser_act` call may carry. */
export const MAX_ACTIONS_PER_CALL = 24;

/** A double click expands to two computer actions; every other action stays as one. */
export function computerActionCount(action: unknown): number {
  if (!action || typeof action !== "object") return 1;
  const { kind, double } = action as { kind?: unknown; double?: unknown };
  return kind === "click" && double === true ? 2 : 1;
}

/** Counts consecutive over-limit `computer_act`/`browser_act` batches; other calls leave it alone. */
export function advanceOverLimitActionCalls(count: number, name: string, args: unknown): number {
  if (name !== "computer_act" && name !== "browser_act") return count;
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return 0;
  const actionCount =
    name === "computer_act"
      ? actions.reduce((total, action) => total + computerActionCount(action), 0)
      : actions.length;
  return actionCount > MAX_ACTIONS_PER_CALL ? count + 1 : 0;
}

/** The longer of the two runs, for the stop message. */
export function toolCallStreakLength(streak: ToolCallStreak): number {
  return Math.max(streak.count, streak.shapeCount ?? 0);
}

/**
 * `executionId` and `response` are the streak's last call and the model response that made it;
 * `results` are the distinct answers this identical run has had, up to the similar limit, and
 * `failures` how many answers in a row failed.
 */
export type LoopGuardStreak = ToolCallStreak & {
  executionId?: string;
  response?: number;
  results?: string[];
  failures?: number;
};

/**
 * What the model saw: content rather than details, which can carry timings. Failures are marked
 * so a repeat of one stops sooner.
 */
export function toolResultFingerprint(result: unknown, error?: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  // Screen results compare by frame: their text carries the capture time.
  const frameId = (record.details as { frameId?: unknown } | undefined)?.frameId;
  const seen =
    error !== undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : typeof frameId === "string"
        ? frameId
        : "content" in record
          ? record.content
          : result;
  const failed = error !== undefined || toolResultError(result) !== undefined;
  return `${failed ? FAILED_RESULT : ""}${createHash("sha256")
    .update(JSON.stringify(seen) ?? "")
    .digest("hex")}`;
}

/**
 * `previousResult` is the fingerprint of the streak's last call, once it has finished. A repeat
 * whose last answer is new to the run is polling something that changes, so the identical run
 * starts over from that call; answers it has seen before (a blinking cursor) keep counting. A
 * repeat stops early only when its answers keep failing. Matching calls from one model response
 * are one step, so they return the streak unchanged.
 */
export function advanceToolCallLoopGuard(
  streak: LoopGuardStreak,
  name: string,
  args: unknown,
  previousResult?: string,
  response?: number,
): { streak: LoopGuardStreak; stuck: boolean } {
  // Preserve JSON's optional-field handling, then compare objects independently of field order.
  const serialized = JSON.stringify(args);
  const canonicalArgs =
    serialized === undefined ? undefined : JSON.parse(stableJsonValue(JSON.parse(serialized)));
  let next = trackToolCallStreak(streak, name, canonicalArgs);
  if (response !== undefined && response === streak.response && next.shape === streak.shape)
    return { streak, stuck: false };
  const same = next.key === streak.key;
  const seen = (same && streak.results) || [];
  const fresh = previousResult !== undefined && !seen.includes(previousResult);
  const restart = same && fresh && seen.length > 0;
  if (restart)
    next = trackToolCallStreak({ ...streak, count: 1, shapeCount: 1 }, name, canonicalArgs);
  const results = fresh
    ? [...seen, previousResult].slice(-MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS)
    : seen;
  const failures =
    same && previousResult?.startsWith(FAILED_RESULT)
      ? (restart ? 0 : (streak.failures ?? 0)) + 1
      : 0;
  return {
    streak: { ...next, response, ...(same ? { results, failures } : {}) },
    // The first call has no answer yet, so six identical failing calls have five failures.
    stuck:
      failures >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS - 1 ||
      (next.shapeCount ?? 0) >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS,
  };
}
