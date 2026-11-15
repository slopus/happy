export type ThreadScrollState = {
  detached: boolean;
  unread: boolean;
};

export function reconcileThreadScrollState(
  previous: ThreadScrollState,
  next: ThreadScrollState,
): ThreadScrollState {
  return previous.detached === next.detached && previous.unread === next.unread ? previous : next;
}
