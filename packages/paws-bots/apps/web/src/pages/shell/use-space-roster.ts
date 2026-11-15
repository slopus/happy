import { listenWindow } from "../../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import type {
  AppBootstrap,
  Bot,
  BotSection,
  ComputerStatus,
  Group,
  Me,
  Space,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { isRetryableError, reorderBotTo } from "@rakazo/core";
import { replaceEqualDeep } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { takeInitialBootstrap } from "../../lib/bootstrap";
import { linkedBotRoute } from "../../lib/bootstrap-target";
import { localTimezone } from "../../lib/local-timezone";
import { markOnce } from "../../lib/performance";
import type { ChatTarget } from "../../lib/query";
import { lastChatKey, queryClient, seedOnLeave, spaceSeedKey } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { RosterDropTarget } from "./roster-drop";
import { resolveRosterDrop } from "./roster-drop";
import { createRosterSchedule, ROSTER_POLL_MS } from "./roster-schedule";
import type { useShellNavigation } from "./use-shell-navigation";
import { firstThreadRoute } from "./use-shell-navigation";
import type { ThreadState } from "./use-thread-state";

type Navigation = ReturnType<typeof useShellNavigation>;

/** The space's bots, groups, sections and spaces, refreshed while the shell is open. */
export function useSpaceRoster({
  rpc,
  seed,
  botId,
  groupId,
  navigate,
  redirectKeepingOverlay,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  seed: AppBootstrap | undefined;
  botId: string | undefined;
  groupId: string | undefined;
  navigate: Navigation["navigate"];
  redirectKeepingOverlay: Navigation["redirectKeepingOverlay"];
}) {
  const [groups, setGroups] = useState<Group[]>(seed?.groups ?? []);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [bots, setBots] = useState<Bot[]>(seed?.bots ?? []);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botSections, setBotSections] = useState<BotSection[]>(seed?.botSections ?? []);
  const [spaces, setSpaces] = useState<Space[]>(seed?.spaces ?? []);
  const [archivedBots, setArchivedBots] = useState<Bot[]>(seed?.archivedBots ?? []);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>(seed?.archivedGroups ?? []);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(Boolean(seed));
  // A failed first load falls back to the shell, whose polling and footer can still recover.
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null | undefined>(seed?.me);
  const callsEnabledRef = useRef(false);
  useEffect(() => {
    callsEnabledRef.current = bootstrapMe?.phoneCallsEnabled === true;
  }, [bootstrapMe?.phoneCallsEnabled]);
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;

  const refreshBots = useCallback(
    async (includeArchived = false, replaceBotOrder = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const botOrderEpoch = botOrderEpochRef.current;
      const preserveBotOrder = savingBotOrderRef.current || pendingBotOrderRef.current !== null;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, botSections: sections, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        // The roster is polled; keeping unchanged values lets an unchanged poll skip rendering.
        if (archivedFresh && archived)
          setArchivedBots((previous) => replaceEqualDeep(previous, archived));
        if (archivedFresh && archivedGroupList)
          setArchivedGroups((previous) => replaceEqualDeep(previous, archivedGroupList));
        if (!botsFresh) return;
        if (
          botOrderEpoch === botOrderEpochRef.current &&
          (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
        ) {
          setBots((previous) => replaceEqualDeep(previous, list));
        }
        setBotSections((previous) => replaceEqualDeep(previous, sections));
        setGroups((previous) => replaceEqualDeep(previous, groupList));
        setSpaces((previous) => replaceEqualDeep(previous, navigation.spaces));
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
          navigate("/onboarding", { replace: true });
          return;
        }
        const currentGroupId = routeGroupId.current;
        if (currentGroupId) {
          if (!groupList.some((group) => group.id === currentGroupId)) {
            redirectKeepingOverlay(firstThreadRoute(list, groupList));
          }
          return;
        }
        const currentBotId = routeBotId.current;
        if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
          redirectKeepingOverlay(firstThreadRoute(list, groupList));
        }
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    try {
      while (pendingBotOrderRef.current) {
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        try {
          await rpc.bots.reorder({ botIds });
        } catch {
          // Keep a newer order queued during this failed save; only roll back
          // when nothing else is pending.
          if (pendingBotOrderRef.current === null) {
            await refreshBots(false, true).catch(() => undefined);
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId)) return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [flushBotOrder],
  );

  /** Shows a bot created here at once: a roster requested before creation may omit it. */
  function addCreatedBot(bot: Bot) {
    botsRefreshEpoch.current += 1;
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
  }

  return {
    groups,
    setGroups,
    groupsRef,
    bots,
    setBots,
    botsRef,
    botSections,
    spaces,
    setSpaces,
    archivedBots,
    setArchivedBots,
    archivedGroups,
    setArchivedGroups,
    setBotSections,
    initialBotsLoaded,
    setInitialBotsLoaded,
    initialLoadFailed,
    setInitialLoadFailed,
    bootstrapMe,
    setBootstrapMe,
    callsEnabledRef,
    botsRefreshApplied,
    botsRefreshInFlight,
    routeBotId,
    routeGroupId,
    refreshBots,
    reorderRosterBot,
    addCreatedBot,
  };
}

export type SpaceRoster = ReturnType<typeof useSpaceRoster>;

/**
 * Loads the space's bootstrap, keeps the roster current, and saves what the shell showed so a
 * revisit paints at once. Returns what the server's roster signals drive.
 */
export function useSpaceBootstrap({
  rpc,
  roster,
  thread,
  commitComputer,
  userId,
  shellSpaceId,
  seed,
  startChat,
  botId,
  groupId,
  chat,
  navigate,
  redirectKeepingOverlay,
  openSpaceChat,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  roster: SpaceRoster;
  thread: ThreadState;
  commitComputer: (next: ComputerStatus | null) => void;
  userId: string | undefined;
  shellSpaceId: string | null;
  seed: AppBootstrap | undefined;
  startChat: ChatTarget | undefined;
  botId: string | undefined;
  groupId: string | undefined;
  chat: ChatTarget | undefined;
  navigate: Navigation["navigate"];
  redirectKeepingOverlay: Navigation["redirectKeepingOverlay"];
  /** Opens a linked bot that lives in another of the user's Spaces. */
  openSpaceChat: RefObject<(spaceId: string, path: string) => void>;
}) {
  const {
    bots,
    setBots,
    groups,
    setGroups,
    botSections,
    setBotSections,
    archivedBots,
    setArchivedBots,
    archivedGroups,
    setArchivedGroups,
    spaces,
    setSpaces,
    setInitialBotsLoaded,
    setInitialLoadFailed,
    bootstrapMe,
    setBootstrapMe,
    callsEnabledRef,
    botsRefreshApplied,
    botsRefreshInFlight,
    routeBotId,
    routeGroupId,
    refreshBots,
  } = roster;
  const { snapshotRef, commitSnapshot, setRoutines, setRoutinesBotId, bootstrappedThread } = thread;
  // Until the route names the chat reopened from cache, that chat stands in for it.
  const routeChat = botId || groupId ? undefined : startChat;
  const refreshRosterRef = useRef<() => void>(() => {});
  const [rosterSchedule] = useState(() => createRosterSchedule(() => refreshRosterRef.current()));

  function saveSeed(bootstrap: AppBootstrap, chat?: ChatTarget) {
    // With no space chosen the server picks one, so a shell reopened that way looks there too.
    for (const spaceId of shellSpaceId ? [bootstrap.me.spaceId] : [bootstrap.me.spaceId, null]) {
      queryClient.setQueryData(spaceSeedKey(userId ?? null, spaceId), bootstrap);
      if (chat) queryClient.setQueryData(lastChatKey(userId ?? null, spaceId), chat);
    }
  }
  const seedStateRef = useRef<
    | (Omit<AppBootstrap, "thread" | "routines" | "me"> & {
        me?: Me | null;
        chat: ChatTarget | undefined;
      })
    | null
  >(null);
  seedStateRef.current = {
    chat,
    me: bootstrapMe,
    bots,
    groups,
    botSections,
    archivedBots,
    archivedGroups,
    spaces,
  };
  useLayoutEffect(() => {
    if (routeChat) {
      redirectKeepingOverlay(
        routeChat.groupId ? `/app/g/${routeChat.groupId}` : `/app/${routeChat.botId}`,
      );
    }
    // Leaving for another page or space keeps the sidebar and open chat to reopen with.
    return () => {
      const state = seedStateRef.current;
      if (!state?.me) return;
      const { me, chat, ...lists } = state;
      const previous = queryClient.getQueryData(spaceSeedKey(userId ?? null, me.spaceId));
      if (!previous) return;
      saveSeed(seedOnLeave(previous, { ...lists, me }, chat, snapshotRef.current), chat);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId ?? startChat?.botId)
      .then((bootstrap) => {
        // Kept for the space it belongs to, so switching back to it can paint at once.
        saveSeed(bootstrap);
        if (cancelled) return;
        const groupList = bootstrap.groups;
        setBootstrapMe(bootstrap.me);
        // First sign-in with no saved timezone: adopt this browser's, once. A choice made
        // in Settings is never overwritten; a failure just leaves bots on UTC.
        if (bootstrap.me.timezone === null) {
          void rpc.preferences
            .adoptTimezone({ timezone: localTimezone() })
            .then((nextMe) => {
              if (!cancelled) {
                setBootstrapMe((current) =>
                  current && current.timezone == null
                    ? { ...current, timezone: nextMe.timezone }
                    : (current ?? nextMe),
                );
              }
            })
            .catch(() => {});
        }
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setBotSections(bootstrap.botSections);
          setArchivedBots(bootstrap.archivedBots);
          setArchivedGroups(bootstrap.archivedGroups);
          setGroups(groupList);
          setSpaces(bootstrap.spaces);
          setInitialBotsLoaded(true);
        }
        // A seeded shell already loads its chat live; this older copy must not replace it.
        if (!seed && !groupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          commitSnapshot(bootstrap.thread);
          commitComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        // Checked before the roster gate: a refresh that landed first may already have moved away.
        const linked = groupId
          ? undefined
          : linkedBotRoute(bootstrap, botId, window.location.search);
        if (linked) {
          openSpaceChat.current(linked.spaceId, linked.path);
          return;
        }
        if (!applyBotLists) return;
        // A shell that reopened from cache is already on a chat; it moves only if that chat is gone.
        if (
          seed &&
          (routeGroupId.current
            ? groupList.some((group) => group.id === routeGroupId.current)
            : bootstrap.bots.some((bot) => bot.id === routeBotId.current))
        ) {
          return;
        }
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (groupId) {
          if (!groupList.some((group) => group.id === groupId)) {
            redirectKeepingOverlay(firstThreadRoute(bootstrap.bots, groupList));
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== botId) {
          redirectKeepingOverlay(`/app/${selectedBotId}`);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (!seed) setBootstrapMe(null);
        void refreshBots(true).catch(() => {
          if (!cancelled) setInitialLoadFailed(true);
        });
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible" && !callsEnabledRef.current) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(
        () =>
          void refreshBots().catch((error) => {
            if (!isRetryableError(error)) window.clearInterval(poll);
          }),
        50,
      );
    };
    refreshRosterRef.current = refreshVisibleBots;
    listenWindow("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    // While the server signals roster changes this only heals a missed one. It skips while a
    // refresh is in flight; other callers still bump botsRefreshEpoch so only the latest applies.
    const poll = window.setInterval(() => {
      if (botsRefreshInFlight.current > 0) return;
      rosterSchedule.poll();
    }, ROSTER_POLL_MS);
    return () => {
      cancelled = true;
      refreshRosterRef.current = () => {};
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);
  return rosterSchedule.signals;
}

/** Dragging a bot in the roster: reorder it, move it to a section, or add it to a group. */
export function useRosterDrop({
  rpc,
  bots,
  reorderRosterBot,
  refreshBots,
  refreshGroupThread,
  activeGroupId,
  setSendError,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  bots: Bot[];
  reorderRosterBot: SpaceRoster["reorderRosterBot"];
  refreshBots: () => Promise<void>;
  refreshGroupThread: (groupId: string) => Promise<ThreadSnapshot>;
  activeGroupId: RefObject<string | undefined>;
  setSendError: (error: string | null) => void;
}) {
  const { t } = useLingui();
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [rosterDropKey, setRosterDropKey] = useState<string | null>(null);
  // Drags only act on bots of the active space; other spaces are read-only here.
  const draggedBot = draggedBotId ? bots.find((bot) => bot.id === draggedBotId) : undefined;
  const rosterDropAction = useCallback(
    (target: RosterDropTarget, sameList: boolean) =>
      draggedBot ? resolveRosterDrop({ dragged: draggedBot, target, sameList }) : null,
    [draggedBot],
  );
  const applyRosterDrop = useCallback(
    (target: RosterDropTarget, sameList: boolean, groupBotIds: string[]) => {
      const action = rosterDropAction(target, sameList);
      setDraggedBotId(null);
      setRosterDropKey(null);
      if (!action || !draggedBot) return;
      setSendError(null);
      if (action.action === "reorder") {
        reorderRosterBot(draggedBot.id, action.targetBotId, groupBotIds);
        return;
      }
      const request =
        action.action === "move"
          ? rpc.bots.update({ botId: draggedBot.id, sectionId: action.sectionId })
          : rpc.groups.update({
              groupId: action.groupId,
              botIds: action.botIds,
              expectedBotIds: action.botIds.filter((id) => id !== draggedBot.id),
            });
      void request
        .then(async () => {
          await refreshBots();
          if (action.action === "join" && activeGroupId.current === action.groupId) {
            await refreshGroupThread(action.groupId);
          }
        })
        .catch((error) => {
          setSendError(errorText(error, t`Could not save`));
          void refreshBots().catch(() => undefined);
        });
    },
    [draggedBot, refreshBots, reorderRosterBot, rosterDropAction, t],
  );
  return {
    draggedBotId,
    setDraggedBotId,
    rosterDropKey,
    setRosterDropKey,
    rosterDropAction,
    applyRosterDrop,
  };
}
