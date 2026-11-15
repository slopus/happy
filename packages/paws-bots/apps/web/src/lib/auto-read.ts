/**
 * Whether an automatic read that waited in its chat's queue should still mark the chat read:
 * the user is on the same visit, with the window shown and focused. Bot and group chats share
 * it, so a reply that arrived after the user left or switched windows stays unread.
 */
export function autoReadStillWanted(
  openVisit: number,
  visit: number,
  page: Pick<Document, "visibilityState" | "hasFocus"> = document,
): boolean {
  return openVisit === visit && page.visibilityState === "visible" && page.hasFocus();
}
