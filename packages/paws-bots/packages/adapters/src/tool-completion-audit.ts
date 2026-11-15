import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import type { ToolRefusal } from "./tool-refusal.js";
import { refusalCode } from "./tool-refusal.js";
import { isFailedToolResult, toolResultError } from "./tool-result-error.js";

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

/** A command's exit code, from the result itself or its details, when the tool reports one. */
function exitCode(result: unknown): number | undefined {
  for (const value of [result, (result as { details?: unknown } | null)?.details]) {
    if (!value || typeof value !== "object") continue;
    const { code, exitCode } = value as { code?: unknown; exitCode?: unknown };
    if (typeof code === "number") return code;
    if (typeof exitCode === "number") return exitCode;
  }
  return undefined;
}

/**
 * How a call ended, or undefined while it waits on an approval or answer. A command that ran but
 * exited non-zero failed, though the tool itself returned normally.
 */
export function toolCompletionOutcome(
  completion: AgentToolCompletion,
): "succeeded" | "failed" | undefined {
  if (completion.paused) return undefined;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  if (error !== undefined) return "failed";
  const code = exitCode(completion.result);
  return code === undefined || code === 0 ? "succeeded" : "failed";
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
  }
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Promise<void> {
  const payload = toolCompletionAuditPayload(completion, secrets);
  getLogger().info("agent.tool.completed", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    tool: payload.name,
    "tool.outcome": payload.outcome,
    "tool.duration_ms": payload.durationMs,
  });
  try {
    await deps.events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed",
      payload,
    });
  } catch (error) {
    // A tool that finishes after its run was cancelled has no history to join.
    if (error instanceof RunHistoryWriteError) return;
    // Audit persistence must not change the tool result or strand the run.
    getLogger().warn("agent tool completion audit append failed", {
      "error.detail": sanitizeConnectorError(error, secrets),
      tool: redactSecrets(completion.name, secrets),
      executionId: redactSecrets(completion.executionId, secrets),
    });
  }
}

type RunLogTarget = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  trigger: string;
};

const runLogFields = (target: RunLogTarget) => ({
  "run.id": target.runId,
  "space.id": target.spaceId,
  "thread.id": target.threadId,
  "bot.id": target.botId,
  "run.trigger": target.trigger,
});

/**
 * Logs a call turned away before its tool ran, and returns what was logged. Only the code is
 * logged: the sentence the model reads can name bots, arguments or sites. A refusal without a
 * code, such as a connector's own error, logs nothing here.
 */
export function logToolRefusal(
  target: RunLogTarget,
  tool: string,
  refused: unknown,
  secrets: string[] = [],
  resolvedTool?: string,
): ToolRefusal | undefined {
  const code = refusalCode(refused);
  if (!code) return undefined;
  const logged: ToolRefusal = {
    code,
    ...(resolvedTool ? { target: redactSecrets(resolvedTool, secrets) } : {}),
  };
  getLogger().info("agent.tool.refused", {
    ...runLogFields(target),
    tool: redactSecrets(tool, secrets),
    ...(logged.target ? { "tool.target": logged.target } : {}),
    "tool.refusal": code,
  });
  return logged;
}

/** Logs a run stopped for repeating a call, with the code of the refusal it kept getting, if any. */
export function logLoopGuardStop(
  target: RunLogTarget,
  stop: {
    tool: string;
    reason: "repeated_calls" | "over_limit_actions";
    count: number;
    /** How many of the repeated calls in a row came back failed. */
    failures: number;
    refusal?: ToolRefusal;
  },
  secrets: string[] = [],
): void {
  getLogger().info("run.loop_guard_stopped", {
    ...runLogFields(target),
    tool: redactSecrets(stop.tool, secrets),
    "loop.reason": stop.reason,
    "loop.count": stop.count,
    "loop.failures": stop.failures,
    ...(stop.refusal?.target ? { "tool.target": stop.refusal.target } : {}),
    ...(stop.refusal ? { "tool.refusal": stop.refusal.code } : {}),
  });
}
