interface MessageIdentity {
  id: string;
  seq?: number;
}

export interface ThreadHistory<TMessage extends MessageIdentity> {
  threadId: string;
  messages: readonly TMessage[];
  olderCursor: number | null;
}

export function mergeThreadHistory<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, recent: TSnapshot, preserveLoadedHistory = false): TSnapshot {
  if (!previous || previous.threadId !== recent.threadId || !preserveLoadedHistory) return recent;
  return {
    ...recent,
    messages: mergeMessagePages(previous.messages, recent.messages),
    olderCursor: previous.olderCursor,
  };
}

export function prependThreadHistoryPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, page: ThreadHistory<TMessage>): TSnapshot | null {
  if (!previous || previous.threadId !== page.threadId || previous.olderCursor == null) {
    return previous;
  }
  return {
    ...previous,
    messages: mergeMessagesById(page.messages, previous.messages),
    olderCursor: page.olderCursor,
  };
}

export interface ThreadWindow<TSnapshot> {
  snapshot: TSnapshot;
  /**
   * Newest seq read contiguously from the opened page. Newer messages in the snapshot come from
   * the latest page or live events and stay hidden (threadWindowMessages) until paging forward
   * reaches them, so the transcript never shows a gap. null: history runs through to the latest.
   */
  newerCursor: number | null;
}

/** Open a thread at an older page while keeping the latest page and live events beside it. */
export function openThreadWindow<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(latest: TSnapshot, page: ThreadHistory<TMessage>): ThreadWindow<TSnapshot> {
  if (latest.threadId !== page.threadId) return { snapshot: latest, newerCursor: null };
  const messages = mergeMessagesBySeq(latest.messages, page.messages);
  return {
    snapshot: { ...latest, messages, olderCursor: page.olderCursor },
    newerCursor: newerGapCursor(messages, newestSeq(page.messages)),
  };
}

export function forwardProbeAfterPage(input: {
  probe: number;
  newerCursor: number;
  nextCursor: number | null;
  reportedCoverage: number | null;
  carriedCoverage?: number;
}): { probe?: number; coverage?: number; stalled: boolean } {
  const coverage =
    input.reportedCoverage == null
      ? undefined
      : Math.max(input.carriedCoverage ?? input.reportedCoverage, input.reportedCoverage);
  if (input.nextCursor == null) return { coverage, stalled: false };
  const advanced = input.nextCursor !== input.newerCursor;
  const nextProbe =
    input.reportedCoverage != null && coverage != null
      ? coverage + 1
      : advanced
        ? input.nextCursor + 1
        : input.probe;
  if (!advanced && nextProbe <= input.probe) return { coverage, stalled: true };
  return { probe: nextProbe, coverage, stalled: false };
}

/** Add the next around page. `coveredThroughSeq` is the highest seq that page read. */
export function appendNewerThreadPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(
  snapshot: TSnapshot,
  newerCursor: number,
  page: ThreadHistory<TMessage>,
  coveredThroughSeq?: number | null,
): ThreadWindow<TSnapshot> {
  if (snapshot.threadId !== page.threadId) return { snapshot, newerCursor };
  const newest = newestSeq(page.messages);
  const messages =
    newest !== null && newest > newerCursor
      ? mergeMessagesBySeq(snapshot.messages, page.messages)
      : snapshot.messages;
  const covered = coveredThroughSeq ?? overlappingPageCoverage(page, newerCursor);
  const cursor = forwardCursor(messages, newerCursor, covered);
  if (messages === snapshot.messages && cursor === newerCursor) return { snapshot, newerCursor };
  return {
    snapshot: messages === snapshot.messages ? snapshot : { ...snapshot, messages },
    newerCursor: cursor,
  };
}

export function threadWindowMessages<T extends MessageIdentity>(
  messages: readonly T[],
  newerCursor: number | null,
): readonly T[] {
  if (newerCursor === null) return messages;
  return messages.filter((message) => isWindowMessage(message, newerCursor));
}

