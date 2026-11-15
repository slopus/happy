import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";
import { TOOL_STEP_CALLS_KEPT, toolStepOutcomeText } from "@rakazo/core";
import { neutralizeSpeakerLabels } from "./history-speakers.js";
import { normalizeAgentToolName } from "./pi-runtime-tools.js";
import { bounded, IMAGE_NOT_KEPT, TOOL_CALL_TEXT_MAX_CHARS } from "./tool-step-calls.js";

export function toPiImages(images: AgentRunRequest["currentTurnImages"]) {
  return (images ?? []).map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
}

/**
 * Bump when the shape of replayed history changes (roles, labels, tool steps, images), so runs
 * record which replay format they used. Part of the prompt version.
 */
export const HISTORY_FORMAT_VERSION = 2;

/**
 * Provider, api and model stamped on replayed own replies. None matches a real model, so Pi
 * replays them as plain text from another model: no signatures or reasoning, same on every provider.
 */
const HISTORY_ASSISTANT = { api: "rakazo-history", provider: "rakazo-history", model: "history" };
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** Stands in for the opening turn when the window starts on a bot message (Bedrock needs a user first). */
const CONVERSATION_START = "[Conversation start]";

type HistoryMessage = Message & {
  rakazoHistory: true;
  rakazoMessageId?: string;
  rakazoCreatedAt?: string;
};

type HistoryEntry = AgentRunRequest["history"][number];
type HistoryStep = Extract<
  NonNullable<HistoryEntry["segments"]>[number],
  { steps: unknown }
>["steps"][number];
type HistoryCommon = Pick<
  HistoryMessage,
  "timestamp" | "rakazoHistory" | "rakazoMessageId" | "rakazoCreatedAt"
>;

/** The bot's words before a step, capped as the text form caps step notes. */
const REPLAYED_NOTE_MAX_CHARS = 300;

/** A provider-safe tool name, from the name the step stored. */
/** The name the tool is offered under, so a replayed call matches the tool the model has. */
function replayedToolName(tool: string): string {
  return normalizeAgentToolName(tool.trim());
}

/** The steps a replay shows: every step that starts within the calls a reply keeps. */
function replayedSteps(segments: NonNullable<HistoryEntry["segments"]>): HistoryStep[] {
  const steps: HistoryStep[] = [];
  let calls = 0;
  for (const segment of segments) {
    if (!("steps" in segment)) continue;
    for (const step of segment.steps) {
      if (calls >= TOOL_STEP_CALLS_KEPT) return steps;
      steps.push(step);
      calls += Math.max(1, Math.floor(Number(step.count)) || 1);
    }
  }
  return steps;
}

/**
 * Whether a reply replays as tool calls: every step it shows kept its tool name and its calls.
 * Older steps kept neither, and a reply with any of them stays in the text form, so a thread
 * never changes how an earlier reply reads.
 */
function replaysAsToolCalls(segments: NonNullable<HistoryEntry["segments"]>): boolean {
  const steps = replayedSteps(segments);
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        typeof step.tool === "string" &&
        step.tool.length > 0 &&
        Array.isArray(step.calls) &&
        step.calls.length === step.count,
    )
  );
}

function replayedArguments(json: string | undefined): ToolCall["arguments"] {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ToolCall["arguments"])
      : {};
  } catch {
    return {};
  }
}

/** The result a replayed call shows: what was kept of it, or how it ended when nothing was. */
/** How long a quote of the bot's own words after an image may be. */
const WORDS_AFTER_IMAGE_MAX_CHARS = 300;

function replayedResult(
  step: HistoryStep,
  call: NonNullable<HistoryStep["calls"]>[number],
  wordsAfter: string,
): { text: string; isError: boolean } {
  const outcome = toolStepOutcomeText(step);
  // A call in a step with mixed outcomes says itself whether it failed.
  const isError = call.failed === true || outcome === "failed" || outcome === "stopped";
  const ended = outcome ? `${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}.` : "Done.";
  if (typeof call.result !== "string" || !call.result) return { text: ended, isError };
  // Saved results are already bounded; this only holds imported ones to the same size.
  if (!call.result.includes(IMAGE_NOT_KEPT))
    return { text: bounded(call.result, TOOL_CALL_TEXT_MAX_CHARS), isError };
  // The image itself is gone; what the bot wrote right after seeing it is what it showed.
  const quote =
    wordsAfter.length > WORDS_AFTER_IMAGE_MAX_CHARS
      ? `${wordsAfter.slice(0, WORDS_AFTER_IMAGE_MAX_CHARS)}…`
      : wordsAfter;
  const seen = quote
    ? `[${ended} You looked at this image then; it is not kept. What you wrote next: "${quote}"]`
    : `[${ended} You looked at this image then; it is not kept.]`;
  return { text: call.result.replace(IMAGE_NOT_KEPT, seen), isError };
}

