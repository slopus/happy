export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

export function transcriptCanSnapAfterFrame(
  element: Pick<HTMLElement, "scrollTop"> | null,
  queuedElement: Pick<HTMLElement, "scrollTop">,
  queuedScrollTop: number,
): boolean {
  return element === queuedElement && queuedElement.scrollTop === queuedScrollTop;
}

export function transcriptMovedDown(previousScrollTop: number | null, scrollTop: number): boolean {
  return previousScrollTop !== null && scrollTop >= previousScrollTop;
}

/**
 * The first message row at or below the scroll position: the anchor a prepend
 * must hold steady. Content appended at the bottom moves no row, so anchoring
 * on the row keeps the adjustment free of that growth.
 */
export function firstVisibleTranscriptRow(
  element: Pick<HTMLElement, "querySelectorAll" | "scrollTop"> | null,
): HTMLElement | null {
  if (!element) return null;
  for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (row.offsetTop + row.offsetHeight > element.scrollTop) return row;
  }
  return null;
}
