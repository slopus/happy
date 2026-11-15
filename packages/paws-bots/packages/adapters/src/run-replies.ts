import type { MessageBlock, ReplyMode } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  isBackgroundRunTrigger,
  isConversationalRun,
} from "@rakazo/core";
import { NO_RESPONSE } from "./silent-reply.js";
import { messageUserMaxLength } from "./user-progress.js";

export function longWorkProgressGuidance(maxLength = messageUserMaxLength()): string {
  return `Send progress updates only when the work will take minutes — long computer tasks or multi-step jobs — never for quick replies and never to announce that you are starting. The one exception: once you are working in a browser or on a desktop on a task that will take a few minutes, tell the person right away with message_user that it will take a while. Even then send at most a few brief updates (a sentence or two each), not one per tool call, and do not narrate routine steps. Thinking stays private. message_user is capped at ${maxLength} characters and will be silently cut off if you exceed it \u2014 never put your final answer, a report, or any long-form deliverable in it. Always put the complete final answer in your normal reply, never split across message_user calls, and never assume a message_user update already delivered your content.`;
}

export function messagesModeReplyGuidance(maxLength = messageUserMaxLength()): string {
  return `Text you write while working is private and never shown to the person. To tell them anything before your final answer, such as what you are starting on, something important you found, or a question, call message_user with one or two short sentences (at most ${maxLength} characters). Your final answer, the text you write after your last tool call, is shown. Put the complete answer there, never in message_user.`;
}

export const ROUTINE_SILENT_REPLY_GUIDANCE = `If this routine's prompt says to stay silent when there is nothing to report, the entire final assistant reply must be exactly ${NO_RESPONSE} — no surrounding prose, no variants, no progress updates, no all-clear, and no meta note that you are staying silent. Do not call message_user unless you have something to report.`;

export const REACTION_SILENT_REPLY_GUIDANCE = `The user reacted with an emoji to your message. Reply only if the reaction calls for it, such as a correction after 👎, a go-ahead on something you proposed, or a question. Otherwise the entire final assistant reply must be exactly ${NO_RESPONSE}, with no message_user call.`;

export const GROUP_UNADDRESSED_REPLY_GUIDANCE = `This message went to every member of the group and names nobody. Members decide at about the same time, so do not count on seeing the others' replies. Before using any tools, decide whether it is for you. Answer when it falls within your own description, or when it asks each member to reply. Stay silent when it fits another member's description better, or when no member's description fits it and you are not the first member listed. To stay silent, the entire final assistant reply must be exactly ${NO_RESPONSE}, with no tool calls, never a dot, a placeholder or an empty message.`;

export function runAllowsSilentEmpty(trigger: string): boolean {
  return trigger === "reaction" || trigger === "routine" || isBackgroundRunTrigger(trigger);
}

/**
 * Whether text written before a tool call may become a durable mid-turn chat bubble.
 * Routine and bot-to-bot runs hold it back, using the last segment as the final reply
 * only when the model supplies none and has not explicitly chosen silence.
 * Background runs never promote it.
 */
export function runPromotesMidTurnNarration(trigger: string): boolean {
  return trigger !== "routine" && trigger !== "bot_message" && !isBackgroundRunTrigger(trigger);
}

export const TICKET_SILENT_REPLY_GUIDANCE =
  "Ticket work is reported on the board, not in chat. Put updates and results in ticket_comment and keep the ticket status current with ticket_update. Use the existing ask or approval mechanism when user input is needed. Leave the final reply empty.";

/**
 * Messages mode only where a person waits on the reply and the bot can message them; every
 * other run keeps chat mode. A background helper cannot message anyone: its result goes back
 * to the bot.
 */
export function runReplyMode(
  trigger: string,
  botReplyMode: string,
  disabled?: ReadonlySet<string>,
): ReplyMode {
  return botReplyMode === "messages" &&
    isConversationalRun(trigger) &&
    trigger !== "bot_message" &&
    trigger !== BACKGROUND_HELPER_TRIGGER &&
    !runAllowsSilentEmpty(trigger) &&
    !disabled?.has("message_user")
    ? "messages"
    : "chat";
}

export function runReplyGuidance(trigger: string, replyMode: ReplyMode = "chat"): string {
  if (replyMode === "messages") return messagesModeReplyGuidance();
  if (trigger === "reaction") return REACTION_SILENT_REPLY_GUIDANCE;
  if (isBackgroundRunTrigger(trigger)) return TICKET_SILENT_REPLY_GUIDANCE;
  return runAllowsSilentEmpty(trigger) ? ROUTINE_SILENT_REPLY_GUIDANCE : longWorkProgressGuidance();
}

export function replyGuidanceForOfferedTools(
  guidance: string,
  disabled?: ReadonlySet<string>,
): string | undefined {
  if (!disabled?.has("message_user")) return guidance;
  if (guidance === longWorkProgressGuidance()) {
    return "Always put the complete final answer in your normal reply.";
  }
  if (guidance === REACTION_SILENT_REPLY_GUIDANCE) {
    return guidance.replace(", with no message_user call.", ".");
  }
  if (guidance === ROUTINE_SILENT_REPLY_GUIDANCE) {
    return guidance.replace(" Do not call message_user unless you have something to report.", "");
  }
  return guidance.includes("message_user") ? undefined : guidance;
}

export const DELEGATED_EMPTY_NOTICE =
  "The delegated bot completed its turn without a written summary.";

/** Failure used when a tool-bearing turn would otherwise complete as the empty notice. */
export const TOOL_STEPS_WITHOUT_RESPONSE =
  "The model finished its tool steps without a written response.";

/** The message's text blocks joined, untrimmed. */
export function messageBlocksText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

/** True when the only written completion is the empty delegated notice after tool steps. */
export function emptyDelegatedToolTurnShouldFail(blocks: MessageBlock[]): boolean {
  const text = messageBlocksText(blocks).trim();
  return text === DELEGATED_EMPTY_NOTICE && blocks.some((block) => block.kind === "steps");
}

export function completionMessageSegments(
  segments: MessageBlock[],
  options?: {
    allowSilentEmpty?: boolean;
    emptyResponseText?: string;
    suppressOutput?: boolean;
    skipEmptyFallback?: boolean;
  },
): MessageBlock[] {
  if (options?.suppressOutput) return [];
  const fallback = options?.emptyResponseText?.trim() || "done.";
  if (segments.length > 0) {
    if (
      !options?.allowSilentEmpty &&
      options?.emptyResponseText !== undefined &&
      !segments.some((segment) => segment.kind === "text" && segment.text)
    ) {
      return [...segments, { kind: "text", text: fallback }];
    }
    return segments;
  }
  if (options?.allowSilentEmpty || options?.skipEmptyFallback) return [];
  return [{ kind: "text", text: fallback }];
}
