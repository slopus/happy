import { hasThinkingActivityMarker, parseBotAvatarValue } from "@rakazo/contracts";
import { isBackgroundRunTrigger, isRunWaitingOnUser, isRunWorking } from "./run-state.js";

/** Minimal public stream fields used by web and native activity projections. */
export interface LogoAvatarEvent {
  threadId: string;
  seq: number;
  botId?: string;
  runId?: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Activity derives only from explicit public run/tool/provider lifecycle events. */
export type LogoAvatarActivity =
  | "idle"
  | "reading"
  | "writing"
  | "thinking"
  | "computer"
  | "working"
  | "waiting"
  | "error";

/** Logo activity displayed by the selected avatar. */
export function botAvatarActivity(
  bot: { avatarSet?: string; color: string; archivedAt?: string | null },
  activity: LogoAvatarActivity,
): LogoAvatarActivity {
  if (bot.archivedAt || !usesLogoAvatar(bot)) return "idle";
  return activity;
}

export function usesLogoAvatar(bot: { avatarSet?: string; color: string }): boolean {
  const parsed = parseBotAvatarValue(bot.color);
  return bot.avatarSet === "rakazo" && parsed.kind !== "image" && parsed.kind !== "shape";
}

export function logoAvatarNeedsAttention(activity: LogoAvatarActivity): boolean {
  "worklet";
  return activity === "waiting";
}

export interface LogoAvatarSignals {
  botId: string;
  runId?: string;
  status: string;
  composing: boolean;
  thinking: boolean;
  tools: readonly { executionId: string; name: string }[];
  cursor: number;
  background: boolean;
}

export function initialLogoAvatarSignals(botId: string): LogoAvatarSignals {
  return {
    botId,
    status: "idle",
    composing: false,
    thinking: false,
    tools: [],
    cursor: -1,
    background: false,
  };
}

/** Exact built-in operations, never guesses from a provider's free-text status. */
const READING_TOOLS = new Set(["read_file", "web_fetch", "read_history", "skill_read"]);
const WRITING_TOOLS = new Set(["write_file"]);
const COMPUTER_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "user_computer_shell",
  "user_computer_observe",
  "user_computer_act",
  "shell",
  "open_path",
  "launch_app",
]);

export function logoAvatarActivity(signals: LogoAvatarSignals): LogoAvatarActivity {
  if (signals.background) return "idle";
  if (signals.status === "failed") return "error";
  if (isRunWaitingOnUser(signals.status)) return "waiting";
  if (!isRunWorking(signals.status)) return "idle";
  const tool = signals.tools.at(-1)?.name;
  if (tool && COMPUTER_TOOLS.has(tool)) return "computer";
  if (tool && READING_TOOLS.has(tool)) return "reading";
  if (tool && WRITING_TOOLS.has(tool)) return "writing";
  if (tool) return "working";
  if (signals.composing) return "writing";
  if (signals.thinking) return "thinking";
  return "working";
}

/**
 * Retain live provider/tool/composing detail beside snapshots that omit those phases.
 * Reconnect snapshots start conservatively rather than replaying stale tool poses.
 */
export function reduceLogoAvatarSignals(
  previous: LogoAvatarSignals,
  event: LogoAvatarEvent,
): LogoAvatarSignals {
  if (event.botId !== previous.botId || event.seq <= previous.cursor) return previous;
  const next = { ...previous, cursor: event.seq };
  if (event.type === "run.started") {
    return {
      ...next,
      runId: event.runId,
      status: "running",
      tools: [],
      composing: false,
      thinking: false,
      background: isBackgroundRunTrigger(String(event.payload.trigger ?? "")),
    };
  }
  if (!previous.runId || event.runId !== previous.runId) return next;
  if (
    event.type === "run.completed" ||
    event.type === "run.cancelled" ||
    event.type === "run.failed"
  ) {
    return { ...next, status: event.type.slice(4), tools: [], composing: false, thinking: false };
  }
  if (
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.granted"
  ) {
    return {
      ...next,
      status: event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover",
      tools: [],
      composing: false,
      thinking: false,
    };
  }
  if (event.type === "computer.takeover.released") {
    return { ...next, status: "queued", tools: [], composing: false, thinking: false };
  }
  if (event.type === "agent.tool.called") {
    const { name, executionId } = event.payload;
    if (typeof name !== "string" || typeof executionId !== "string") return next;
    return {
      ...next,
      composing: false,
      thinking: false,
      tools: [
        ...previous.tools.filter((tool) => tool.executionId !== executionId),
        { name, executionId },
      ],
    };
  }
  if (event.type === "agent.tool.completed") {
    return {
      ...next,
      thinking: false,
      tools: previous.tools.filter((tool) => tool.executionId !== event.payload.executionId),
    };
  }
  if (event.type === "thread.message.created") {
    return event.payload.role === "bot" ? { ...next, composing: false, thinking: false } : next;
  }
  if (event.type === "thread.meta") {
    if (
      !hasThinkingActivityMarker(event.payload) ||
      typeof event.payload.activity.thinking !== "boolean"
    )
      return next;
    // A late start cannot resurrect a paused/finished run or override active tools.
    const thinking =
      event.payload.activity.thinking && isRunWorking(previous.status) && !previous.tools.length;
    return { ...next, thinking, ...(thinking ? { composing: false } : {}) };
  }
  if (event.type === "thread.progress") {
    const text = event.payload.delta ?? event.payload.text;
    return {
      ...next,
      thinking: false,
      composing:
        event.payload.streaming === true &&
        event.payload.activity !== true &&
        typeof text === "string" &&
        text.trim().length > 0,
    };
  }
  return next;
}
