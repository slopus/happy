import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

/**
 * Keep mid-turn progress beats short; prefer a few high-signal updates. Mid-turn
 * narration always uses this cap; message_user uses messageUserMaxLength().
 */
export const USER_PROGRESS_MESSAGE_MAX_LENGTH = 500;

/** Durable interim chat messages wait until a turn is genuinely long. */
export const MID_TURN_PROGRESS_MIN_TURN_AGE_MS = 60_000;

/** A note shown as the working line instead of a message is cut to this length. */
export const NARRATION_STATUS_MAX_LENGTH = 60;

/** One short line for the working indicator: whitespace collapsed, cut with "…". */
export function narrationStatusLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= NARRATION_STATUS_MAX_LENGTH
    ? line
    : `${line.slice(0, NARRATION_STATUS_MAX_LENGTH).trimEnd()}…`;
}

/**
 * How a message the person sends while the bot works reaches the model: it knows the message
 * came mid-task. The answer goes through message_user, because a plain-text answer ends the
 * turn and the task with it; without that tool it is only asked to take the message into account.
 */
export function midTaskMessagePrompt(text: string, canMessageUser: boolean): string {
  const next = canMessageUser
    ? "If it asks something or changes the plan, answer briefly with message_user, then continue the task."
    : "Take it into account and continue the task.";
  return `The person sent this while you were working:\n\n${text}\n\n${next}`;
}

const MID_TASK_SOURCES = {
  member: "another member of this chat",
  messaging: "a connected chat",
  webhook: "a webhook",
} as const;

/** A message from anyone else arrives labelled with where it came from, with no call to reply. */
export function midTaskMessageFromPrompt(
  text: string,
  origin: keyof typeof MID_TASK_SOURCES | undefined,
): string {
  return `A message arrived from ${MID_TASK_SOURCES[origin ?? "member"]} while you were working:\n\n${text}`;
}

/** A mid-task message from the run's person restarts the interim budget at most this often. */
export const STEERING_RESETS_MAX_PER_RUN = 3;
export const STEERING_RESET_MIN_GAP_MS = 60_000;

/** Cap on durable interim chat messages (message_user + promoted narration) per run. */
export const MID_TURN_PROGRESS_MAX_PER_RUN = 3;

/**
 * Whether the run may post another durable interim chat message right now.
 * Short turns stay silent in durable chat; long turns keep a few replyable
 * beats without flooding the thread.
 */
export function midTurnProgressBudgetAllows(publishedCount: number, turnAgeMs: number): boolean {
  return (
    !midTurnProgressBudgetUsed(publishedCount) && turnAgeMs >= MID_TURN_PROGRESS_MIN_TURN_AGE_MS
  );
}

/** Whether the run has posted every durable interim message it may, however long it runs. */
export function midTurnProgressBudgetUsed(publishedCount: number): boolean {
  return publishedCount >= MID_TURN_PROGRESS_MAX_PER_RUN;
}

/**
 * The message_user cap: `RAKAZO_MESSAGE_USER_MAX_CHARS` when it is a positive integer,
 * else USER_PROGRESS_MESSAGE_MAX_LENGTH.
 */
export function messageUserMaxLength(): number {
  const value = process.env.RAKAZO_MESSAGE_USER_MAX_CHARS?.trim();
  if (!value || !/^\d+$/.test(value)) return USER_PROGRESS_MESSAGE_MAX_LENGTH;
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : USER_PROGRESS_MESSAGE_MAX_LENGTH;
}

export function clampUserProgressMessage(
  text: string,
  maxLength = USER_PROGRESS_MESSAGE_MAX_LENGTH,
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * True when the raw text a caller tried to post as a mid-turn progress update
 * would not fit and got cut off by clampUserProgressMessage. Callers should
 * surface this back to the model (it gets no other signal that its message
 * was mangled) rather than reporting a silent success.
 */
export function isProgressMessageTruncated(
  text: string,
  maxLength = USER_PROGRESS_MESSAGE_MAX_LENGTH,
): boolean {
  return text.trim().length > maxLength;
}

/**
 * Text to put between the text of two assistant turns that end up in one reply,
 * so they do not run together ("…/drafts/42Nothing has changed…").
 * Empty when there is no earlier text or either side already has whitespace.
 */
export function assistantTurnSeparator(previous: string, next: string): string {
  if (!previous || !next) return "";
  if (/\s$/.test(previous) || /^\s/.test(next)) return "";
  return "\n\n";
}

/** clientNonce prefix for mid-turn progress messages (reconciler uses this). */
export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function userProgressClientNonce(runId: string, index = 0): string {
  // Include entropy so a resumed executor turn cannot reuse an earlier nonce
  // (threadId + clientNonce is unique).
  return `${USER_PROGRESS_CLIENT_NONCE_PREFIX}${runId}:${index}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

export function extractNarrationText(
  segments: readonly MessageBlock[],
  currentText: string,
): { text: string; remaining: MessageBlock[] } {
  const parts: string[] = [];
  const remaining: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    remaining.push(block);
  }
  if (currentText) parts.push(currentText);
  return { text: parts.join(""), remaining };
}

/**
 * After mid-turn progress messages were already posted, skip a hollow final
 * message that would only carry hidden tool-activity blocks (or nothing).
 */
export function finalBlocksAfterMidTurnProgress(
  blocks: MessageBlock[],
  publishedMidTurn: boolean,
): MessageBlock[] {
  if (!publishedMidTurn || blocks.length === 0) return blocks;
  if (blocks.every((block) => isToolActivityBlock(block))) return [];
  return blocks;
}

/** Outcome to return for a bot_message run after mid-turn progress posts. */
export function botMessageOutcomeFromMidTurn(
  finalText: string,
  midTurnTexts: readonly string[],
): { text: string; intent: "result" | "status" } | null {
  const trimmed = finalText.trim();
  if (trimmed) return { text: trimmed, intent: "result" };
  const midTurn = midTurnTexts.map((part) => part.trim()).filter(Boolean);
  if (midTurn.length === 0) return null;
  return { text: midTurn.join("\n\n"), intent: "status" };
}
