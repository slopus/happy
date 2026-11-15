import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "./tool-activity.js";

export type ChildBotBlock = Extract<MessageBlock, { kind: "child_bot" }>;

type MentionMessage = { id: string; role: string; botId?: string; blocks: MessageBlock[] };

function isProse(block: MessageBlock): boolean {
  return (block.kind === "text" || block.kind === "progress") && !isToolActivityBlock(block);
}

/**
 * A message that only announces new bots it created folds into the same bot's next reply, which names
 * them inline. Announcements with no later reply yet stay visible on their own.
 */
export function projectBotMentions<Message extends MentionMessage>(messages: readonly Message[]) {
  const mentions = new Map<string, ChildBotBlock[]>();
  // A folded announcement's id resolves to the reply that now shows it, so quotes can still jump.
  const foldedInto = new Map<string, string>();
  messages.forEach((message, index) => {
    if (
      message.role !== "bot" ||
      message.blocks.length === 0 ||
      // Archive and delete notices keep their status, so only new bots fold into the reply.
      !message.blocks.every((block) => block.kind === "child_bot" && block.status === "created")
    )
      return;
    for (const next of messages.slice(index + 1)) {
      if (next.role !== "bot" || next.botId !== message.botId) return;
      if (!next.blocks.some(isProse)) continue;
      mentions.set(next.id, [
        ...(mentions.get(next.id) ?? []),
        ...(message.blocks as ChildBotBlock[]),
      ]);
      foldedInto.set(message.id, next.id);
      return;
    }
  });
  return {
    visibleMessages: messages.filter((message) => !foldedInto.has(message.id)),
    mentions,
    foldedInto,
  };
}