/** The bot's next words after a step: the following step's note, or the text after the steps. */
function wordsAfterSteps(
  segments: NonNullable<HistoryEntry["segments"]>,
): Map<HistoryStep, string> {
  const after = new Map<HistoryStep, string>();
  let pending: HistoryStep[] = [];
  const settle = (words: string) => {
    for (const step of pending) after.set(step, words);
    pending = [];
  };
  for (const segment of segments) {
    if ("text" in segment) {
      if (segment.text.trim()) settle(segment.text.trim());
      continue;
    }
    for (const step of segment.steps) {
      const note = typeof step.note === "string" ? step.note.trim() : "";
      if (note) settle(note);
      pending.push(step);
    }
  }
  return after;
}

/**
 * An earlier reply that used tools, replayed as the turn it was: the bot's text and its calls,
 * with the arguments they were made with, as assistant messages, each call followed by the start
 * of what it returned. Ids and content are a pure function of the stored message, so replay
 * stays stable for prompt caching.
 */
function replayedToolReply(
  m: HistoryEntry,
  segments: NonNullable<HistoryEntry["segments"]>,
  common: HistoryCommon,
  offered: ReadonlySet<string>,
): HistoryMessage[] {
  const idPrefix = `h${createHash("sha256")
    .update(m.id ?? `${m.createdAt ?? ""}:${m.content}`)
    .digest("hex")
    .slice(0, 16)}`;
  const shown = new Set(replayedSteps(segments));
  const wordsAfter = wordsAfterSteps(segments);
  // The run hydrates at most the most recent kept screenshot; it goes back on the call that took it.
  const screenshot = toPiImages(m.images)[0];
  const lastImageCall = [...segments]
    .flatMap((segment) => ("steps" in segment ? segment.steps : []))
    .flatMap((step) => step.calls ?? [])
    .findLast((call) => call.image);
  const messages: HistoryMessage[] = [];
  const assistant = (
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
  ) =>
    messages.push({
      role: "assistant",
      content,
      ...HISTORY_ASSISTANT,
      usage: NO_USAGE,
      stopReason,
      ...common,
    });
  let text = "";
  let calls = 0;
  for (const segment of segments) {
    if ("text" in segment) {
      if (segment.text.trim()) text = text ? `${text}\n\n${segment.text}` : segment.text;
      continue;
    }
    for (const step of segment.steps) {
      if (!shown.has(step)) continue;
      const note = typeof step.note === "string" ? step.note.trim() : "";
      const said = [
        text,
        note.length > REPLAYED_NOTE_MAX_CHARS ? `${note.slice(0, REPLAYED_NOTE_MAX_CHARS)}…` : note,
      ]
        .filter(Boolean)
        .join("\n\n");
      text = "";
      const name = replayedToolName(step.tool!);
      const kept = (step.calls ?? []).slice(0, TOOL_STEP_CALLS_KEPT - calls);
      const toolCalls: ToolCall[] = kept.map((call) => ({
        type: "toolCall",
        id: `${idPrefix}_${calls++}`,
        name,
        arguments: replayedArguments(call.arguments),
      }));
      assistant(
        [...(said ? [{ type: "text" as const, text: said }] : []), ...toolCalls],
        "toolUse",
      );
      for (const [index, call] of toolCalls.entries()) {
        const stored = kept[index]!;
        const result = replayedResult(step, stored, wordsAfter.get(step) ?? "");
        const seen = screenshot && stored === lastImageCall;
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: name,
          content: [
            {
              type: "text",
              // Without this a model reads a call to a tool it no longer has as one it never made.
              text: `${
                seen
                  ? (stored.result ?? "").replace(IMAGE_NOT_KEPT, "[the screenshot you took:]")
                  : result.text
              }${offered.has(name) ? "" : `\n[${name} is not available to you now.]`}`,
            },
            ...(seen ? [screenshot] : []),
          ],
          isError: result.isError,
          ...common,
        });
      }
    }
  }
  if (text) assistant([{ type: "text", text }], "stop");
  return messages;
}

