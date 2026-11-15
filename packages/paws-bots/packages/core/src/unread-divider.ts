import type { MessageAuthor } from "@rakazo/contracts";
import { messageUnreadFor } from "./message-replies.js";

type DividerCandidate = { id: string; role: string; seq?: number; author?: MessageAuthor };

/**
 * The message the "New" divider sits above: the first message after the seq the user had read
 * up to when the chat opened that is new to them, a bot's or another member's. Their own
 * messages never start it, and it never sits above the start of the chat, where there is
 * nothing read to divide from. `olderCursor` is the seq the loaded page starts at, hidden
 * messages included (null once nothing older is left); while the first unread seq is older
 * than that, it waits. `messages` are in reading order.
 */
export function unreadDividerMessageId(
  messages: readonly DividerCandidate[],
  readUpToSeq: number | null,
  olderCursor: number | null,
  meId?: string,
): string | null {
  if (readUpToSeq === null) return null;
  if (olderCursor !== null && olderCursor > readUpToSeq + 1) return null;
  const index = messages.findIndex(
    (message) =>
      messageUnreadFor(message, meId) && message.seq !== undefined && message.seq > readUpToSeq,
  );
  if (index === -1 || (index === 0 && olderCursor === null)) return null;
  return messages[index]?.id ?? null;
}

/** A voice card gets the divider above it when any message inside it starts the unread part. */
export function voiceChatHoldsMessage(
  group: { messages: readonly { id: string }[] },
  messageId: string | null,
): boolean {
  return messageId !== null && group.messages.some((message) => message.id === messageId);
}

/**
 * Starts tasks in queue order after the prior task settles or reaches `maxWaitMs` from its
 * start. Failed tasks do not block the queue. A timeout only releases the queue; it does not
 * cancel the task or its effects.
 */
export function createSerialQueue(maxWaitMs = 10_000): <T>(task: () => Promise<T>) => Promise<T> {
  // The last queued task's settlement or timeout; null while the queue is idle.
  let tail: Promise<void> | null = null;
  return (task) => {
    const previous = tail ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    const released = previous.then(() => waitAtMost(settled, maxWaitMs));
    tail = released;
    void released.then(() => {
      if (tail === released) tail = null;
    });
    return run;
  };
}

/**
 * One serial queue per chat: reads stay in order within a chat, and a slow read in one chat
 * never holds up another's.
 */
export function createChatQueues(
  maxWaitMs = 10_000,
): <T>(chat: string, task: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>();
  return (chat, task) => {
    let queue = queues.get(chat);
    if (!queue) {
      queue = createSerialQueue(maxWaitMs);
      queues.set(chat, queue);
    }
    return queue(task);
  };
}

function waitAtMost(previous: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void previous.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** What the open chat's "New" divider follows: the first markRead answer of the visit. */
export type ReadBoundary = { visit: number; seq: number | null };

/**
 * Keeps the first markRead answer of the open visit. An answer that started in an earlier
 * visit, such as a chat the user has since left, is dropped.
 */
export function settleReadBoundary(
  current: ReadBoundary | null,
  openVisit: number,
  answer: ReadBoundary,
): ReadBoundary | null {
  if (answer.visit !== openVisit) return current;
  return current?.visit === openVisit ? current : answer;
}

/**
 * Any sent message, the user's own included, can be marked unread; the next open starts the
 * divider at the first reply from it. Live progress and subagent rows aren't stored messages.
 */
export function canMarkMessageUnread(message: { id: string }): boolean {
  return !message.id.startsWith("progress:") && !message.id.startsWith("subagent:");
}
