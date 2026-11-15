import type { ThreadMessage } from "@rakazo/contracts";
import { truncateReplyQuote } from "@rakazo/contracts";

/**
 * Resolves a text selection to the message it quotes. A quote stays scoped to
 * one Markdown text region; selections that cross regions or include message
 * chrome and structured cards get no affordance. The excerpt is capped at
 * capture so an oversized selection never fails the send.
 */
export function quoteDraftForSelection(
  selection: {
    startContent: Pick<HTMLElement, "dataset"> | null;
    endContent: Pick<HTMLElement, "dataset"> | null;
    text: string;
  },
  messageById: ReadonlyMap<string, ThreadMessage>,
): { message: ThreadMessage; text: string } | null {
  const { startContent, endContent } = selection;
  const message =
    startContent && startContent === endContent
      ? messageById.get(startContent.dataset.quoteMessageId ?? "")
      : undefined;
  const text = truncateReplyQuote(selection.text.trim());
  if (!message || !text) return null;
  return { message, text };
}

/**
 * The last text a range actually covers. A triple-click selects a paragraph by
 * ending the range at offset 0 of whatever follows it — the next message, or
 * the composer when it is the latest — so the end container misplaces it.
 * Trailing chrome between the two (icon buttons, empty announcers) has no text.
 */
export function lastSelectedText(range: Range): Node {
  const { endContainer, endOffset, commonAncestorContainer } = range;
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset > 0) return endContainer;
  const walker = document.createTreeWalker(commonAncestorContainer, NodeFilter.SHOW_TEXT);
  const after =
    endContainer.nodeType === Node.TEXT_NODE ? null : endContainer.childNodes[endOffset];
  if (after) {
    walker.currentNode = after;
  } else if (endContainer.nodeType === Node.TEXT_NODE) {
    walker.currentNode = endContainer;
  } else {
    let last: Node = endContainer;
    while (last.lastChild) last = last.lastChild;
    if (last.nodeType === Node.TEXT_NODE && last.textContent?.trim()) return last;
    walker.currentNode = last;
  }
  for (let node = walker.previousNode(); node; node = walker.previousNode()) {
    if (!range.intersectsNode(node)) break;
    if (node.textContent?.trim()) return node;
  }
  return endContainer;
}

/** A range the page no longer shows: collapsed by an edit, or left outside the document. */
export function isDetachedRange(range: Range): boolean {
  return range.collapsed || !document.contains(range.commonAncestorContainer);
}