/** What the model reads for a message by someone other than this bot or the human of a direct chat. */
export function speakerText(speaker: string, text: string): string {
  return `[${speaker}]: ${neutralizeSpeakerLabels(text)}`;
}

/**
 * Replays stored messages with their real roles. This bot's own replies are assistant turns,
 * with any tool steps as tool calls and results when `toolCalls` is set;
 * a message with a `speaker` (another bot, or the human in a group) is a user turn that starts
 * with "[speaker]: ". A system line (a stop or expiry note) is a user turn that starts with
 * "System note: ". These labels exist only here: they are never stored or shown in the app.
 * Content is a pure function of the message, so replayed history is stable for prompt caching.
 */
export function toHistory(
  history: AgentRunRequest["history"],
  prompt: string,
  sourceMessageId?: string | null,
  /**
   * The tools this run offers, by the name the model calls them. Earlier tool steps replay as
   * tool calls only when there are some: some providers reject calls in a request without tools.
   */
  offered: ReadonlySet<string> = new Set(),
): HistoryMessage[] {
  let duplicatePromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message?.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.content === prompt)
    ) {
      duplicatePromptIndex = index;
      break;
    }
  }
  const prior =
    duplicatePromptIndex < 0
      ? history
      : history.filter((_, index) => index !== duplicatePromptIndex);
  return prior.flatMap((m): HistoryMessage[] => {
    const created = m.createdAt ? Date.parse(m.createdAt) : Number.NaN;
    const common = {
      timestamp: Number.isNaN(created) ? 0 : created,
      rakazoHistory: true as const,
      rakazoMessageId: m.id,
      rakazoCreatedAt: m.createdAt,
    };
    if (m.role === "assistant" && !m.speaker) {
      if (offered.size > 0 && m.segments && replaysAsToolCalls(m.segments))
        return replayedToolReply(m, m.segments, common, offered);
      // A reply whose blocks render to nothing has no text to replay.
      if (!m.content.trim()) return [];
      return [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: m.content }],
          ...HISTORY_ASSISTANT,
          usage: NO_USAGE,
          stopReason: "stop" as const,
          ...common,
        },
      ];
    }
    if (m.role === "system" && !m.content.trim()) return [];
    const text =
      m.role === "system"
        ? `System note: ${neutralizeSpeakerLabels(m.content)}`
        : m.speaker
          ? speakerText(m.speaker, m.content)
          : m.content;
    // Pictures ride on the human's turn only, never on a bot's.
    const images = m.role === "assistant" ? [] : toPiImages(m.images);
    return [
      {
        role: "user" as const,
        content: images.length ? [{ type: "text" as const, text }, ...images] : text,
        ...common,
      },
    ];
  });
}

/** Part of this bot's own replayed reply: its text, its tool calls or their results. */
export function isHistoryReply(message: Message | undefined): boolean {
  return (
    (message?.role === "assistant" || message?.role === "toolResult") &&
    Boolean((message as Message & { rakazoHistory?: true }).rakazoHistory)
  );
}

/**
 * Every provider needs the first message to be the user's (Bedrock rejects anything else, and
 * chat templates assume it), but a window or a trim can start on one of this bot's replies.
 * Called on each model call, so it holds whatever the context policy kept.
 */
export function withLeadingUser(context: Context): Context {
  const first = context.messages.findIndex((message) => (message.role as string) !== "system");
  if (first < 0 || context.messages[first]!.role === "user") return context;
  const start: Message = { role: "user", content: CONVERSATION_START, timestamp: 0 };
  return {
    ...context,
    messages: [...context.messages.slice(0, first), start, ...context.messages.slice(first)],
  };
}

export function withoutSteeringMessages(
  history: AgentRunRequest["history"],
  steering: AgentSteeringMessage[],
): AgentRunRequest["history"] {
  if (steering.length === 0) return history;
  const result = [...history];
  let beforeIndex = result.length - 1;
  for (let steeringIndex = steering.length - 1; steeringIndex >= 0; steeringIndex -= 1) {
    const steeringMessage = steering[steeringIndex];
    for (let index = beforeIndex; index >= 0; index -= 1) {
      const message = result[index];
      if (
        message?.role !== "user" ||
        (message.id
          ? message.id !== steeringMessage?.messageId
          : message.content !== (steeringMessage?.historyText ?? steeringMessage?.text))
      ) {
        continue;
      }
      result.splice(index, 1);
      beforeIndex = index - 1;
      break;
    }
  }
  return result;
}
