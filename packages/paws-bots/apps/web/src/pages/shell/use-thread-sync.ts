import type {
  AppBootstrap,
  Bot,
  ComputerStatus,
  Group,
  ProductEvent,
  RoutineHistory,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  activeThreadRuns,
  anySignal,
  createRefreshCoalescer,
  isRunTerminalEvent,
  isRunWorking,
  isThreadSnapshotEvent,
  messageUnreadFor,
  reconcileRefreshedThread,
  reduceThreadSnapshot,
  rememberTerminalRun,
  runThreadSubscription,
} from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  newLogoAvatarActivitySource,
  openLogoAvatarActivityFeed,
  webLogoAvatarActivity,
} from "../../lib/logo-avatar-activity.js";
import { relistPagesForBlocks } from "../../lib/page-actions";
import { markOnce } from "../../lib/performance";
import type { SpaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import {
  isComputerStatusEvent,
  prependThreadMessagePage,
  reduceComputerStatus,
} from "../../lib/thread-events";
import {
  firstVisibleTranscriptRow,
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
} from "../../lib/transcript-scroll";
import type { useBrowserNotifications } from "./use-browser-notifications";
import type { ComputerState } from "./use-computer";
import type { ThreadState } from "./use-thread-state";

const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;

function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return anySignal([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: RefObject<ThreadSnapshot | null>,
  computerRef: RefObject<ComputerStatus | null>,
) {
  if (isThreadSnapshotEvent(event)) {
    const next = reduceThreadSnapshot(snapshotRef.current, event);
    commitSnapshot(next);
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

/** Loads the open chat, keeps it live, and pages in its older history. */
export function useThreadSync({
  rpc,
  queries,
  thread,
  computerState,
  seed,
  active,
  inGroup,
  groupId,
  activeGroup,
  activeBotId,
  activeGroupId,
  botsRef,
  searchParamsRef,
  refreshBots,
  notifyBrowserForEvent,
  markBotReadIfVisible,
  markGroupReadOnReply,
  meId,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  thread: ThreadState;
  computerState: ComputerState;
  seed: AppBootstrap | undefined;
  active: Bot | undefined;
  inGroup: boolean;
  groupId: string | undefined;
  activeGroup: Group | undefined;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  botsRef: RefObject<Bot[]>;
  searchParamsRef: RefObject<URLSearchParams>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  notifyBrowserForEvent: ReturnType<typeof useBrowserNotifications>["notifyBrowserForEvent"];
  markBotReadIfVisible: (botId: string) => void;
  markGroupReadOnReply: (groupId: string) => void;
  /** The signed-in person: another member's message is new to them, their own is not. */
  meId: string | undefined;
}) {
  const {
    snapshot,
    snapshotRef,
    commitSnapshot,
    updateSnapshot,
    setRoutines,
    setRoutinesBotId,
    setTaughtSkills,
    setTaughtSkillsBotId,
    bootstrappedThread,
    expandedHistoryThread,
    historyEpoch,
    messageScroll,
    pinnedAroundRef,
    resetHistory,
  } = thread;
  const {
    computerRef,
    commitComputer,
    cacheComputerFor,
    showCachedComputer,
    computerOpenRef,
    computerBotIdRef,
    refreshComputerScreen,
  } = computerState;
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const readerScrollEpoch = useRef(0);
  const pendingSnaps = useRef(new Set<number>());
  useEffect(() => {
    const onScroll = (event: Event) => {
      if (event.target === messageScroll.current) readerScrollEpoch.current += 1;
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      readerScrollEpoch.current += 1;
      for (const frame of pendingSnaps.current) window.cancelAnimationFrame(frame);
      pendingSnaps.current.clear();
    };
  }, [messageScroll]);

  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());

  /**
   * Each chat's last snapshot, so reopening it paints at once. The live load and
   * subscription still run and replace it, so it is only ever a first frame.
   */
  function cachedThreadKey(target: { botId: string } | { groupId: string }) {
    return queries.threads.get.queryKey({ input: target });
  }

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    const epoch = historyEpoch.current;
    const readerEpoch = readerScrollEpoch.current;
    const botId = activeBotId.current;
    const groupId = activeGroupId.current;
    const frame = window.requestAnimationFrame(() => {
      pendingSnaps.current.delete(frame);
      if (
        epoch !== historyEpoch.current ||
        readerEpoch !== readerScrollEpoch.current ||
        botId !== activeBotId.current ||
        groupId !== activeGroupId.current
      )
        return;
      const element = messageScroll.current;
      if (!element) return;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        element.scrollTop = element.scrollHeight;
      } else if (element !== queuedElement && !queuedElement.isConnected) {
        // A bot switch remounts the transcript, so the queued element is the
        // detached one. The scroll epoch still guards the replacement's reader position.
        element.scrollTop = element.scrollHeight;
      }
    });
    pendingSnaps.current.add(frame);
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const readerEpoch = readerScrollEpoch.current;
    const preRequestElement = messageScroll.current;
    const stickToEnd = !preRequestElement || transcriptIsNearEnd(preRequestElement);
    markOnce("rk:renderer:thread-request-start");
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id || request !== groupRefreshEpoch.current) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    // Re-read the scroller: the await gave a chat switch time to remount the
    // transcript, so the pre-request element may now be detached. The replacement
    // can start at the top; only stick if no scroll occurred during the load.
    const scrollElement = messageScroll.current;
    const transcriptRemounted = scrollElement !== null && scrollElement !== preRequestElement;
    webLogoAvatarActivity.reconcile(snap);
    commitSnapshot(reconciled.snapshot);
    if (!computerOpenRef.current) commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      readerEpoch === readerScrollEpoch.current &&
      (transcriptRemounted || !scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal) {
    const readerEpoch = readerScrollEpoch.current;
    const preRequestElement = messageScroll.current;
    const stickToEnd = !preRequestElement || transcriptIsNearEnd(preRequestElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const snap = await rpc.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    // Re-read the scroller: the await gave a bot switch time to remount the
    // transcript, so the pre-request element may now be detached. The replacement
    // can start at the top; only stick if no scroll occurred during the load.
    const scrollElement = messageScroll.current;
    const transcriptRemounted = scrollElement !== null && scrollElement !== preRequestElement;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    webLogoAvatarActivity.reconcile(snap);
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      readerEpoch === readerScrollEpoch.current &&
      (transcriptRemounted || !scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      // Runs after routine changes too, so an older read in flight is not reused.
      fetchFresh(queryClient, queries.routines.list.queryOptions({ input: { botId: id } })).catch(
        () => null,
      ),
      fetchFresh(queryClient, queries.skills.list.queryOptions({ input: { botId: id } })).catch(
        () => null,
      ),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  /** An open run history that already lists the finished run shows its outcome without its poll. */
  function refreshRoutineHistory(runId: string | null | undefined) {
    if (!runId) return;
    void queryClient.invalidateQueries({
      queryKey: queries.routines.history.key(),
      predicate: (query) =>
        (query.state.data as { pages?: RoutineHistory[] } | undefined)?.pages?.some((page) =>
          page.runs.some((run) => run.id === runId),
        ) ?? false,
    });
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    // Hold the first visible row steady: a plain height delta would also count
    // content appended at the bottom while the older page was loading.
    const anchorRow = firstVisibleTranscriptRow(scrollElement);
    const anchorTop = anchorRow?.offsetTop ?? null;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      expandedHistoryThread.current = page.threadId;
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (!element) return;
        element.scrollTop +=
          anchorRow?.isConnected && anchorTop !== null
            ? anchorRow.offsetTop - anchorTop
            : element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
    }
    showCachedComputer(active.id);
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const threadKey = cachedThreadKey({ botId: active.id });
    const cachedThread = pendingJump
      ? undefined
      : (queryClient.getQueryData(threadKey) ??
        (seed?.thread?.botId === active.id ? seed.thread : undefined));
    if (
      cachedThread &&
      snapshotRef.current?.botId !== active.id &&
      (active.threadStatus === undefined ||
        activeThreadRuns(cachedThread).some((run) => isRunWorking(run.status)) ===
          isRunWorking(active.threadStatus))
    )
      commitSnapshot(cachedThread);
    const sidebarRefresh = createRefreshCoalescer(() => refreshBots());
    const snapshotRefresh = createRefreshCoalescer(() => refreshThread(active.id));
    const abort = new AbortController();
    const avatarSource = newLogoAvatarActivitySource();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return primed?.botId === active.id
          ? primed
          : pendingJump
            ? rpc.threads.get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
            : refreshThread(active.id, threadSnapshotSignal(abort.signal));
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshThread(active.id, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) =>
        openLogoAvatarActivityFeed(avatarSource, snapshotRef.current, cursor, signal, () =>
          rpc.threads.subscribe({ botId: active.id, cursor }, { signal }),
        ),
      beforeEvent: (event) => {
        webLogoAvatarActivity.apply(avatarSource, event);
        rememberTerminalRun(terminalRunReceipts.current, event);
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef),
      onEvent: (event, initial) => {
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          undefined,
        );
        if (event.type === "thread.cleared") resetHistory();
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "bot.updated" ||
          event.type === "group.created" ||
          event.type === "run.started" ||
          isRunTerminalEvent(event) ||
          event.type === "thread.cleared"
        ) {
          void sidebarRefresh.invalidate().catch(() => undefined);
        }
        if (event.type === "thread.message.created") {
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          relistPagesForBlocks(queries, queryClient, blocks);
          if (blocks.some((block) => block.kind === "child_bot")) {
            void sidebarRefresh.invalidate().catch(() => undefined);
          }
          if (messageUnreadFor(event.payload, meId)) markBotReadIfVisible(active.id);
        }
        if (
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          event.type === "skill.teaching.stopped"
        ) {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void snapshotRefresh.invalidate().catch(() => undefined);
        } else if (isComputerStatusEvent(event)) {
          // In a shared Space the event does not say who took control; the snapshot does.
          if (event.type === "computer.takeover.granted" && computerRef.current?.shared) {
            void snapshotRefresh.invalidate().catch(() => undefined);
          }
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
        if (isRunTerminalEvent(event)) refreshRoutineHistory(event.runId);
      },
    });
    return () => {
      sidebarRefresh.dispose();
      snapshotRefresh.dispose();
      abort.abort();
      webLogoAvatarActivity.resetSource(avatarSource);
      const left = snapshotRef.current;
      if (left?.botId === active.id && !left.groupId) queryClient.setQueryData(threadKey, left);
    };
  }, [active?.id, markBotReadIfVisible, notifyBrowserForEvent, meId]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
      expandedHistoryThread.current = null;
    }
    historyEpoch.current += 1;
    const threadKey = cachedThreadKey({ groupId });
    const cachedThread = pendingJump ? undefined : queryClient.getQueryData(threadKey);
    if (cachedThread && snapshotRef.current?.groupId !== groupId) commitSnapshot(cachedThread);
    const sidebarRefresh = createRefreshCoalescer(() => refreshBots());
    const snapshotRefresh = createRefreshCoalescer(() => refreshGroupThread(groupId));
    const abort = new AbortController();
    const avatarSource = newLogoAvatarActivitySource();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: () =>
        pendingJump
          ? rpc.threads.get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) =>
        openLogoAvatarActivityFeed(avatarSource, snapshotRef.current, cursor, signal, () =>
          rpc.threads.subscribe({ groupId, cursor }, { signal }),
        ),
      beforeEvent: (event) => webLogoAvatarActivity.apply(avatarSource, event),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => {
            if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
            commitComputer(next);
          },
          snapshotRef,
          computerRef,
        ),
      onEvent: (event, initial) => {
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          groupId,
        );
        if (event.type === "thread.message.created" && messageUnreadFor(event.payload, meId)) {
          markGroupReadOnReply(groupId);
        }
        if (event.type === "thread.message.created") {
          relistPagesForBlocks(
            queries,
            queryClient,
            (event.payload.blocks as Array<{ kind?: string }>) ?? [],
          );
        }
        if (
          event.type === "run.started" ||
          event.type === "bot.updated" ||
          event.type === "group.updated" ||
          isRunTerminalEvent(event)
        ) {
          void sidebarRefresh.invalidate().catch(() => undefined);
        }
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void snapshotRefresh.invalidate().catch(() => undefined);
        }
        // The event does not say which tab sent it, so every tab showing this computer refreshes.
        const computerBotId = computerBotIdRef.current;
        if (isComputerStatusEvent(event) && computerBotId && event.botId === computerBotId) {
          void refreshComputerScreen(computerBotId).catch(() => undefined);
        }
        if (isRunTerminalEvent(event)) refreshRoutineHistory(event.runId);
      },
    });
    return () => {
      sidebarRefresh.dispose();
      snapshotRefresh.dispose();
      abort.abort();
      webLogoAvatarActivity.resetSource(avatarSource);
      const left = snapshotRef.current;
      if (left?.groupId === groupId) queryClient.setQueryData(threadKey, left);
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent, markGroupReadOnReply, meId]);

  // Memoized children take these, so they stay referentially stable across renders.
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);

  return {
    refreshThread,
    refreshGroupThread,
    refreshThreadRef,
    refreshGroupThreadRef,
    refreshActiveThread,
    loadOlder,
    loadingOlder,
    terminalRunReceipts,
  };
}
