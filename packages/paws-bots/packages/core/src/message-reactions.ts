import type { MessageBlock, MessageReaction } from "@rakazo/contracts";
import { MessageReactionSchema } from "@rakazo/contracts";

type ReactionMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
  replyToMessageId?: string | null;
};

/** Emoji-only user replies are conversation messages displayed compactly beneath their target. */
export function messageReaction(
  message: Pick<ReactionMessage, "role" | "blocks" | "replyToMessageId">,
): MessageReaction | null {
  if (message.role !== "user" || !message.replyToMessageId || message.blocks.length !== 1)
    return null;
  const block = message.blocks[0];
  return block?.kind === "text" ? (MessageReactionSchema.safeParse(block.text).data ?? null) : null;
}

export function projectMessageReactions<Message extends ReactionMessage>(
  messages: readonly Message[],
) {
  const parents = new Map(messages.map((message) => [message.id, message]));
  const answerMessageIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "ask" && block.status === "answered" && block.answerMessageId) {
        answerMessageIds.add(block.answerMessageId);
      }
    }
  }
  const reactions = new Map<string, Map<MessageReaction, number>>();
  const visibleMessages = messages.filter((message) => {
    // A linked answer belongs in its own bubble even when it consists of one emoji.
    if (answerMessageIds.has(message.id)) return true;
    const emoji = messageReaction(message);
    const parentId = message.replyToMessageId;
    const parent = parentId ? parents.get(parentId) : undefined;
    // Keep an ordinary reply bubble when the parent is outside the loaded page, so it can be opened.
    if (
      !emoji ||
      !parentId ||
      !parent ||
      (messageReaction(parent) && !answerMessageIds.has(parent.id)) ||
      parentId === message.id
    )
      return true;
    const counts = reactions.get(parentId) ?? new Map<MessageReaction, number>();
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    reactions.set(parentId, counts);
    return false;
  });
  return { visibleMessages, reactions };
}
