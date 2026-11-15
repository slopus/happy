import { listenWindow } from "../../paws/runtime";
import type { Bot, Group } from "@rakazo/contracts";
import type { ReadBoundary } from "@rakazo/core";
import { chatWoke, createChatQueues, settleReadBoundary } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { autoReadStillWanted } from "../../lib/auto-read";
import type { createSpaceRpc } from "../../lib/rpc";

/**
 * Read state for the open chat: automatic reads while it is visible, Mark as Unread holds,
 * and the "New" divider that marks where the user had read up to.
 */
export function useChatRead({
  rpc,
  active,
  groupId,
  activeGroup,
  setBots,
  setGroups,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  active: Bot | undefined;
  groupId: string | undefined;
  activeGroup: Group | undefined;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
}) {
  const manuallyUnread = useRef(new Set<string>());
  const [markedUnread, setMarkedUnread] = useState<{ visit: number; messageId: string } | null>(
    null,
  );
  const readVisibleGroups = useRef(new Set<string>());
  // What the user had read up to when the open chat was opened; the "New" divider
  // follows it until they write in the chat or leave it. Each open of a chat is a new visit.
  const readVisit = useRef<{ chat: string | null; visit: number }>({ chat: null, visit: 0 });
  const [readBoundary, setReadBoundary] = useState<ReadBoundary | null>(null);
  // A chat's markRead calls run one at a time so the request that opened it answers first.
  const [readInOrder] = useState(createChatQueues);
  const openChat = groupId ? `group:${groupId}` : active ? `bot:${active.id}` : null;
  if (readVisit.current.chat !== openChat) {
    readVisit.current = { chat: openChat, visit: readVisit.current.visit + 1 };
  }
  const captureReadBoundary = useCallback((visit: number, seq: number | null) => {
    setReadBoundary((current) =>
      settleReadBoundary(current, readVisit.current.visit, { visit, seq }),
    );
  }, []);
  // Writing in the chat means the user has caught up, so the divider goes.
  const clearReadBoundary = useCallback(() => {
    setReadBoundary({ visit: readVisit.current.visit, seq: null });
  }, []);
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  // A read ends a snooze that has woken, as the server does.
  const endBotWake = useCallback((id: string) => {
    setBots((current) => endWake(current, id));
  }, []);
  // `stillWanted` makes it an automatic read: one that waited in the queue skips once the user
  // has left. Only an explicit read clears a Mark as Unread hold, and it does so up front, so an
  // automatic read answering after the user marked the chat unread can't undo the hold.
  const markBotRead = useCallback(
    async (id: string, stillWanted?: () => boolean) => {
      if (!stillWanted) {
        manuallyUnread.current.delete(id);
        if (readVisit.current.chat === `bot:${id}`) setMarkedUnread(null);
      }
      const answer = await readInOrder(`bot:${id}`, () =>
        !stillWanted || stillWanted() ? rpc.threads.markRead({ botId: id }) : Promise.resolve(null),
      );
      if (!answer) return undefined;
      endBotWake(id);
      if (!manuallyUnread.current.has(id)) updateBotUnread(id, false);
      return answer.unreadAfterSeq;
    },
    [readInOrder, updateBotUnread, endBotWake],
  );
  const markBotUnread = useCallback(
    async (id: string, messageId?: string) => {
      manuallyUnread.current.add(id);
      const visit = readVisit.current.visit;
      try {
        // Through the chat's read queue, so a read already sent lands first and this one wins.
        await readInOrder(`bot:${id}`, () =>
          rpc.threads.markUnread({ botId: id, ...(messageId ? { messageId } : {}) }),
        );
      } catch (err) {
        manuallyUnread.current.delete(id);
        throw err;
      }
      if (messageId && readVisit.current.visit === visit) setMarkedUnread({ visit, messageId });
      updateBotUnread(id, true);
    },
    [readInOrder, updateBotUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (manuallyUnread.current.has(id)) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        const visit = readVisit.current.visit;
        void markBotRead(
          id,
          () =>
            !manuallyUnread.current.has(id) && autoReadStillWanted(readVisit.current.visit, visit),
        )
          .then((seq) => {
            if (seq !== undefined) captureReadBoundary(visit, seq);
          })
          .catch(() => undefined);
      }
    },
    [markBotRead, captureReadBoundary],
  );
  const markGroupReadIfVisible = useCallback(
    (groupId: string) => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId) ||
        // A group the user marked unread stays unread until they open it again.
        manuallyUnread.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      const visit = readVisit.current.visit;
      void readInOrder(`group:${groupId}`, () =>
        !manuallyUnread.current.has(groupId) && autoReadStillWanted(readVisit.current.visit, visit)
          ? rpc.threads.markRead({ groupId })
          : Promise.resolve(null),
      )
        .then((answer) => {
          if (!answer) {
            readVisibleGroups.current.delete(groupId);
            return;
          }
          captureReadBoundary(visit, answer.unreadAfterSeq);
          setGroups((current) => {
            current = endWake(current, groupId);
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    },
    [readInOrder, captureReadBoundary],
  );
  /** A new bot reply in an open group is read again, once per reply. */
  const markGroupReadOnReply = useCallback(
    (groupId: string) => {
      readVisibleGroups.current.delete(groupId);
      markGroupReadIfVisible(groupId);
    },
    [markGroupReadIfVisible],
  );

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    listenWindow("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => markGroupReadIfVisible(groupId);
    markVisibleGroupRead();
    listenWindow("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
    };
  }, [activeGroup?.id, groupId, markGroupReadIfVisible]);

  /** Mark as Unread from a group message: the next open starts the New divider there. */
  const markGroupUnreadFrom = useCallback(
    (groupId: string, messageId: string) => {
      manuallyUnread.current.add(groupId);
      const visit = readVisit.current.visit;
      void readInOrder(`group:${groupId}`, () => rpc.threads.markUnread({ groupId, messageId }))
        .then(() => {
          if (readVisit.current.visit === visit) {
            setMarkedUnread({ visit, messageId });
          }
          setGroups((current) =>
            current.map((group) => (group.id === groupId ? { ...group, unread: true } : group)),
          );
        })
        .catch(() => manuallyUnread.current.delete(groupId));
    },
    [readInOrder, rpc, setGroups],
  );

  /** Mark as Read or Unread from the chat list. */
  function toggleGroupUnread(groupId: string, unread: boolean) {
    if (unread) manuallyUnread.current.add(groupId);
    else {
      manuallyUnread.current.delete(groupId);
      if (readVisit.current.chat === `group:${groupId}`) setMarkedUnread(null);
    }
    const request = readInOrder(`group:${groupId}`, () =>
      unread ? rpc.threads.markUnread({ groupId }) : rpc.threads.markRead({ groupId }),
    );
    void request
      .then(() =>
        setGroups((current) =>
          (unread ? current : endWake(current, groupId)).map((group) =>
            group.id === groupId ? { ...group, unread } : group,
          ),
        ),
      )
      .catch(() => {
        // A failed Mark as Unread leaves the group as it was, readable again.
        if (unread) manuallyUnread.current.delete(groupId);
      });
  }

  const markedUnreadMessageId =
    markedUnread?.visit === readVisit.current.visit &&
    manuallyUnread.current.has(groupId ?? active?.id ?? "")
      ? markedUnread.messageId
      : undefined;
  const unreadAfterSeq = readBoundary?.visit === readVisit.current.visit ? readBoundary.seq : null;

  return {
    clearReadBoundary,
    markBotRead,
    markBotUnread,
    markBotReadIfVisible,
    markGroupReadOnReply,
    markGroupUnreadFrom,
    toggleGroupUnread,
    markedUnreadMessageId,
    unreadAfterSeq,
  };
}

function endWake<T extends { id: string; snoozedUntil?: string | null }>(
  chats: T[],
  id: string,
): T[] {
  const chat = chats.find((candidate) => candidate.id === id);
  if (!chat || !chatWoke(chat, Date.now())) return chats;
  return chats.map((candidate) =>
    candidate.id === id ? { ...candidate, snoozedUntil: null } : candidate,
  );
}
