import type { AgentRunRequest, AgentToolCompletion } from "@rakazo/adapter-kit";
import type { ToolStepCall } from "@rakazo/contracts";
import { storedImageMimeType } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { redactToolArgsForReview } from "./auto-review.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";
import type { ReplyState, RunContext } from "./run-context.js";
import { storeStepScreenshot } from "./thread-artifacts.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";

/**
 * The most of one call's result, or of any one text in its arguments, kept for later turns. The
 * bound is applied once, when the reply is saved, so the replay of a reply never changes.
 */
export const TOOL_CALL_TEXT_MAX_CHARS = 1_000;
/** The most of all results one reply keeps; later results get what is left, then none. */
export const TOOL_REPLY_RESULTS_MAX_CHARS = 8_000;
const TOOL_RESULT_MIN_CHARS = 200;
/** Lists and nesting in arguments are kept generously; only pathological shapes are bounded. */
const ARGUMENT_ITEMS_MAX = 100;
const ARGUMENT_DEPTH_MAX = 8;

/** Stands in for an image a call returned; replay says what the bot wrote after seeing it. */
export const IMAGE_NOT_KEPT = "[image not kept]";

/**
 * Text bounded to `max` characters, keeping its start and end (where a command's output usually
 * ends with what matters) and saying how much was left out, so it never reads as unfinished.
 * Secrets are redacted in each kept part, with a margin so one cut at the edge is still caught.
 */
/** A JSON field whose name says it holds a credential, with its string value. */
const CREDENTIAL_FIELD =
  /("[\w-]*(?:api[_-]?key|token|password|passwd|secret|authorization|credential)[\w-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

export function bounded(text: string, max: number, secrets: string[] = []): string {
  const clean = (part: string) =>
    sanitizeSensitiveText(redactSecrets(part, secrets)).replace(CREDENTIAL_FIELD, '$1"[redacted]"');
  if (text.length <= max) return clean(text);
  const margin = 200;
  const headLength = Math.floor(max * 0.7);
  const tailLength = max - headLength;
  const head = clean(text.slice(0, headLength + margin)).slice(0, headLength);
  const tail = clean(text.slice(-(tailLength + margin))).slice(-tailLength);
  return `${head}\n… [${text.length - max} characters not kept] …\n${tail}`;
}

function keptArgument(value: unknown, depth: number, secrets: string[]): unknown {
  if (typeof value === "string") return bounded(value, TOOL_CALL_TEXT_MAX_CHARS, secrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= ARGUMENT_DEPTH_MAX) return "[nested too deep to keep]";
  if (Array.isArray(value))
    return value.slice(0, ARGUMENT_ITEMS_MAX).map((item) => keptArgument(item, depth + 1, secrets));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, ARGUMENT_ITEMS_MAX)
        .map(([key, item]) => [key, keptArgument(item, depth + 1, secrets)]),
    );
  return undefined;
}

/**
 * A call's arguments as the model sent them, for later turns to replay: the run's secrets and
 * credential-like keys redacted as for an approval review, and only very long texts bounded.
 */
export function keptToolArguments(args: unknown, secrets: string[]): ToolStepCall["arguments"] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "{}";
  return JSON.stringify(
    keptArgument(redactToolArgsForReview(args as Record<string, unknown>, secrets), 0, secrets),
  );
}

/** Tools whose results carry secret values or their names are not kept. */
const SECRET_TOOL = /secret/i;

