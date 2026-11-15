import type { MessageBlock } from "@rakazo/contracts";
import { isQuestionAskBlock } from "./ask-replies.js";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "./thread-message-updates.js";

/** What a chat app adds to a pending question it cannot show as a card. */
export const CHAT_APP_ASK_NOTE = "(Answer in the app.)";

/**
 * How a still-pending question reads in a 1:1 chat app, which cannot show cards: the question,
 * its detail, and its options numbered in order, then where to answer it. Any other request, such
 * as an approval, a secret or an instruction change, keeps to its title: only its card can answer
 * it, and its detail can hold a command, a diff or tool input. An answered one adds nothing.
 */
export function chatAppAskText(block: MessageBlock): string | undefined {
  if (block.kind !== "ask" || block.status === "answered") return undefined;
  const lines = isQuestionAskBlock(block)
    ? [
        block.detail?.trim(),
        ...(block.actions ?? []).map((action, index) => `${index + 1}. ${action.label}`),
      ]
    : [];
  return [block.text.trim(), ...lines, CHAT_APP_ASK_NOTE].filter(Boolean).join("\n");
}

/** What a chat app adds to a request to take over the bot's computer screen. */
export const CHAT_APP_TAKEOVER_NOTE = "(Take over the screen in the app.)";

/**
 * A pending takeover request in a 1:1 chat app. The screen can only be used in the app, so the
 * line says what is asked and where to do it.
 */
export function chatAppTakeoverText(block: {
  kind: string;
  state?: string;
  text?: string;
}): string | undefined {
  if (block.kind !== "computer" || block.state !== TAKEOVER_COMPUTER_PENDING_STATE)
    return undefined;
  return [block.text?.trim(), CHAT_APP_TAKEOVER_NOTE].filter(Boolean).join("\n");
}
