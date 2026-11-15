import type { MessageBlock } from "@rakazo/contracts";
import { newestPageCards, pageCardSuperseded } from "@rakazo/core";

export type PageBlock = Extract<MessageBlock, { kind: "page" }>;

/** Page-only bot messages fold under the same bot's next reply, which introduces them. */
export function projectPageCards<
  Message extends { id: string; role: string; botId?: string; blocks: MessageBlock[] },
>(messages: readonly Message[]) {
  const pages = new Map<string, PageBlock[]>();
  const foldedInto = new Map<string, string>();
  messages.forEach((message, index) => {
    if (
      message.role !== "bot" ||
      message.blocks.length === 0 ||
      !message.blocks.every((block) => block.kind === "page")
    )
      return;
    for (const next of messages.slice(index + 1)) {
      if (next.role !== "bot" || next.botId !== message.botId) return;
      if (!next.blocks.some((block) => block.kind === "text")) continue;
      pages.set(next.id, [...(pages.get(next.id) ?? []), ...(message.blocks as PageBlock[])]);
      foldedInto.set(message.id, next.id);
      return;
    }
  });
  const lastCard = newestPageCards(messages, (id) => foldedInto.get(id) ?? id);
  return {
    visibleMessages: messages.filter((message) => !foldedInto.has(message.id)),
    pages,
    foldedInto,
    /** Changes only when a card becomes the newest one for its page. */
    cardsKey: [...lastCard].join(" "),
    /** Whether a later card in this thread shows the same page. */
    isSuperseded: (messageId: string, block: PageBlock) =>
      pageCardSuperseded(lastCard, messageId, block),
  };
}

/** The tallest frame a page may ask for. */
const MAX_PAGE_HEIGHT = 200_000;

/** A height a page reported, kept to a sane range whatever the page sends. */
export function pageFrameHeight(height: number): number {
  return Number.isFinite(height) ? Math.min(Math.max(height, 0), MAX_PAGE_HEIGHT) : 0;
}
