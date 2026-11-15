import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  SpaceMemoryConfig,
  ThreadMessage,
  VoiceStatus,
} from "@rakazo/contracts";
import { DEFAULT_NEW_BOT_AVATAR_SET } from "@rakazo/contracts";
import {
  activeThreadRuns,
  answerableAskMessageIds,
  channelMessageSender,
  chatSnoozed,
  chatUserBubbleColors,
  chatWoke,
  dismissableAskMessageIds,
  foldPeerReplies,
  groupBotsForSidebar,
  isActive,
  isRunWorking,
  newClientId,
  otherAuthor,
  workingRoutineName,
} from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web";
import { useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { CallCard, CallReturnBar } from "../components/call/CallCard";
import { IncomingCall } from "../components/call/IncomingCall";
import { PageLoading } from "../components/PageLoading";
import { PageViewHost } from "../components/pages/PageViewHost";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { peekBootstrapSeed } from "../lib/bootstrap";
import { botsSidebarDensityPreference } from "../lib/bots-sidebar-density-pref";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../lib/bots-sidebar-pref";
import { setCallMinimized, startCall, useCallSession } from "../lib/call-session";
import { composerEnterToSendPreference } from "../lib/composer-enter-to-send-pref";
import { computersAreUnavailable } from "../lib/computer-sandbox";
import { desktopBridge } from "../lib/desktop";
import { hasOpenDialog } from "../lib/has-open-dialog";
import { PagesProvider, usePagesForChat } from "../lib/pages";
import { markAfterPaint, markOnce } from "../lib/performance";
import { usePreloadRecoveryState } from "../lib/preload-recovery";
import { lastChatKey, lastChatOf, queryClient, spaceQueries, spaceSeedKey } from "../lib/query";
import type { Panel } from "../lib/right-panel-state";
import { rightPanelStorageKey } from "../lib/right-panel-state";
import { createSpaceRpc, selectedSpaceId } from "../lib/rpc";
import { SpaceRpcProvider } from "../lib/space-rpc";
import { markShellReady, useSpaceEpoch } from "../lib/space-switch";
import { toolActivityPreference } from "../lib/tool-activity-preference";
import { useDesktopBadge } from "../lib/use-desktop-badge";
import { errorText } from "../lib/user-error";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { RoutineList } from "./RoutineList";
import { ArchivedChats } from "./shell/archived-chats";
import type { ChatMenuState, ChatMenuTarget } from "./shell/chat-context-menu";
import { ChatContextMenu } from "./shell/chat-context-menu";
import { ChatFindBar } from "./shell/chat-find-bar";
import { ChatHeader } from "./shell/chat-header";
import { FALLBACK_BOT_COLOR } from "./shell/chat-shared";
import { Composer } from "./shell/composer";
import { ComputerOverlay } from "./shell/computer-overlay";
import { ComputerPanel } from "./shell/computer-panel";
import type { CreateBotDialogInput } from "./shell/create-bot-dialog";
import type { ImportSetupTarget } from "./shell/import-setup-card";
import { KeyboardShortcutsDialog } from "./shell/keyboard-shortcuts-dialog";
import { ShellDialogs, useShellDialogs } from "./shell/shell-dialogs";
import { AppOverlays, SettingsOverlays } from "./shell/shell-overlays";
import { cycleBotId, isApplePlatform, useShellShortcuts } from "./shell/shell-shortcuts";
import { focusSidebarSearch, ShellSidebar } from "./shell/shell-sidebar";
import { ShellSidePanel } from "./shell/side-panel";
import { BotsSidebarLayout } from "./shell/sidebar-layout";
import { SidebarRoster } from "./shell/sidebar-roster";
import { SnoozedChats } from "./shell/snoozed-chats";
import { countUnreadChats, sidebarGroupsForSpaces } from "./shell/space-sidebar";
import { Transcript } from "./shell/transcript";
import { resolveTranscriptMemberName as groupTranscriptMemberName } from "./shell/transcript-member-name";
import { useBrowserNotifications } from "./shell/use-browser-notifications";
import { useChatRead } from "./shell/use-chat-read";
import { useChatSnooze } from "./shell/use-chat-snooze";
import { useComposerActions } from "./shell/use-composer-actions";
import { useComposerMentions } from "./shell/use-composer-mentions";
import { useComputerControls, useComputerState } from "./shell/use-computer";
import { useMessageJump } from "./shell/use-message-jump";
import { useMobileSidebar } from "./shell/use-mobile-sidebar";
import { usePaletteActions } from "./shell/use-palette-actions";
import { useReadAloud } from "./shell/use-read-aloud";
import { useReportedUiLocale } from "./shell/use-reported-ui-locale";
import { useRightPanel, useRightPanelRestore } from "./shell/use-right-panel";
import { useRoutineEditor } from "./shell/use-routine-editor";
import { useShellNavigation } from "./shell/use-shell-navigation";
import { useSidebarExpansion } from "./shell/use-sidebar-expansion";
import { useSidebarSearch } from "./shell/use-sidebar-search";
import { useSnoozeClock } from "./shell/use-snooze-clock";
import { useSpaceActions } from "./shell/use-space-actions";
import { useRosterDrop, useSpaceBootstrap, useSpaceRoster } from "./shell/use-space-roster";
import { useOpenSpaceChat } from "./shell/use-space-switch";
import { useTeaching } from "./shell/use-teaching";
import { useThreadState } from "./shell/use-thread-state";
import { useThreadSync } from "./shell/use-thread-sync";
import type { SettingsSection } from "./shell-overlay";

const NO_AGENT_SKILLS: AgentSkillCatalogEntry[] = [];
const NO_PROVIDERS: string[] = [];

export function ShellPage() {
  // A new key per space switch, so nothing from the previous space survives it.
  const spaceEpoch = useSpaceEpoch();
  return <SpaceShell key={spaceEpoch} />;
}

function SpaceShell() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const [shellSpaceId] = useState(selectedSpaceId);
  const [rpc] = useState(() => createSpaceRpc(shellSpaceId));
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  // Held from the first render, so Cmd/Ctrl+N works before the sidebar has data.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // A revisited space, or the shell reopened from another page, starts from what it showed
  // last time while its fresh bootstrap loads.
  const [{ seed, startChat }] = useState(() => {
    const primed = peekBootstrapSeed(botId);
    if (primed) return { seed: primed, startChat: undefined };
    const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, shellSpaceId));
    const lastChat = queryClient.getQueryData(lastChatKey(userId ?? null, shellSpaceId));
    return { seed: cached, startChat: botId || groupId ? undefined : lastChatOf(cached, lastChat) };
  });
  const {
    navigate,
    navigationRevision,
    overlayRevision,
    alive,
    searchParams,
    setSearchParams,
    searchParamsRef,
    redirectKeepingOverlay,
    overlay,
    setOverlay,
  } = useShellNavigation();
  const queries = spaceQueries(userId ?? null, shellSpaceId);
  const roster = useSpaceRoster({ rpc, seed, botId, groupId, navigate, redirectKeepingOverlay });
  const {
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
    archivedGroups,
    initialBotsLoaded,
    initialLoadFailed,
    bootstrapMe,
    setBootstrapMe,
    refreshBots,
  } = roster;
  const snoozeNow = useSnoozeClock([
    ...bots,
    ...groups,
    ...spaces.flatMap((space) => [...space.bots, ...space.groups]),
  ]);
  const snooze = useChatSnooze({
    rpc,
    openSpaceId: bootstrapMe?.spaceId,
    setBots,
    setGroups,
    setSpaces,
    refreshBots,
  });
  const { collapsedSidebarSections, toggleSidebarSection } = useSidebarExpansion(userId);
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const search = useSidebarSearch({ rpc, navigate });
  const thread = useThreadState();
  const { snapshot } = thread;
  const showToolActivity = toolActivityPreference.use();
  const botsSidebarDensity = botsSidebarDensityPreference.use();
  const enterToSend = composerEnterToSendPreference.use();
  const rightPanel = useRightPanel({ searchParams, setSearchParams });
  const { panel, setPanel, modelFocusRequest, setModelFocusRequest } = rightPanel;
  const lastBotTab = useRef<Panel>("routines");
  if (panel === "routines" || panel === "computer" || panel === "pages" || panel === "settings")
    lastBotTab.current = panel;
  const [peerConversation, setPeerConversation] = usePreloadRecoveryState<{
    peerBotId: string;
    peerBotName: string;
  } | null>("peerConversation", null);
  const agentSkillsQuery = useQuery(queries.agentSkills.list.queryOptions());
  const agentSkills = agentSkillsQuery.data ?? NO_AGENT_SKILLS;
  const setAgentSkills = useCallback(
    (skills: AgentSkillCatalogEntry[]) =>
      void writeSaved(queryClient, queries.agentSkills.list.queryKey(), () => skills),
    [queries],
  );
  const refreshAgentSkills = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queries.agentSkills.list.queryKey() });
  }, [queries]);

  const messagingStatus = useQuery({
    ...queries.messaging.status.queryOptions(),
    enabled: Boolean(session.data?.user),
  }).data;
  const messagingSurfaceEnabled = messagingStatus?.enabled ?? false;
  const messagingProviders = messagingStatus?.providers ?? NO_PROVIDERS;
  const memoryConfigQuery = useQuery(queries.memory.providerConfig.queryOptions());
  // Undefined while it first loads; null when the space has none or it could not be read.
  const memoryProviderConfig: SpaceMemoryConfig | null | undefined =
    memoryConfigQuery.data !== undefined
      ? memoryConfigQuery.data
      : memoryConfigQuery.isError
        ? null
        : undefined;
  const call = useCallSession();
  /** Calls a bot, or opens voice settings first when no voice is connected. */
  const callBot = (bot: Bot) => {
    if (!bootstrapMe?.phoneCallsEnabled) return;
    if (!voiceStatus?.ready) {
      openSettings("voice");
      return;
    }
    startCall({
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      botAvatarSet: bot.avatarSet,
      transcribe: voiceStatus ? Boolean(voiceStatus.transcribe) : undefined,
    });
  };
  const voiceStatus: VoiceStatus | null =
    useQuery(queries.voice.status.queryOptions()).data ?? null;
  const { mobileSidebarOpen, setMobileSidebarOpen, swipeHandlers } = useMobileSidebar();
  const isMobileSidebar = useIsMobile();
  const pages = usePagesForChat();
  const miniSidebar = botsSidebarCollapsed && !isMobileSidebar;
  const [botMenu, setBotMenu] = useState<ChatMenuTarget | null>(null);
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const currentSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId ?? null;
  // null: settings follow the space the app is showing.
  const settingsSpaceId = overlay?.kind === "settings" ? overlay.spaceId : null;
  const settingsSpace =
    spaces.find((space) => space.id === (settingsSpaceId ?? currentSpaceId)) ?? null;
  // Never fall back to another space's settings when the edited space goes away.
  const settingsSpaceGone = initialBotsLoaded && settingsSpaceId !== null && !settingsSpace;
  useEffect(() => {
    if (settingsSpaceGone) setOverlay(null);
  }, [settingsSpaceGone]);
  // The app menu owns Cmd+, because macOS takes it before the page sees a keydown.
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  useEffect(() => desktopBridge()?.settings?.onOpen(() => openSettingsRef.current("general")), []);

  const inGroup = Boolean(groupId);
  const chatPanelOpen = inGroup
    ? panel === "group-settings"
    : panel === "computer" ||
      panel === "routines" ||
      panel === "pages" ||
      panel === "settings" ||
      panel === "routine";
  // Until the route names the chat reopened from cache, that chat stands in for it.
  const routeChat = botId || groupId ? undefined : startChat;
  const active =
    inGroup || routeChat?.groupId
      ? undefined
      : (bots.find((b) => b.id === (botId ?? routeChat?.botId)) ??
        // With no chat named, open one that's in the list, not a snoozed one.
        bots.find((b) => !chatSnoozed(b, snoozeNow)) ??
        bots[0]);
  const selectBot = useCallback(
    (id: string) => {
      setMobileSidebarOpen(false);
      navigate(`/app/${id}`);
    },
    [navigate, setMobileSidebarOpen],
  );
  const userBubble = useMemo(
    () => (active ? chatUserBubbleColors(active.color, active.id) : undefined),
    [active?.color, active?.id],
  );
  const activeGroup = groups.find((group) => group.id === groupId);
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  const computerState = useComputerState({ rpc, panel, activeId: active?.id, activeBotId });
  const { computer, computerOpen, setComputerOpen, booting, commitComputer } = computerState;
  const [cleaningUpDisk, setCleaningUpDisk] = useState(false);
  const dismissDiskWarning = (botId: string) => {
    const current = computerState.computerRef.current;
    if (current?.botId === botId) commitComputer({ ...current, diskFullPercent: undefined });
    const cached = computerState.computerCacheRef.current.get(botId)?.computer;
    if (cached)
      computerState.cacheComputerFor(botId, {
        computer: { ...cached, diskFullPercent: undefined },
      });
    return rpc.computer.dismissDiskWarning({ botId }).catch(() => undefined);
  };
  useReportedUiLocale(rpc, bootstrapMe?.locale);
  const cycleBots = useMemo(
    () =>
      groupBotsForSidebar(
        bots.filter((bot) => !chatSnoozed(bot, snoozeNow)),
        botSections,
      ).flatMap((group) => group.bots),
    [bots, botSections, snoozeNow],
  );
  const dialogs = useShellDialogs();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  // Matches belong to the chat they were found in.
  useEffect(() => setFindOpen(false), [botId, groupId]);
  useShellShortcuts({
    run: (shortcut) => {
      switch (shortcut.type) {
        case "command-menu":
          dialogs.setCommandPaletteOpen((open) => !open);
          return true;
        case "new":
          setCreateMenuOpen(true);
          return true;
        case "shortcuts":
          setShortcutsOpen((open) => !open);
          return true;
        case "back":
        case "forward":
          void navigate(shortcut.type === "back" ? -1 : 1);
          return true;
      }
      // The full-screen computer covers the sidebar and takes the keyboard.
      if (computerOpen) return false;
      if (shortcut.type === "toggle-sidebar") {
        if (isMobileSidebar) setMobileSidebarOpen((open) => !open);
        else setBotsSidebarCollapsedPref(!botsSidebarCollapsed);
        return true;
      }
      if (shortcut.type === "search") {
        if (isMobileSidebar) setMobileSidebarOpen(true);
        else if (botsSidebarCollapsed) setBotsSidebarCollapsedPref(false);
        search.setSearchOpen(true);
        focusSidebarSearch();
        return true;
      }
      // The command menu picks its own Cmd/Ctrl+1–9 from what it lists.
      if (hasOpenDialog(document, true)) return false;
      switch (shortcut.type) {
        case "new-group":
          // A space without bots has nobody to add, and the side panel needs a chat to open in.
          if (!active && !activeGroup) return false;
          setPanel("create-group");
          return true;
        case "integrations":
          setOverlay({ kind: "integrations" });
          return true;
        case "chat-panel":
          // A form in the side panel (a new group, an import) keeps its unsaved input.
          if (panel && !chatPanelOpen) return false;
          return toggleChatPanel();
        case "focus-composer":
          return focusComposer();
        case "find":
          if (!active && !activeGroup) return false;
          // On a narrow window the drawer makes the chat inert and a side panel covers it, so
          // either would hide the bar. A panel holding a form keeps its input instead.
          if (isMobileSidebar && panel) {
            if (!chatPanelOpen) return false;
            setPanel(null);
          }
          setMobileSidebarOpen(false);
          setFindOpen(true);
          // A bar already open may have lost focus; a new one focuses itself as it mounts.
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
          return true;
      }
      const botId =
        shortcut.type === "bot"
          ? cycleBots[shortcut.index]?.id
          : cycleBotId(cycleBots, active?.id, shortcut.type === "next-bot" ? 1 : -1);
      if (!botId) return false;
      selectBot(botId);
      return true;
    },
    onTyping: () => {
      if (computerOpen || hasOpenDialog(document, true)) return;
      focusComposer();
    },
  });
  function focusComposer() {
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[name="chat-message"]:not(:disabled)',
    );
    composer?.focus();
    return Boolean(composer);
  }
  function toggleChatPanel() {
    if (chatPanelOpen) setPanel(null);
    else if (inGroup) setPanel("group-settings");
    else if (active) {
      setPanel(lastBotTab.current);
      // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
      void refreshThread(active.id).catch(() => undefined);
    } else return false;
    return true;
  }
  const openSpaceChatRef = useRef<(spaceId: string, path: string) => void>(() => {});
  const rosterSignals = useSpaceBootstrap({
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
    chat: groupId ? { groupId } : active ? { botId: active.id } : undefined,
    navigate,
    redirectKeepingOverlay,
    openSpaceChat: openSpaceChatRef,
  });
  const { notifyBrowserForEvent, flushPendingBrowserNotifications } = useBrowserNotifications(
    bots,
    botsRef,
    {
      rpc,
      activeBotId,
      activeGroupId,
      openChat: (alert) => {
        setMobileSidebarOpen(false);
        navigate(alert.groupId ? `/app/g/${alert.groupId}` : `/app/${alert.botId}`);
      },
      meId: userId,
      groupsRef,
      roster: rosterSignals,
    },
  );
  const { speakingMessageId, speakMessage, callHoldsSpeaker } = useReadAloud({
    active,
    snapshot,
    callBotId: call?.botId,
    activeBotId,
  });
  const read = useChatRead({ rpc, active, groupId, activeGroup, setBots, setGroups });
  // A chat that wakes while it is open is already seen: read it, which ends the snooze.
  const openChatWoke = active
    ? chatWoke(active, snoozeNow)
    : activeGroup
      ? chatWoke(activeGroup, snoozeNow)
      : false;
  useEffect(() => {
    if (!openChatWoke) return;
    if (groupId) read.markGroupReadOnReply(groupId);
    else if (active) read.markBotReadIfVisible(active.id);
  }, [openChatWoke]);
  const {
    refreshThread,
    refreshGroupThread,
    refreshThreadRef,
    refreshGroupThreadRef,
    refreshActiveThread,
    loadOlder,
    loadingOlder,
    terminalRunReceipts,
  } = useThreadSync({
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
    markBotReadIfVisible: read.markBotReadIfVisible,
    markGroupReadOnReply: read.markGroupReadOnReply,
    meId: userId,
  });
  const {
    editorProps: routineEditorProps,
    deleteDialogProps: deleteRoutineDialogProps,
    editingRoutine,
    restoreRoutine,
    editRoutine,
    startRoutine,
    resetRoutineTarget,
    leaveRoutine,
    addSkillRoutine,
  } = useRoutineEditor({
    rpc,
    active,
    activeBotId,
    timezone: bootstrapMe?.timezone,
    setBots,
    refreshThread,
    setPanel,
    messageProviders: messagingProviders,
  });
  // Until this visit's read lands, a bot shows the routines and skills it had last time.
  const cachedRoutines =
    inGroup || !active || thread.routinesBotId === active.id
      ? undefined
      : queryClient.getQueryData(queries.routines.list.queryKey({ input: { botId: active.id } }));
  const activeRoutines =
    inGroup || !active
      ? []
      : thread.routinesBotId === active.id
        ? thread.routines
        : (cachedRoutines ?? []);
  // A bot opened for the first time has no routines to show yet, which is not the same as none.
  const routinesLoaded =
    !active || inGroup || thread.routinesBotId === active.id || cachedRoutines !== undefined;
  const activeTaughtSkills = !active
    ? []
    : thread.taughtSkillsBotId === active.id
      ? thread.taughtSkills
      : (queryClient.getQueryData(queries.skills.list.queryKey({ input: { botId: active.id } })) ??
        []);
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;

  const sidebarSpaces = useMemo(
    () =>
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canRename: false,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [],
    [bootstrapMe, botSections, bots, groups, spaces],
  );
  const sidebarGroups = useMemo(
    () =>
      sidebarGroupsForSpaces(
        sidebarSpaces,
        miniSidebar ? "" : search.query,
        { pinned: t`Pinned`, unassigned: t`Unassigned` },
        snoozeNow,
      ),
    [sidebarSpaces, search.query, miniSidebar, t, snoozeNow],
  );
  // The Dock badge ignores the roster search box: a filter must not hide unread chats.
  const unreadChatCount = useMemo(
    () => countUnreadChats(sidebarGroupsForSpaces(sidebarSpaces, "", undefined, snoozeNow)),
    [sidebarSpaces, snoozeNow],
  );
  useDesktopBadge(userId ? unreadChatCount : 0);
  const openSpaceChat = useOpenSpaceChat({
    bootstrapSpaceId: bootstrapMe?.spaceId,
    userId,
    navigate,
    navigationRevision,
    overlayRevision,
    closeMobileSidebar: () => setMobileSidebarOpen(false),
  });
  useLayoutEffect(() => {
    openSpaceChatRef.current = openSpaceChat;
  }, [openSpaceChat]);

  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskIds = useMemo(() => answerableAskMessageIds(activeSnapshot), [activeSnapshot]);
  const dismissableAskIds = useMemo(
    () => dismissableAskMessageIds(activeSnapshot, userId),
    [activeSnapshot, userId],
  );
  const workingRuns = currentRuns.filter((run) => isRunWorking(run.status));
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const transcript = useMemo(
    () => foldPeerReplies(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      avatarSet: bot?.avatarSet,
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) =>
      groupTranscriptMemberName({
        botId,
        members: transcriptMembers,
        bots,
        archivedBots,
      }),
    [archivedBots, bots, transcriptMembers],
  );
  const { composerMentionTargets, footerLogos, setFooterLogos } = useComposerMentions({
    rpc,
    queries,
    bots,
    groups,
    inGroup,
    groupId,
    integrationsOpen: overlay?.kind === "integrations",
    initialBotsLoaded,
  });
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markShellReady();
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  const { scrollRequest, clearScrollRequest, jumpToReplyMessage } = useMessageJump({
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
    setPanelState: rightPanel.setPanelState,
    editRoutine,
    resetRoutineTarget,
  });
  const computerControls = useComputerControls({
    rpc,
    state: computerState,
    panel,
    active,
    bots,
    botsRef,
    activeBotId,
    activeGroupId,
    runStatus: snapshot?.run?.status,
    sandboxProvider: bootstrapMe?.sandboxProvider,
    refreshThread,
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
    onUpgrade: () => openSettings("billing"),
  });
  const { computerBot, openComputer } = computerControls;
  const composer = useComposerActions({
    rpc,
    pageSession: pages.session,
    activeId: active?.id,
    inGroup,
    groupId,
    activeBotId,
    activeGroupId,
    botsRef,
    bootstrapMe,
    activeSnapshot,
    navigate,
    refreshBots,
    refreshThreadRef,
    refreshGroupThreadRef,
    updateSnapshot: thread.updateSnapshot,
    terminalRunReceipts,
    computerRef: computerState.computerRef,
    commitComputer,
    clearReadBoundary: read.clearReadBoundary,
    flushPendingBrowserNotifications,
  });
  const { sending, sendError, stopRun } = composer;
  function openChatSettings(kind: "bot" | "group", id: string) {
    const destKey =
      userId && bootstrapMe?.spaceId
        ? rightPanelStorageKey(userId, bootstrapMe.spaceId, kind, id)
        : null;
    rightPanel.openPanelInChat(destKey, kind === "bot" ? "settings" : "group-settings", () =>
      navigate(kind === "bot" ? `/app/${id}` : `/app/g/${id}`),
    );
  }

  const replyTargetName = composer.replyTarget
    ? composer.replyTarget.role === "user"
      ? (otherAuthor(composer.replyTarget.author, userId)?.name ??
        channelMessageSender(composer.replyTarget.blocks) ??
        t`You`)
      : (resolveTranscriptMemberName(composer.replyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  useRightPanelRestore({
    rightPanel,
    userId,
    spaceId: bootstrapMe?.spaceId,
    inGroup,
    panelTarget: inGroup ? activeGroup?.id : active?.id,
    activeId: active?.id,
    routines: thread.routines,
    routinesBotId: thread.routinesBotId,
    searchParams,
    editingRoutineId: editingRoutine?.id,
    restoreRoutine,
    leaveRoutine,
  });
  const rosterDrop = useRosterDrop({
    rpc,
    bots,
    reorderRosterBot: roster.reorderRosterBot,
    refreshBots,
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
    activeGroupId,
    setSendError: composer.setSendError,
  });

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  // An import's setup checklist re-checks on each thread refresh, so refresh once setup closes.
  const importSetupOpen = useRef(false);
  useEffect(() => {
    if (!importSetupOpen.current || overlay || searchParams.has("routine")) return;
    importSetupOpen.current = false;
    void refreshActiveThread();
  }, [overlay, searchParams, refreshActiveThread]);
  const setOverlayRef = useRef(setOverlay);
  useLayoutEffect(() => {
    setOverlayRef.current = setOverlay;
  }, [setOverlay]);
  const replyToMessage = useCallback(
    (message: ThreadMessage) => {
      composer.setReplyTarget(message);
      composer.setReplyQuote(null);
    },
    [composer.setReplyQuote, composer.setReplyTarget],
  );
  const quoteMessage = useCallback(
    (message: ThreadMessage, quote: string) => {
      composer.setReplyTarget(message);
      composer.setReplyQuote(quote);
    },
    [composer.setReplyQuote, composer.setReplyTarget],
  );
  const markMessageUnread = useCallback(
    (message: ThreadMessage) => {
      if (groupId) read.markGroupUnreadFrom(groupId, message.id);
      else if (active?.id) void read.markBotUnread(active.id, message.id).catch(() => undefined);
    },
    [active?.id, groupId, read.markBotUnread, read.markGroupUnreadFrom],
  );
  const openPeerMessages = useCallback(
    (peer: { peerBotId: string; peerBotName: string }) => {
      setPeerConversation(peer);
    },
    [setPeerConversation],
  );
  const openImportSetup = useCallback(
    (target: ImportSetupTarget) => {
      importSetupOpen.current = true;
      if (target.kind === "models")
        setOverlayRef.current({ kind: "settings", section: "models", spaceId: null });
      else if (target.kind === "mcp")
        setOverlayRef.current({ kind: "mcp", serverId: target.serverId });
      else {
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          next.set("routine", target.routineId);
          return next;
        });
      }
    },
    [setSearchParams],
  );
  const { teachBusy, stopTeaching, refreshActiveTeaching } = useTeaching({
    rpc,
    queries,
    thread,
    activeBotId,
    refreshThreadRef,
    closeComputer: () => setComputerOpen(false),
  });

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general", spaceId: string | null = null) {
    setOverlay({ kind: "settings", section, spaceId });
  }

  // Space-scoped sections bind their own rpc client to this space, so another
  // space's settings open in place without switching the app or reloading.
  function openSpaceSettings(spaceId: string) {
    openSettings("space", spaceId);
  }

  const paletteActions = usePaletteActions({
    settingsAvailable: {
      messaging: messagingSurfaceEnabled,
      wallet: Boolean(bootstrapMe?.paymentWalletProvider),
      computer:
        bootstrapMe?.computerSettingsEnabled === true &&
        computersAreUnavailable(bootstrapMe?.sandboxProvider),
      billing: bootstrapMe?.billingEnabled === true,
      updates: Boolean(desktopBridge()?.update),
    },
    onNewBot: () => dialogs.setCreateBotOpen(true),
    onNewGroup: () => setPanel("create-group"),
    onNewSpace: () => dialogs.setNewSpaceOpen(true),
    onShortcuts: () => setShortcutsOpen(true),
    setOverlay,
    openSettings,
  });
  const { renameSpace, removeSpace, leftSpace } = useSpaceActions({
    rpc,
    alive,
    setSpaces,
    refreshBots,
    bootstrapMe,
    closePanel: () => setPanel(null),
  });

  function openCreatedBot(bot: Bot) {
    roster.addCreatedBot(bot);
    navigate(`/app/${bot.id}`);
    setPanel(null);
  }

  async function createBot(input: CreateBotDialogInput) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({ ...input, notifyOnFinish: true });
    openCreatedBot(bot);
    dialogs.setCreateBotOpen(false);
    await composer.startFocusPrompt(bot.id, isFirstBot);
    await refreshBots().catch(() => undefined);
  }

  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const botMenuContent =
    contextBot || contextGroup ? (
      <ChatContextMenu
        rpc={rpc}
        bot={contextBot}
        group={contextGroup}
        sections={botSections}
        spaceId={bootstrapMe?.spaceId}
        onClose={closeBotMenu}
        refreshBots={refreshBots}
        read={read}
        snooze={snooze}
        dialogs={dialogs}
        openChatSettings={openChatSettings}
        navigate={navigate}
      />
    ) : null;
  const chatMenu: ChatMenuState = {
    menu: botMenu,
    setMenu: setBotMenu,
    content: botMenuContent,
    // Search can list a chat the roster doesn't hold; it has no menu to show.
    has: (target) =>
      target.kind === "bot"
        ? bots.some((bot) => bot.id === target.id)
        : groups.some((group) => group.id === target.id),
  };
  const shell = (
    <BotsSidebarLayout
      userId={userId}
      collapsed={botsSidebarCollapsed}
      onCollapsedChange={setBotsSidebarCollapsedPref}
      onPreviewCollapsedChange={setBotsSidebarCollapsed}
      computerOpen={computerOpen}
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground/90 [&[data-resizing-sidebar]_*[data-slot=sidebar-gap]]:transition-none [&[data-resizing-sidebar]_*[data-slot=sidebar-container]]:transition-none"
      {...swipeHandlers}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      <ShellSidebar
        isMobile={isMobileSidebar}
        mobileOpen={mobileSidebarOpen}
        setMobileOpen={setMobileSidebarOpen}
        density={botsSidebarDensity}
        collapsed={botsSidebarCollapsed}
        mini={miniSidebar}
        setCollapsedPref={setBotsSidebarCollapsedPref}
        createMenuOpen={createMenuOpen}
        setCreateMenuOpen={setCreateMenuOpen}
        search={search}
        bots={bots}
        groups={groups}
        collapsedSidebarSections={collapsedSidebarSections}
        toggleSidebarSection={toggleSidebarSection}
        setPanel={setPanel}
        navigate={navigate}
        setNewSpaceOpen={dialogs.setNewSpaceOpen}
        setCreateBotOpen={dialogs.setCreateBotOpen}
        chatMenu={chatMenu}
        roster={
          <SidebarRoster
            mini={miniSidebar}
            sidebarGroups={sidebarGroups}
            collapsedSidebarSections={collapsedSidebarSections}
            bootstrapMe={bootstrapMe}
            botSections={botSections}
            spaces={spaces}
            rosterDropKey={rosterDrop.rosterDropKey}
            setRosterDropKey={rosterDrop.setRosterDropKey}
            rosterDropAction={rosterDrop.rosterDropAction}
            applyRosterDrop={rosterDrop.applyRosterDrop}
            openSpaceChat={openSpaceChat}
            spaceMenuAnchor={dialogs.spaceMenuAnchor}
            setSpaceMenu={dialogs.setSpaceMenu}
            setRenameSectionTarget={dialogs.setRenameSectionTarget}
            setDeleteSectionTarget={dialogs.setDeleteSectionTarget}
            toggleSidebarSection={toggleSidebarSection}
            inGroup={inGroup}
            active={active}
            activeGroup={activeGroup}
            botsSidebarDensity={botsSidebarDensity}
            dismissedRunErrorIds={composer.dismissedRunErrorIds}
            displayedRunError={composer.displayedRunError}
            draggedBotId={rosterDrop.draggedBotId}
            setDraggedBotId={rosterDrop.setDraggedBotId}
            chatMenu={chatMenu}
            reorderRosterBot={roster.reorderRosterBot}
            activeSnapshot={activeSnapshot}
          />
        }
        archived={
          <>
            <SnoozedChats
              snoozed={sidebarSpaces.flatMap((space) => [
                ...space.bots
                  .filter((chat) => chatSnoozed(chat, snoozeNow))
                  .map((chat) => ({ kind: "bot" as const, chat })),
                ...space.groups
                  .filter((chat) => chatSnoozed(chat, snoozeNow))
                  .map((chat) => ({ kind: "group" as const, chat })),
              ])}
              showSpaceSearch={search.showSpaceSearch}
              now={snoozeNow}
              snooze={snooze}
              openSpaceChat={openSpaceChat}
            />
            <ArchivedChats
              archivedBots={archivedBots}
              archivedGroups={archivedGroups}
              showSpaceSearch={search.showSpaceSearch}
              rpc={rpc}
              refreshBots={refreshBots}
              setDeleteTarget={dialogs.setDeleteTarget}
              setDeleteGroupTarget={dialogs.setDeleteGroupTarget}
            />
          </>
        }
        footerLogos={footerLogos}
        user={session.data?.user}
        ticketBoardEnabled={Boolean(bootstrapMe?.ticketBoardEnabled)}
        navLinks={desktopBridge() ? [] : (bootstrapMe?.navLinks ?? [])}
        openSettings={openSettings}
        openIntegrations={() => setOverlay({ kind: "integrations" })}
        openSkills={() => setOverlay({ kind: "skills" })}
        openSpaceChat={openSpaceChat}
      />

      {/* Keep the composer's z-index inside the chat so phone overlays like the side panel cover it. */}
      <main
        data-space-switch="main"
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="isolate flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* Inside main so the composer and its menus stay above it. */}
        {!mobileSidebarOpen ? (
          <div
            data-testid="mobile-sidebar-swipe-edge"
            aria-hidden="true"
            className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
          />
        ) : null}
        <CallReturnBar />
        {/* The header floats so the transcript scrolls under its buttons. */}
        <div ref={chatColumnRef} className="relative flex min-h-0 flex-1 flex-col">
          {/* Only the pills take input; the gaps pass clicks and scrolling to the transcript. */}
          <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 z-10 h-3" />
          {findOpen ? (
            <div className="absolute end-3 top-14 z-20">
              <ChatFindBar
                scope={chatColumnRef}
                inputRef={findInputRef}
                onClose={() => {
                  setFindOpen(false);
                  focusComposer();
                }}
              />
            </div>
          ) : null}
          <ChatHeader
            inGroup={inGroup}
            active={active}
            activeGroup={activeGroup}
            activeSnapshot={activeSnapshot}
            phoneCallsEnabled={Boolean(bootstrapMe?.phoneCallsEnabled)}
            voiceReady={Boolean(voiceStatus?.ready)}
            inCall={Boolean(active) && call?.botId === active?.id}
            panelOpen={chatPanelOpen}
            onOpenNavigation={() => setMobileSidebarOpen(true)}
            onTogglePanel={toggleChatPanel}
            onCall={(bot) => {
              if (call?.botId === bot.id) {
                setCallMinimized(false);
                return;
              }
              callBot(bot);
            }}
          />
          {!active && !activeGroup && initialBotsLoaded ? (
            <div className="grid flex-1 place-items-center">
              <Button onClick={() => dialogs.setCreateBotOpen(true)}>
                <Plus size={16} aria-hidden="true" />
                <Trans>New bot</Trans>
              </Button>
            </div>
          ) : (
            <Transcript
              key={activeSnapshot?.threadId}
              meId={userId}
              scrollRef={thread.messageScroll}
              scrollRequest={scrollRequest}
              onScrollRequestHandled={clearScrollRequest}
              followRequest={composer.sentCount}
              artifactTarget={transcriptArtifactTarget}
              markedUnreadMessageId={read.markedUnreadMessageId}
              transcript={transcript}
              showToolActivity={showToolActivity}
              olderCursor={activeSnapshot?.olderCursor ?? null}
              unreadAfterSeq={read.unreadAfterSeq}
              loadingOlder={loadingOlder}
              answerableAskIds={answerableAskIds}
              dismissableAskIds={dismissableAskIds}
              running={transcriptRunning}
              workingBots={workingBots}
              workingRoutine={workingRoutineName(workingRuns)}
              userBubble={userBubble}
              onCallBack={
                bootstrapMe?.phoneCallsEnabled && !inGroup && active
                  ? () => callBot(active)
                  : undefined
              }
              onLoadOlder={loadOlder}
              onOpenBot={openBot}
              onAnswer={composer.answerMessage}
              onReply={replyToMessage}
              onMarkUnread={markMessageUnread}
              onQuote={quoteMessage}
              onReact={composer.reactToMessage}
              onJumpToMessage={jumpToReplyMessage}
              onOpenPeerMessages={openPeerMessages}
              memberName={resolveTranscriptMemberName}
              peerBot={resolveTranscriptBot}
              onRefresh={refreshActiveThread}
              onBotChanged={refreshBots}
              onAddRoutine={addSkillRoutine}
              voiceReady={Boolean(voiceStatus?.ready)}
              speakingMessageId={speakingMessageId}
              callHoldsSpeaker={callHoldsSpeaker}
              onSpeak={speakMessage}
              onOpenComputer={computerControls.onOpenComputer}
              onReleaseComputer={computerControls.onReleaseComputer}
              onOpenImportSetup={openImportSetup}
              rpc={rpc}
            />
          )}
        </div>
        {active || activeGroup ? (
          // Let messages continue behind the composer's rounded top corners.
          <div className="pointer-events-none relative z-30 -mt-7">
            {recordingSkill ? (
              <div className="pointer-events-auto bg-background px-6 pb-2 text-center text-body-sm text-destructive">
                <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
              </div>
            ) : null}
            <Composer
              key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
              draftKey={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
              enterToSend={enterToSend}
              sendColors={userBubble}
              activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
              running={composerRunning}
              disabled={Boolean(recordingSkill)}
              pendingAttachments={composer.activePendingAttachments}
              attachmentNotice={composer.attachmentNotice}
              sendError={sendError}
              imageConfirmation={composer.imageConfirmation}
              onDraftEdited={composer.clearImageConfirmation}
              onOpenModels={() => {
                // A group's failed run belongs to one member; change that bot's model.
                const failedBotId =
                  inGroup && composer.displayedRunError ? activeSnapshot?.run?.botId : null;
                if (active && !inGroup) {
                  setPanel("settings");
                  setModelFocusRequest(Date.now());
                } else if (failedBotId) {
                  openChatSettings("bot", failedBotId);
                  setModelFocusRequest(Date.now());
                } else openSettings("models");
              }}
              onOpenConnections={() => openSettings("models")}
              onOpenBilling={() => openSettings("billing")}
              runError={composer.displayedRunError}
              runErrorId={composer.displayedRunErrorId}
              onRunErrorPresented={composer.handleRunErrorPresented}
              onDismissError={composer.dismissComposerError}
              sending={sending}
              fileInputRef={composer.fileInputRef}
              onAttachmentPick={composer.onAttachmentPick}
              onRemoveAttachment={composer.removeAttachment}
              onSend={composer.sendMessage}
              onStop={stopRun}
              phoneCallsEnabled={bootstrapMe?.phoneCallsEnabled === true}
              dictationTranscribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
              artifactTarget={transcriptArtifactTarget}
              replyTarget={composer.replyTarget}
              replyQuote={composer.replyQuote}
              replyTargetName={replyTargetName}
              onClearReply={composer.clearReply}
              mentionTargets={composerMentionTargets}
              agentSkills={agentSkills}
              onSlashOpen={refreshAgentSkills}
              onSlashAction={(action) => {
                if (action === "chat-settings") {
                  setPanel(inGroup ? "group-settings" : "settings");
                  return;
                }
                if (action === "settings-general") {
                  openSettings("general");
                  return;
                }
                if (action === "settings-usage") {
                  openSettings("usage");
                }
              }}
            />
          </div>
        ) : null}
      </main>

      <PageViewHost />
      <CallCard onSettings={() => openSettings("voice")} />
      <IncomingCall
        bots={bootstrapMe?.phoneCallsEnabled ? bots : []}
        transcribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
        onAnswered={(botId) => navigate(`/app/${botId}`)}
      />

      <ShellSidePanel
        rpc={rpc}
        panel={panel}
        setPanel={setPanel}
        active={active}
        activeGroup={activeGroup}
        bots={bots}
        groups={groups}
        setBots={setBots}
        setGroups={setGroups}
        navigate={navigate}
        refreshBots={refreshBots}
        refreshThread={refreshThread}
        refreshGroupThread={refreshGroupThread}
        discardChatAttachments={composer.discardThreadAttachments}
        computer={computer}
        computerOpen={computerOpen}
        computerPanel={
          active ? (
            <ComputerPanel
              bot={active}
              computer={computer}
              computerOpen={computerOpen}
              embeddedScreenUrl={computerControls.embeddedScreenUrl}
              screenFrameKey={computerState.screenFrameKey}
              heldScreen={computerState.heldScreen}
              screenFrameRef={computerState.setScreenFrame}
              computerScreenError={computerControls.computerScreenError}
              computerBooting={computerControls.computerBooting}
              booting={booting}
              showingRecoveryHint={computerControls.showingRecoveryHint}
              showComputerRecoveryHint={computerControls.showComputerRecoveryHint}
              sandboxProvider={bootstrapMe?.sandboxProvider}
              onRecovered={(sandboxProvider) => {
                setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev));
                computerControls.holdComputerRecovery();
              }}
              onRecoveryDismissed={computerControls.releaseComputerRecovery}
              onOpenComputerSettings={
                bootstrapMe?.computerSettingsEnabled === true
                  ? () => openSettings("computer")
                  : undefined
              }
              onOpen={() => void openComputer()}
              cleaningUpDisk={cleaningUpDisk}
              onCleanUpDisk={() => {
                const botId = active.id;
                setCleaningUpDisk(true);
                void rpc.threads
                  .send({
                    botId,
                    clientNonce: newClientId(),
                    text: t`Your computer's disk is nearly full. Free up space by removing build output and caches you no longer need.`,
                  })
                  .then(async () => {
                    // The refresh must read the dismissal, or it would paint the warning again.
                    await dismissDiskWarning(botId);
                    void refreshThread(botId);
                  })
                  .catch((error: unknown) => composer.setSendError(errorText(error)))
                  .finally(() => setCleaningUpDisk(false));
              }}
              onDismissDiskWarning={() => void dismissDiskWarning(active.id)}
            />
          ) : null
        }
        routinesPanel={
          <RoutineList
            routines={activeRoutines}
            loaded={routinesLoaded}
            runningRoutineId={
              snapshot?.run && isActive(snapshot.run.status)
                ? (snapshot.run.routineId ?? undefined)
                : undefined
            }
            onCreate={() => startRoutine()}
            onEdit={startRoutine}
            onStop={() => void stopRun()}
          />
        }
        routineEditorProps={routineEditorProps}
        openBot={openBot}
        openCreatedBot={openCreatedBot}
        modelFocusRequest={modelFocusRequest}
        openSettings={openSettings}
        memoryProviderConfigured={memoryProviderConfig != null}
        setAgentSkills={setAgentSkills}
        onClearBot={(bot) => dialogs.setClearTarget({ kind: "bot", chat: bot })}
      />

      <Suspense fallback={null}>
        <ShellDialogs
          dialogs={dialogs}
          rpc={rpc}
          spaces={spaces}
          bots={bots}
          activeId={active?.id}
          activeGroupId={activeGroup?.id}
          alive={alive}
          navigate={navigate}
          setPanel={setPanel}
          refreshBots={refreshBots}
          removeSpace={removeSpace}
          openSpaceSettings={openSpaceSettings}
          closeMobileSidebar={() => setMobileSidebarOpen(false)}
          createBot={createBot}
          botAvatarSet={bootstrapMe?.botAvatarSet ?? DEFAULT_NEW_BOT_AVATAR_SET}
          discardChatAttachments={composer.discardThreadAttachments}
          clearOpenThread={() => {
            thread.resetHistory();
            thread.updateSnapshot((current) =>
              current ? { ...current, messages: [], olderCursor: null, run: null } : current,
            );
          }}
          deleteRoutineDialogProps={deleteRoutineDialogProps}
          paletteActions={paletteActions}
        />
        <AppOverlays
          overlay={overlay}
          setOverlay={setOverlay}
          activeBotId={activeBotId.current}
          stdioEnabled={bootstrapMe?.mcpStdioEnabled === true}
          onConnectedAppsChange={setFooterLogos}
          onOpenBot={openCreatedBot}
        />
      </Suspense>

      <Suspense fallback={null}>
        <SettingsOverlays
          rpc={rpc}
          queries={queries}
          overlay={overlay}
          setOverlay={setOverlay}
          settingsSpace={settingsSpace}
          showSettings={settingsSpaceId === null || Boolean(settingsSpace)}
          spaces={spaces}
          renameSpace={renameSpace}
          removeSpace={removeSpace}
          leftSpace={leftSpace}
          refreshSpaces={() => refreshBots()}
          openAgentImport={() => setPanel("import-agent")}
          alive={alive}
          user={session.data?.user}
          refetchSession={() => session.refetch({ query: { disableCookieCache: true } })}
          bootstrapMe={bootstrapMe}
          setBootstrapMe={setBootstrapMe}
          messagingEnabled={messagingSurfaceEnabled}
          memoryConfig={memoryProviderConfig}
          peerConversation={peerConversation}
          setPeerConversation={setPeerConversation}
          active={active}
          peerBot={resolveTranscriptBot}
        />
      </Suspense>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        host={{ desktop: Boolean(desktopBridge()), apple: isApplePlatform() }}
        dictation={Boolean(bootstrapMe?.phoneCallsEnabled)}
      />

      {computerOpen && computerBot ? (
        <ComputerOverlay
          bot={computerBot}
          computer={computer}
          computerViewport={computerState.computerViewport}
          recordingSkill={recordingSkill}
          teachBusy={teachBusy}
          hasControl={computerControls.hasControl}
          composerRunning={composerRunning}
          sending={sending}
          booting={booting}
          sendError={sendError}
          embeddedScreenUrl={computerControls.embeddedScreenUrl}
          screenFrameKey={computerState.screenFrameKey}
          heldScreen={computerState.heldScreen}
          screenFrameRef={computerState.setScreenFrame}
          computerScreenError={computerControls.computerScreenError}
          computerBooting={computerControls.computerBooting}
          onStopTeaching={stopTeaching}
          onStopRun={() => void stopRun()}
          onRelease={computerControls.releaseComputer}
          onTakeControl={() => void openComputer(computerBot.id, true)}
          onStart={() => void openComputer(computerBot.id)}
          onRefreshTeaching={refreshActiveTeaching}
          onClose={() => setComputerOpen(false)}
        />
      ) : null}
    </BotsSidebarLayout>
  );

  // Empty chrome until the first bot list lands would flash "Select a bot" before the chat.
  return (
    <SpaceRpcProvider spaceId={shellSpaceId}>
      {initialBotsLoaded || initialLoadFailed ? (
        <PagesProvider value={pages}>{shell}</PagesProvider>
      ) : (
        <PageLoading />
      )}
    </SpaceRpcProvider>
  );
}
