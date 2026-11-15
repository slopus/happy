import { requestDeadline, withAbort } from "./async.js";

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage<T> = {
  messages: readonly T[];
  olderCursor: number | null;
};

/** Load every page, with bounded requests and cancellation on web and native runtimes. */
export async function loadPeerHistory<T>({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: number | undefined, signal: AbortSignal) => Promise<PeerHistoryPage<T>>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<T[]> {
  const total = requestDeadline(totalTimeoutMs, "Peer history timed out.", signal);
  const collected: (readonly T[])[] = [];
  let before: number | undefined;
  try {
    do {
      const page = requestDeadline(pageTimeoutMs, "Peer history page timed out.", total.signal);
      try {
        if (page.signal.aborted) throw page.signal.reason;
        const result = await withAbort(loadPage(before, page.signal), page.signal);
        collected.push(result.messages);
        before = result.olderCursor ?? undefined;
      } finally {
        page.dispose();
      }
    } while (before !== undefined);
    return collected.reverse().flat();
  } finally {
    total.dispose();
  }
}
