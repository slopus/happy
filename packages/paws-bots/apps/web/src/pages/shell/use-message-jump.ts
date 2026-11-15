import type { Bot, ComputerStatus, Routine } from "@rakazo/contracts";
import { foldPeerReplies, jumpTargetId, searchHitThreadTarget } from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import type { SpaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import type { ThreadState } from "./use-thread-state";

type JumpTarget = { botId?: string; groupId?: string; messageId: string };

/**
 * Opening a chat at a message: search hits and deep links (`?m=`, `?routine=`), reply quotes,
 * and the first scroll to the end of a newly opened chat.
 */
export function useMessageJump({
  rpc,
  queries,
  thread,
  commitComputer,
  transcript,
  active,
  inGroup,
  groupId,
  activeBotId,
  activeGroupId,
  searchParams,
  setSearchParams,
  setPanel,
  setPanelState,
  editRoutine,
  resetRoutineTarget,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  thread: ThreadState;
  commitComputer: (next: ComputerStatus | null) => void;
  transcript: ReturnType<typeof foldPeerReplies>;
  active: Bot | undefined;
  inGroup: boolean;
  groupId: string | undefined;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  setPanel: (panel: Panel) => void;
  setPanelState: Dispatch<SetStateAction<Panel>>;
  editRoutine: (routine: Routine) => void;
  resetRoutineTarget: () => void;
}) {
  const {
    snapshot,
    commitSnapshot,
    routines,
    setRoutines,
    routinesBotId,
    setRoutinesBotId,
    expandedHistoryThread,
    historyEpoch,
    messageScroll,
    pinnedAroundRef,
  } = thread;
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
  const initiallyScrolledThread = useRef<string | null>(null);
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  // Leaving the chats (another page) unmounts this hook while its refs still name the last chat.
  // A layout effect, because a page still loading only hides the shell under Suspense, which
  // cleans up layout effects but not passive ones.
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Strips a finished jump from the address so a refresh does not repeat it. The setter from the
   * render that started the jump navigates to that render's chat, so it runs only while that chat
   * is still open, on this page, and still asks for this message.
   */
  function clearJumpParam(target: JumpTarget) {
    if (!mounted.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const next = new URLSearchParams(searchParamsRef.current);
    if (next.get("m") !== target.messageId) return;
    next.delete("m");
    setSearchParams(next, { replace: true });
  }

  async function jumpToMessage(target: JumpTarget) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get(threadTarget),
      rpc.threads.messages({ ...threadTarget, around: { messageId: target.messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    // A reply folded under its peer marker counts: the transcript expands the marker to show it.
    const pageTranscript = foldPeerReplies(page.messages, { includePeerReceipts: true });
    // A relay's dropped marker (e.g. a search hit) lands on its "Messaged X" receipt.
    const messageId = jumpTargetId(pageTranscript, target.messageId);
    const targetInPage =
      pageTranscript.markerOf.has(messageId) ||
      pageTranscript.messages.some((message) => message.id === messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId,
          threadId: page.threadId,
          messages: page.messages,
          olderCursor: page.olderCursor,
        }
      : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    commitSnapshot({
      ...snap,
      messages: targetInPage ? page.messages : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void fetchFresh(
        queryClient,
        queries.routines.list.queryOptions({ input: { botId: threadTarget.botId } }),
      )
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    if (targetInPage) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
      });
    }
  }

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    resetRoutineTarget();
    setPanelState((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      const target = { groupId, messageId };
      // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
      void jumpToMessage(target).finally(() => clearJumpParam(target));
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        editRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("routines");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      const target = { botId: active.id, messageId };
      void jumpToMessage(target).finally(() => clearJumpParam(target));
    }
  }, [active?.id, groupId, inGroup, routines, routinesBotId, searchParams, setSearchParams]);

  const transcriptRef = useRef(transcript);
  useLayoutEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;
  const jumpToReplyMessage = useCallback((replyId: string) => {
    const messageId = jumpTargetId(transcriptRef.current, replyId);
    const inTranscript =
      transcriptRef.current.markerOf.has(messageId) ||
      document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (inTranscript) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId }).catch(() => undefined);
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId }).catch(() => undefined);
  }, []);

  return { scrollRequest, clearScrollRequest, jumpToReplyMessage };
}
