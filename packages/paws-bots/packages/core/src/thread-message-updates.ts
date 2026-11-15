import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";

/** Computer-card state while a takeover is still waiting on the user. */
export const TAKEOVER_COMPUTER_PENDING_STATE = "Needs you";

/** Computer-card state after the user hands the computer back. */
export const TAKEOVER_COMPUTER_DONE_STATE = "Done";

/** Computer-card state after a takeover is skipped or expires. */
export const TAKEOVER_COMPUTER_SKIPPED_STATE = "Skipped";

export type TakeoverComputerSettledState =
  | typeof TAKEOVER_COMPUTER_DONE_STATE
  | typeof TAKEOVER_COMPUTER_SKIPPED_STATE;

/** Done when control returns, Skipped when the takeover ended unfinished. */
export function takeoverComputerSettledState(reason: unknown): TakeoverComputerSettledState {
  if (reason === "skipped" || reason === "expired" || reason === "takeover-skipped") {
    return TAKEOVER_COMPUTER_SKIPPED_STATE;
  }
  return TAKEOVER_COMPUTER_DONE_STATE;
}

/**
 * Settle pending takeover computer cards. Returns null when none are pending,
 * so a second release or resume does not write the message again.
 */
export function releasedTakeoverComputerBlocks(
  blocks: readonly MessageBlock[],
  reason: unknown,
): MessageBlock[] | null {
  const state = takeoverComputerSettledState(reason);
  let changed = false;
  const next = blocks.map((block) => {
    if (block.kind !== "computer" || block.state !== TAKEOVER_COMPUTER_PENDING_STATE) return block;
    changed = true;
    return { ...block, state };
  });
  return changed ? next : null;
}

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}

export function updateCloudAgentMessages<Message extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const agentId = String(payload.agentId ?? "");
  const messageId = String(payload.messageId ?? "");
  const block = cloudAgentBlockFromPayload(payload);
  return messages.map((message) => {
    if (
      (messageId && message.id === messageId) ||
      message.blocks.some(
        (existing) => existing.kind === "cloud_agent" && existing.agentId === agentId,
      )
    ) {
      return {
        ...message,
        blocks: message.blocks.map((existing) =>
          existing.kind === "cloud_agent" && existing.agentId === agentId ? block : existing,
        ),
      };
    }
    return message;
  });
}