/** What the model read back from a call (or its error), redacted and bounded to `max`. */
export function keptToolResult(
  completion: AgentToolCompletion,
  secrets: string[],
  max = TOOL_CALL_TEXT_MAX_CHARS,
): string | undefined {
  if (completion.paused || SECRET_TOOL.test(completion.name)) return undefined;
  let text: string;
  if (completion.error !== undefined) text = sanitizeConnectorError(completion.error, secrets);
  else {
    const content = (completion.result as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return undefined;
    text = content
      .map((part: { type?: unknown; text?: unknown }) =>
        part?.type === "text" && typeof part.text === "string"
          ? part.text
          : part?.type === "image"
            ? IMAGE_NOT_KEPT
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  const whole = text.trim();
  return whole ? bounded(whole, max, secrets) : undefined;
}

/**
 * Whether a run may replay what this bot's earlier replies' tools were sent and returned. Only a
 * run the owner started themselves, directly in their own chat or with their own team-chat
 * message, gets them. Every other run (other bots, connected agents, channels, schedules,
 * webhooks, other members, guests, and any trigger added later) sees those replies as everyone
 * did, so tool output never reaches someone it wasn't for.
 */
export function runReplaysToolHistory(
  trigger: string,
  source: { fromUser: boolean; nonOwnerChat: boolean },
): boolean {
  if (source.nonOwnerChat) return false;
  switch (trigger) {
    case "user":
    case "call_end":
      return true;
    case "follow_up":
      return source.fromUser;
    case "messaging":
      // Only the owner's own message: a channel or another person is nonOwnerChat above.
      return true;
    // A run resumed after its question or a takeover is the same run, keeping its own trigger and
    // source, so it inherits the original's answer here. A run recorded as "resume" names no
    // original run to trace, so it is refused with every other trigger.
    default:
      return false;
  }
}

/** Adds a finished call's result to the call its step keeps, within the reply's result budget. */
export function keepToolStepResult(
  reply: Pick<
    ReplyState,
    "toolStepCalls" | "keptResultChars" | "latestScreenshot" | "earlyCompletions"
  >,
  completion: AgentToolCompletion,
  secrets: string[],
): void {
  const call = reply.toolStepCalls.get(completion.executionId);
  if (!call) {
    // A fast call can finish before its own call event is handled; that handler keeps it then.
    reply.earlyCompletions ??= new Map();
    reply.earlyCompletions.set(completion.executionId, completion);
    return;
  }
  // An error, an error result or a non-zero exit, as the step's outcome counts it.
  const failed = toolCompletionOutcome(completion) === "failed" ? ({ failed: true } as const) : {};
  const left = TOOL_REPLY_RESULTS_MAX_CHARS - reply.keptResultChars;
  // Once the reply's budget is spent, later calls keep how they ended but not what they returned.
  const result =
    left >= TOOL_RESULT_MIN_CHARS
      ? keptToolResult(completion, secrets, Math.min(TOOL_CALL_TEXT_MAX_CHARS, left))
      : undefined;
  if (result !== undefined) reply.keptResultChars += result.length;
  const image = screenshotOf(completion);
  if (image) reply.latestScreenshot = { executionId: completion.executionId, ...image };
  reply.toolStepCalls.set(completion.executionId, {
    ...call,
    ...(result === undefined ? {} : { result }),
    ...failed,
  });
}

/**
 * Whether replayed history hands the model any kept result or screenshot. Such text could carry
 * injected instructions, even from a tool that reads the bot's own state (a saved page holds what
 * an earlier run copied in), so the run starts as one that has read outside content.
 */
export function historyReplaysOutsideContent(history: AgentRunRequest["history"]): boolean {
  return history.some((entry) =>
    entry.segments?.some(
      (segment) =>
        "steps" in segment &&
        segment.steps.some((step) =>
          step.calls?.some((call) => call.result !== undefined || call.image !== undefined),
        ),
    ),
  );
}

/** The image a call returned (a screenshot), when it is one this product stores. */
function screenshotOf(completion: AgentToolCompletion) {
  if (completion.paused || completion.error !== undefined || SECRET_TOOL.test(completion.name))
    return undefined;
  const content = (completion.result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const part = content.findLast((item: { type?: unknown }) => item?.type === "image") as
    | { data?: unknown; mimeType?: unknown }
    | undefined;
  const mimeType =
    typeof part?.mimeType === "string" ? storedImageMimeType(part.mimeType) : undefined;
  if (!mimeType || typeof part?.data !== "string") return undefined;
  return { mimeType, data: new Uint8Array(Buffer.from(part.data, "base64")) };
}

/**
 * Saves the screenshot the reply's last image-returning call took, and points that call at it, so
 * a later turn replays the reply with the image as the bot saw it. Saved once, with the reply, so
 * the stored reply (and its replay) never changes afterwards. A failed save leaves the call as
 * `[image not kept]`, as before.
 */
export async function saveLatestStepScreenshot(ctx: RunContext): Promise<void> {
  const { reply } = ctx.state;
  const shot = reply.latestScreenshot;
  reply.latestScreenshot = undefined;
  const call = shot && reply.toolStepCalls.get(shot.executionId);
  if (!shot || !call || !ctx.deps.artifacts) return;
  try {
    const artifactId = await storeStepScreenshot(
      { prisma: ctx.deps.prisma, artifacts: ctx.deps.artifacts },
      {
        spaceId: ctx.run.spaceId,
        userId: ctx.run.userId,
        botId: ctx.bot.id,
        groupId: ctx.thread.groupId ?? undefined,
        runId: ctx.runId,
        operationId: `${ctx.runId}:${shot.executionId}:screenshot`,
        image: shot,
      },
    );
    reply.toolStepCalls.set(shot.executionId, { ...call, image: { artifactId } });
  } catch (error) {
    getLogger().error("step screenshot save", error);
  }
}