/** Leave the window for the latest messages; older history pages back in from there. */
export function leaveThreadWindow<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(snapshot: TSnapshot, newerCursor: number | null): TSnapshot {
  if (newerCursor === null) return snapshot;
  const messages = snapshot.messages.filter((message) => !isWindowMessage(message, newerCursor));
  return {
    ...snapshot,
    messages,
    olderCursor: oldestSeq(messages) ?? newerCursor + 1,
  };
}

function isWindowMessage(message: MessageIdentity, newerCursor: number): boolean {
  return isDurableMessage(message) && typeof message.seq === "number" && message.seq <= newerCursor;
}

function forwardCursor(
  messages: readonly MessageIdentity[],
  newerCursor: number,
  coveredThroughSeq: number | null,
): number | null {
  const present = new Set<number>();
  let maxSeq = newerCursor;
  for (const message of messages) {
    if (!isDurableMessage(message) || typeof message.seq !== "number") continue;
    present.add(message.seq);
    if (message.seq > maxSeq) maxSeq = message.seq;
  }
  let cursor = newerCursor;
  let scan = newerCursor;
  while (scan < maxSeq) {
    const next = scan + 1;
    if (present.has(next)) {
      scan = next;
      cursor = next;
      continue;
    }
    if (coveredThroughSeq !== null && next <= coveredThroughSeq) {
      scan = next;
      continue;
    }
    break;
  }
  return scan >= maxSeq ? null : cursor;
}

function newerGapCursor(messages: readonly MessageIdentity[], loadedThrough: number | null) {
  if (loadedThrough === null) return null;
  const next = oldestSeq(
    messages.filter((message) => typeof message.seq === "number" && message.seq > loadedThrough),
  );
  return next !== null && next > loadedThrough + 1 ? loadedThrough : null;
}

function overlappingPageCoverage(
  page: ThreadHistory<MessageIdentity>,
  newerCursor: number,
): number | null {
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const message of page.messages) {
    if (!isDurableMessage(message) || typeof message.seq !== "number") continue;
    if (oldest === null || message.seq < oldest) oldest = message.seq;
    if (newest === null || message.seq > newest) newest = message.seq;
  }
  if (newest === null || oldest === null || newest <= newerCursor || oldest > newerCursor + 1) {
    return null;
  }
  return newest;
}

function newestSeq(messages: readonly MessageIdentity[]): number | null {
  return messages.reduce<number | null>(
    (newest, message) =>
      isDurableMessage(message) && typeof message.seq === "number"
        ? Math.max(newest ?? message.seq, message.seq)
        : newest,
    null,
  );
}

function oldestSeq(messages: readonly MessageIdentity[]): number | null {
  return messages.reduce<number | null>(
    (oldest, message) =>
      isDurableMessage(message) && typeof message.seq === "number"
        ? Math.min(oldest ?? message.seq, message.seq)
        : oldest,
    null,
  );
}

/** Union by id (incoming wins), ordered by seq; live messages without a seq stay last. */
function mergeMessagesBySeq<T extends MessageIdentity>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const merged = [...current.filter((message) => !incomingIds.has(message.id)), ...incoming];
  return [
    ...merged
      .filter((message) => typeof message.seq === "number")
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    ...merged.filter((message) => typeof message.seq !== "number"),
  ];
}

export function mergeMessagePages<T extends MessageIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const firstRecentSeq = recent.reduce<number | null>((first, message) => {
    if (!isDurableMessage(message) || typeof message.seq !== "number") return first;
    return Math.min(first ?? message.seq, message.seq);
  }, null);
  const retained =
    firstRecentSeq === null
      ? []
      : previous.filter(
          (message) =>
            isDurableMessage(message) &&
            typeof message.seq === "number" &&
            message.seq < firstRecentSeq,
        );
  return mergeMessagesById(retained, recent);
}

export function mergeMessagesById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function upsertMessageById<T extends { id: string }>(messages: readonly T[], next: T): T[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function isDurableMessage(message: { id: string }): boolean {
  return !message.id.startsWith("progress:") && !message.id.startsWith("subagent:");
}
