import { AgentContentView } from '@/components/AgentContentView';
import { MobileGlassBackdrop } from '@/components/MobileGlass';
import { AgentGoalBar, type AgentGoalAction } from '@/components/AgentGoalBar';
import { AgentInput } from '@/components/AgentInput';
import { resolveVisibleAgentGoalStatus } from '@/components/agentGoalStatus';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    getRigCurrentModelOptionKey,
    resolveCurrentOption,
    EffortLevel,
} from '@/components/modelModeOptions';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { SessionStatusBar } from '@/components/SessionStatusBar';
import { Avatar } from '@/components/Avatar';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { getCurrentVoiceConversationId, getCurrentVoiceSessionDurationSeconds, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, sessionGoalAction, sessionSetAgentModes, spawnSideChat, sessionKill, sessionArchive } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionGitStatus, useSessionMessages, useSessionUsage, useSetting, useSideChatSessions } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking } from '@/track';
import { getVoiceMessageCount, getVoiceOnboardingPromptLoadCount } from '@/sync/persistence';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { resolveStatusBarGitBranch } from '@/utils/sessionStatusBar';
import { FilesSidebar, SidebarMode } from '@/components/FilesSidebar';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { FileViewPanel } from '@/components/FileViewPanel';
import { prefetchPierreDiff } from '@/components/diff/PierreDiffView';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { formatPathRelativeToHome, getResumeCommandBlock, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { performAgentGoalAction } from './agentGoalActionHandler';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import {
    getRigIdentity,
    getRigReasoningSelection,
    isRigMetadata,
    isRigModelSelectionEnabled,
    isRigPermissionSelectionEnabled,
    isRigReasoningSelectionEnabled,
    rigCanAbort,
    rigCanBrowseFiles,
    rigCanReadFiles,
    rigCanUseAttachments,
    rigCanUseShell,
} from '@/sync/rig';
import { RigActivityBar } from '@/components/RigActivityBar';

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const mobileHeaderHeight = deviceType === 'phone' && Platform.OS !== 'web'
        ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT)
        : headerHeight;
    const contentRunsUnderHeader = deviceType === 'phone'
        && Platform.OS !== 'web'
        && !isLandscape;
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');
    const [headerBackdropVisible, setHeaderBackdropVisible] = React.useState(false);

    React.useEffect(() => {
        setHeaderBackdropVisible(false);
    }, [sessionId]);

    // Base condition: can we show the diff sidebar at all?
    const canShowSidebar = fileDiffsSidebarEnabled
        && (isRunningOnMac() || Platform.OS === 'web')
        && windowWidth >= SIDEBAR_MIN_WINDOW_WIDTH
        && (!session || (rigCanBrowseFiles(session.metadata) && rigCanUseShell(session.metadata)))
        && isDataReady && !!session;

    const showSidebar = canShowSidebar && !zenMode;

    // Match left sidebar width: 30% of window, clamped to 250–360px
    const sidebarWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);

    // Animate diff sidebar width.
    //
    // On web we snap the value (duration: 0). The animated `width` change
    // triggers a flex-row reflow on every frame, which in turn re-measures
    // the entire chat tree (FlatList rows, message blocks). At ~60fps that
    // grinds to ~15fps on dev builds. Snapping skips the layout thrash —
    // the chat reflows once instead of 60 times. Native keeps the smooth
    // animation because it runs on Reanimated's UI thread.
    const sidebarAnim = useSharedValue(showSidebar ? 1 : 0);
    React.useEffect(() => {
        sidebarAnim.value = withTiming(showSidebar ? 1 : 0, {
            duration: Platform.OS === 'web' ? 0 : 250,
            easing: Easing.out(Easing.cubic),
        });
    }, [showSidebar]);
    const animatedSidebarStyle = useAnimatedStyle(() => ({
        width: sidebarAnim.value * sidebarWidth,
        opacity: sidebarAnim.value,
        overflow: 'hidden' as const,
    }));

    // Sidebar panels are user-managed and persisted in local settings so the
    // layout (which panels are open + which is active) survives reloads and
    // long absences. State is device-local, shared across sessions.
    const sidebarPanelsOpen = useLocalSetting('sidebarPanelsOpen') as SidebarMode[];
    const sidebarPanelActiveRaw = useLocalSetting('sidebarPanelActive') as SidebarMode | null;
    // Guard against an inconsistent persisted value: the active panel must be
    // one of the open panels, otherwise fall back to the last opened (or none).
    const sidebarPanelActive = React.useMemo<SidebarMode | null>(() => {
        if (sidebarPanelActiveRaw && sidebarPanelsOpen.includes(sidebarPanelActiveRaw)) {
            return sidebarPanelActiveRaw;
        }
        return sidebarPanelsOpen[sidebarPanelsOpen.length - 1] ?? null;
    }, [sidebarPanelActiveRaw, sidebarPanelsOpen]);

    const openSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const cur = storage.getState().localSettings.sidebarPanelsOpen as SidebarMode[];
        const open = cur.includes(panel) ? cur : [...cur, panel];
        storage.getState().applyLocalSettings({ sidebarPanelsOpen: open, sidebarPanelActive: panel });
    }, []);
    const selectSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const cur = storage.getState().localSettings.sidebarPanelsOpen as SidebarMode[];
        if (cur.includes(panel)) {
            storage.getState().applyLocalSettings({ sidebarPanelActive: panel });
        }
    }, []);
    // Raw panel removal (no side-chat teardown). Public closeSidebarPanel below
    // wraps this so closing the "Side chat" chip also tears down its children.
    const removeSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const state = storage.getState().localSettings;
        const open = (state.sidebarPanelsOpen as SidebarMode[]).filter((p) => p !== panel);
        const active = state.sidebarPanelActive === panel
            ? (open[open.length - 1] ?? null)
            : (state.sidebarPanelActive as SidebarMode | null);
        storage.getState().applyLocalSettings({ sidebarPanelsOpen: open, sidebarPanelActive: active });
    }, []);

    // Side chats live inside the single "sideChat" panel as switchable tabs.
    // Creation is unified into the sidebar panel picker (the top "+") so there
    // is no separate per-tab add button. Which side chat is focused lives here
    // (not in the panel) so the picker can create-and-focus a new one in one go.
    const rawSideChats = useSideChatSessions(sessionId);
    const sideChatForkSource = session ? getSessionForkSource(session) : null;
    const [activeSideChatId, setActiveSideChatId] = React.useState<string | null>(null);
    // Optimistically hide a side chat the instant it's closed. The server's
    // /archive only flips active=false (not lifecycleState), so if the CLI is
    // already dead the fallback archive wouldn't drop the tab via
    // useSideChatSessions — this makes the tab disappear immediately regardless.
    const [closedSideChatIds, setClosedSideChatIds] = React.useState<Set<string>>(() => new Set());
    const sideChats = React.useMemo(
        () => rawSideChats.filter((s) => !closedSideChatIds.has(s.id)),
        [rawSideChats, closedSideChatIds],
    );
    // Prune closed ids once the underlying sessions actually leave the store, so
    // the set can't grow without bound.
    React.useEffect(() => {
        setClosedSideChatIds((prev) => {
            if (prev.size === 0) return prev;
            const live = new Set(rawSideChats.map((s) => s.id));
            const next = new Set<string>();
            let changed = false;
            prev.forEach((id) => { if (live.has(id)) next.add(id); else changed = true; });
            return changed ? next : prev;
        });
    }, [rawSideChats]);

    // Best-effort close: kill the agent, fall back to server-side archive.
    const archiveSideChatSession = React.useCallback((id: string) => {
        (async () => {
            const killed = await sessionKill(id);
            if (!killed.success) {
                await sessionArchive(id);
            }
            try {
                await sync.refreshSessions();
            } catch {
                // Broadcast sync reconciles shortly even if this flaked.
            }
        })();
    }, []);

    const [creatingSideChat, createSideChat] = useHappyAction(async () => {
        if (!sideChatForkSource) {
            throw new HappyError(t('sideChat.unavailable'), false);
        }
        const result = await spawnSideChat(sideChatForkSource);
        if (result.type === 'error') {
            throw new HappyError(result.errorMessage, true);
        }
        if (result.type === 'success') {
            setActiveSideChatId(result.sessionId);
            openSidebarPanel('sideChat');
        }
    });

    const closeSideChat = React.useCallback((id: string) => {
        const idx = sideChats.findIndex((s) => s.id === id);
        const neighbour = idx !== -1 ? (sideChats[idx - 1] ?? sideChats[idx + 1] ?? null) : null;
        setActiveSideChatId(neighbour?.id ?? null);
        setClosedSideChatIds((prev) => new Set(prev).add(id));
        if (!neighbour) {
            removeSidebarPanel('sideChat');
        }
        archiveSideChatSession(id);
    }, [sideChats, removeSidebarPanel, archiveSideChatSession]);

    // Closing the "Side chat" panel chip tears down every side chat at once.
    const closeAllSideChats = React.useCallback(() => {
        const ids = sideChats.map((s) => s.id);
        setActiveSideChatId(null);
        setClosedSideChatIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.add(id));
            return next;
        });
        removeSidebarPanel('sideChat');
        ids.forEach(archiveSideChatSession);
    }, [sideChats, removeSidebarPanel, archiveSideChatSession]);

    const closeSidebarPanel = React.useCallback((panel: SidebarMode) => {
        if (panel === 'sideChat') {
            closeAllSideChats();
            return;
        }
        removeSidebarPanel(panel);
    }, [closeAllSideChats, removeSidebarPanel]);

    // Overlay state is managed as a browser-style history stack so the
    // sidebar's back / forward arrows can navigate between chat ↔ diff ↔ file
    // without a per-overlay close button. Stack + cursor live in one piece
    // of state so functional updates stay coordinated.
    type OverlayEntry =
        | { kind: 'none' }
        | { kind: 'diff'; file: string }
        | { kind: 'file'; path: string };
    const [overlayHistory, setOverlayHistory] = React.useState<{ stack: OverlayEntry[]; cursor: number }>(
        { stack: [{ kind: 'none' }], cursor: 0 }
    );
    const overlayCurrent = overlayHistory.stack[overlayHistory.cursor] ?? { kind: 'none' };
    const diffViewOpen = overlayCurrent.kind === 'diff';
    const fileViewPath = overlayCurrent.kind === 'file' ? overlayCurrent.path : null;
    const scrollToFile = overlayCurrent.kind === 'diff' ? overlayCurrent.file : null;

    const pushOverlay = React.useCallback((entry: OverlayEntry) => {
        setOverlayHistory((prev) => {
            const truncated = prev.stack.slice(0, prev.cursor + 1);
            truncated.push(entry);
            return { stack: truncated, cursor: truncated.length - 1 };
        });
    }, []);

    const handleSidebarFilePress = React.useCallback((file: GitFileStatus) => {
        if (file.status === 'deleted') return;
        pushOverlay({ kind: 'diff', file: file.fullPath });
    }, [pushOverlay]);
    const handleAllFilesFilePress = React.useCallback((filePath: string) => {
        pushOverlay({ kind: 'file', path: filePath });
    }, [pushOverlay]);

    // When sidebar capability is lost (screen too narrow, disabled), close views.
    // Don't close on zen mode toggle — keep the view visible.
    React.useEffect(() => {
        if (!canShowSidebar) {
            setOverlayHistory({ stack: [{ kind: 'none' }], cursor: 0 });
        }
    }, [canShowSidebar]);

    // Right-side header content published by the active overlay (diff toggle / save button).
    const [headerRightSlot, setHeaderRightSlot] = React.useState<React.ReactNode>(null);

    // Wire intra-session back / forward into the global SidebarNavigator arrows.
    const canOverlayBack = overlayHistory.cursor > 0;
    const canOverlayForward = overlayHistory.cursor < overlayHistory.stack.length - 1;
    React.useEffect(() => {
        useOverlayNav.getState().publish({
            canBack: canOverlayBack,
            canForward: canOverlayForward,
            back: () => {
                if (!canOverlayBack) return false;
                setOverlayHistory((prev) => (
                    prev.cursor <= 0 ? prev : { ...prev, cursor: prev.cursor - 1 }
                ));
                return true;
            },
            forward: () => {
                if (!canOverlayForward) return false;
                setOverlayHistory((prev) => (
                    prev.cursor >= prev.stack.length - 1 ? prev : { ...prev, cursor: prev.cursor + 1 }
                ));
                return true;
            },
        });
        return () => useOverlayNav.getState().reset();
    }, [canOverlayBack, canOverlayForward]);

    // Warm Pierre's lazy web chunks while the user is still reading chat.
    React.useEffect(() => {
        prefetchPierreDiff();
    }, []);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            return { title: '', folderName: undefined, isConnected: false, identityLine: undefined };
        }
        if (!session) {
            return { title: t('errors.sessionDeleted'), folderName: undefined, isConnected: false, identityLine: undefined };
        }
        const isConnected = session.presence === 'online';
        const pathSegments = session.metadata?.path?.split(/[/\\]/).filter(Boolean);
        const folderName = pathSegments?.[pathSegments.length - 1];
        const sessionName = getSessionName(session);
        const rigIdentity = getRigIdentity(session.metadata);
        return {
            title: sessionName,
            folderName,
            isConnected,
            identityLine: rigIdentity
                ? `${rigIdentity.clientName} · ${rigIdentity.providerName}${rigIdentity.modelName ? ` — ${rigIdentity.modelName}` : ''}`
                : undefined,
        };
    }, [session, isDataReady]);
    const headerRight = session && deviceType === 'phone' && Platform.OS !== 'web'
        ? (
            <Pressable
                onPress={() => router.push(`/session/${sessionId}/info`)}
                hitSlop={10}
            >
                <Avatar
                    id={getSessionAvatarId(session)}
                    size={28}
                    monochrome={!headerProps.isConnected}
                    flavor={session.metadata?.flavor}
                    clientId={session.metadata?.client?.id}
                />
            </Pressable>
        )
        : null;

    const mainContent = (
        <>
            <MobileGlassBackdrop enabled={deviceType === 'phone' && Platform.OS !== 'web'} />
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Content based on state */}
            <View
                style={{
                    flex: 1,
                    paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web')
                        ? contentRunsUnderHeader
                            ? 0
                            : safeArea.top + mobileHeaderHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 32 : 0)
                        : 0,
                }}
            >
                {!isDataReady ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    <SessionViewLoaded
                        key={sessionId}
                        sessionId={sessionId}
                        session={session}
                        onHeaderBackdropVisibilityChange={contentRunsUnderHeader
                            ? setHeaderBackdropVisible
                            : undefined}
                    />
                )}
            </View>

            {/* Render the overlay header after the dynamic list so native blur samples its content. */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        title={headerProps.title}
                        folderName={headerProps.folderName}
                        isConnected={headerProps.isConnected}
                        backdropVisible={headerBackdropVisible}
                        identityLine={headerProps.identityLine}
                        extraPathSegment={fileViewPath ?? undefined}
                        rightSlot={(diffViewOpen || !!fileViewPath) ? headerRightSlot : headerRight}
                        onTitlePress={session ? () => router.push(`/session/${sessionId}/info`) : undefined}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}
        </>
    );

    if (!canShowSidebar) {
        return mainContent;
    }

    // Desktop layout: chat + animated sidebar at the same level (full height).
    // When a sidebar file is selected, InlineFileDiff overlays the main content
    // (chat stays mounted underneath so state is preserved).
    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            <View
                style={{
                    flex: 1,
                    // Web-only: isolate the chat subtree's layout from the
                    // parent flex-row. If we ever bring back a width
                    // animation on the right sidebar, `contain` prevents
                    // layout work from leaking up to the chat tree on
                    // every frame.
                    ...(Platform.OS === 'web' ? { contain: 'layout style paint' as any } : {}),
                }}
            >
                {mainContent}
                {diffViewOpen && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + mobileHeaderHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <AllFilesDiffView
                            sessionId={sessionId}
                            scrollToFile={scrollToFile}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
                {fileViewPath && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + mobileHeaderHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <FileViewPanel
                            sessionId={sessionId}
                            filePath={fileViewPath}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
            </View>
            <Animated.View style={[{ minWidth: 0, alignSelf: 'stretch' }, animatedSidebarStyle]}>
                <View style={{ width: sidebarWidth, flex: 1 }}>
                    <FilesSidebar
                        sessionId={sessionId}
                        selectedPath={sidebarPanelActive === 'changes' ? scrollToFile : sidebarPanelActive === 'allFiles' ? fileViewPath : null}
                        onFilePress={handleSidebarFilePress}
                        openPanels={sidebarPanelsOpen}
                        activePanel={sidebarPanelActive}
                        onOpenPanel={openSidebarPanel}
                        onSelectPanel={selectSidebarPanel}
                        onClosePanel={closeSidebarPanel}
                        onAllFilesFilePress={handleAllFilesFilePress}
                        sideChats={sideChats}
                        activeSideChatId={activeSideChatId}
                        onSelectSideChat={setActiveSideChatId}
                        onCloseSideChat={closeSideChat}
                        onCreateSideChat={createSideChat}
                        canCreateSideChat={!!sideChatForkSource}
                        creatingSideChat={creatingSideChat}
                    />
                </View>
            </Animated.View>
        </View>
    );
});

const SIDEBAR_MIN_WINDOW_WIDTH = 1100;

// Hoisted so AgentInput's React.memo doesn't see a new array ref on every keystroke
const AGENT_INPUT_AUTOCOMPLETE_PREFIXES = ['@', '/'];

// Imperative handle exposed by ChatComposer so SessionViewLoaded can read /
// clear the message text without subscribing to it (which would re-render
// the whole loaded screen on every keystroke).
type ChatComposerHandle = {
    getMessage: () => string;
    clearMessage: () => void;
};

type ChatComposerProps = Omit<
    React.ComponentProps<typeof AgentInput>,
    'initialValue' | 'onChangeText'
> & {
    sessionId: string;
    composerHandleRef: React.RefObject<ChatComposerHandle | null>;
};

// Owns the chat-message draft autosave. The textarea itself is uncontrolled:
// keystrokes never round-trip through React state, so the parent can stay
// stable on every keystroke and deletion doesn't batch on a busy main thread.
// `message` here is a low-priority mirror updated via startTransition; it's
// only used to feed useDraft's debounced autosave. Reads/clears on send go
// through the MultiTextInput handle imperatively.
const ChatComposer = React.memo(function ChatComposer(props: ChatComposerProps) {
    const { sessionId, composerHandleRef, ...rest } = props;
    // Synchronously hydrate the textarea with any saved draft so the user sees
    // their work-in-progress on session open without an extra round-trip.
    const initialDraft = React.useMemo(() => {
        return storage.getState().sessions[sessionId]?.draft ?? '';
    }, [sessionId]);
    const inputHandleRef = React.useRef<MultiTextInputHandle>(null);
    const [message, setMessage] = React.useState(initialDraft);

    const applyDraft = React.useCallback((text: string) => {
        inputHandleRef.current?.setTextAndSelection(text, { start: text.length, end: text.length });
        setMessage(text);
    }, []);

    const { clearDraft } = useDraft(sessionId, message, applyDraft);

    const handleChangeText = React.useCallback((text: string) => {
        // Transition keeps the textarea responsive even when the draft
        // autosave / re-render takes longer than a frame.
        React.startTransition(() => setMessage(text));
    }, []);

    React.useImperativeHandle(composerHandleRef, () => ({
        getMessage: () => inputHandleRef.current?.getText() ?? '',
        clearMessage: () => {
            inputHandleRef.current?.setTextAndSelection('', { start: 0, end: 0 });
            setMessage('');
            clearDraft();
        },
    }), [clearDraft]);

    return (
        <AgentInput
            {...rest}
            ref={inputHandleRef}
            sessionId={sessionId}
            initialValue={initialDraft}
            onChangeText={handleChangeText}
        />
    );
});

export function SessionViewLoaded({
    sessionId,
    session,
    embedded = false,
    onHeaderBackdropVisibilityChange,
}: {
    sessionId: string;
    session: Session;
    embedded?: boolean;
    onHeaderBackdropVisibilityChange?: (visible: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const zenMode = useLocalSetting('zenMode');
    const sessionInputHorizontalPadding = Platform.OS === 'web' || isRunningOnMac() || isTablet ? 12 : 8;
    const chatListTopContentInset = embedded || (isLandscape && deviceType === 'phone')
        ? 12
        : deviceType === 'phone' && Platform.OS !== 'web'
            ? safeArea.top
                + MOBILE_GLASS_HEADER_HEIGHT
                + (realtimeStatus !== 'disconnected' ? 32 : 0)
                + 12
            : undefined;

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    const flavor = session.metadata?.flavor;
    const isRig = isRigMetadata(session.metadata);
    const availableModels = React.useMemo(() => (
        getAvailableModels(flavor, session.metadata, t, session.modelMode)
    ), [flavor, session.metadata, session.modelMode]);
    const availableModes = React.useMemo(() => (
        getAvailablePermissionModes(flavor, session.metadata, t, session.permissionMode)
    ), [flavor, session.metadata, session.permissionMode]);
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, flavor)
    ), [agentDefaultOverrides, flavor]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session.permissionMode,
            ...(isRig ? [
                session.metadata?.currentOperatingModeCode,
                session.metadata?.permissionMode,
                session.metadata?.session?.permissionMode,
            ] : [
                effectiveAgentDefaults.permissionMode,
                session.metadata?.currentOperatingModeCode,
            ]),
        ])
    ), [availableModes, session.permissionMode, effectiveAgentDefaults.permissionMode, session.metadata?.currentOperatingModeCode, session.metadata?.permissionMode, session.metadata?.session?.permissionMode, isRig]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            session.modelMode,
            isRig ? getRigCurrentModelOptionKey(session.metadata) : effectiveAgentDefaults.modelMode,
            isRig ? undefined : session.metadata?.currentModelCode,
        ])
    ), [availableModels, session.modelMode, effectiveAgentDefaults.modelMode, session.metadata, isRig]);

    // Effort level state
    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(() => (
        getEffortLevelsForModel(flavor, modelKey, session.metadata)
    ), [flavor, modelKey, session.metadata]);
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        resolveCurrentOption(availableEffortLevels, [
            session.effortLevel,
            isRig ? getRigReasoningSelection(session.metadata, modelKey) : effectiveAgentDefaults.effortLevel,
        ])
    ), [availableEffortLevels, session.effortLevel, effectiveAgentDefaults.effortLevel, session.metadata, modelKey, isRig]);

    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const gitStatus = useSessionGitStatus(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const sessionStatusBarDisplay = useSetting('sessionStatusBarDisplay');
    const experiments = useSetting('experiments');
    const expResumeSession = useSetting('expResumeSession');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);

    // Image attachment state (expImageUpload feature flag)
    const expImageUpload = useSetting('expImageUpload');
    const { selectedImages, pickImages, removeImage, clearImages, addImages } = useImagePicker();
    const canUseAttachments = rigCanUseAttachments(session.metadata);
    React.useEffect(() => {
        if (!canUseAttachments && selectedImages.length > 0) {
            clearImages();
        }
    }, [canUseAttachments, selectedImages.length, clearImages]);

    // ChatComposer owns the message state + useDraft subscription. We only
    // hold an imperative handle so handleSend can read the live text and
    // clear it without subscribing to it (which would re-render the whole
    // SessionViewLoaded tree on every keystroke).
    const composerHandleRef = React.useRef<ChatComposerHandle | null>(null);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        sessionSetAgentModes(sessionId, { permissionMode: mode.key });
    }, [sessionId]);

    const updateModelMode = React.useCallback((mode: ModelMode) => {
        const nextEffortLevels = getEffortLevelsForModel(flavor, mode.key, session.metadata);
        const currentEffortSupported = session.effortLevel
            ? nextEffortLevels.some((level) => level.key === session.effortLevel)
            : true;
        sessionSetAgentModes(sessionId, {
            modelMode: mode.key,
            ...(!currentEffortSupported ? { effortLevel: mode.defaultThinkingLevel ?? null } : {}),
        });
    }, [sessionId, flavor, session.metadata, session.effortLevel]);

    const updateEffortLevel = React.useCallback((level: EffortLevel) => {
        sessionSetAgentModes(sessionId, { effortLevel: level.key });
    }, [sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);

    // handleSend reads the live message via the composer ref, so it doesn't
    // need to re-create on every keystroke.
    const handleSend = React.useCallback(() => {
        const liveMessage = composerHandleRef.current?.getMessage() ?? '';
        if (liveMessage.trim() || (expImageUpload && selectedImages.length > 0)) {
            const attachments = expImageUpload ? selectedImages : undefined;
            composerHandleRef.current?.clearMessage();
            if (expImageUpload) clearImages();
            sync.sendMessage(sessionId, liveMessage, { source: 'chat', attachments });
        }
    }, [sessionId, expImageUpload, selectedImages, clearImages]);

    const handleAbort = React.useCallback(() => {
        // Mode picks live in synced metadata — clear them there, otherwise the
        // next inbound metadata update resurrects them (#1492)
        if (!isRig) {
            sessionSetAgentModes(sessionId, { permissionMode: null, modelMode: null, effortLevel: null });
        }
        sessionAbort(sessionId);
    }, [sessionId, isRig]);

    const handleFileViewerPress = React.useCallback(() => {
        router.push(`/session/${sessionId}/files`);
    }, [router, sessionId]);

    const handleAutocompleteSuggestions = React.useCallback((query: string) => (
        getSuggestions(sessionId, query)
    ), [sessionId]);

    const connectionStatus = React.useMemo(() => ({
        text: sessionStatus.statusText,
        color: sessionStatus.statusColor,
        dotColor: sessionStatus.statusDotColor,
        isPulsing: sessionStatus.isPulsing,
    }), [sessionStatus.statusText, sessionStatus.statusColor, sessionStatus.statusDotColor, sessionStatus.isPulsing]);

    const usageData = React.useMemo(() => {
        const source = sessionUsage ?? session.latestUsage;
        if (!source) return undefined;
        return {
            inputTokens: source.inputTokens,
            outputTokens: source.outputTokens,
            cacheCreation: source.cacheCreation,
            cacheRead: source.cacheRead,
            contextSize: source.contextSize,
            contextWindow: source.contextWindow,
        };
    }, [sessionUsage, session.latestUsage]);
    const metadataGitBranch = React.useMemo(() => {
        const gitBranch = (session.metadata as { gitBranch?: unknown } | null)?.gitBranch;
        return typeof gitBranch === 'string' && gitBranch.trim() ? gitBranch.trim() : null;
    }, [session.metadata]);
    const statusBarGitBranch = resolveStatusBarGitBranch(gitStatus?.branch, metadataGitBranch);
    const statusBarModelLabel = modelMode?.name ?? session.metadata?.currentModelCode ?? session.modelMode ?? null;
    const statusBarEffortLabel = effortLevel?.name
        ? effortLevel.name.charAt(0).toUpperCase() + effortLevel.name.slice(1)
        : null;

    const visibleAgentGoal = React.useMemo(() => (
        resolveVisibleAgentGoalStatus(session)
    ), [
        session.agentState?.agentGoalStatus,
        session.presence,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const [goalActionInFlight, setGoalActionInFlight] = React.useState<AgentGoalAction | null>(null);
    const handleGoalAction = React.useCallback(async (action: AgentGoalAction) => {
        await performAgentGoalAction({
            action,
            currentGoalText: visibleAgentGoal?.text ?? '',
            promptEditGoal: (currentGoalText) => Modal.prompt(t('components.agentGoalBar.editGoal'), undefined, {
                placeholder: t('components.agentGoalBar.currentGoal'),
                defaultValue: currentGoalText,
                cancelText: t('common.cancel'),
                confirmText: t('common.save'),
            }),
            dispatchGoalAction: (nextAction, objective) => sessionGoalAction(sessionId, nextAction, objective),
            setInFlight: setGoalActionInFlight,
            onError: (error) => console.error('Failed to perform goal action', error),
        });
    }, [sessionId, visibleAgentGoal?.text]);

    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return; // Prevent actions during transitions
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                const conversationId = await startRealtimeSession(sessionId, initialPrompt);
                if (conversationId) {
                    const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
                    tracking?.capture('voice_session_started', {
                        session_id: sessionId,
                        elevenlabs_conversation_id: conversationId,
                        has_pro: hasPro,
                        onboarding_prompt_load_count: getVoiceOnboardingPromptLoadCount(),
                        voice_message_count: getVoiceMessageCount(),
                    });
                }
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_session_error', {
                    session_id: sessionId,
                    elevenlabs_conversation_id: getCurrentVoiceConversationId(),
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        } else if (realtimeStatus === 'connected') {
            const conversationId = getCurrentVoiceConversationId();
            const durationSeconds = getCurrentVoiceSessionDurationSeconds();
            await stopRealtimeSession();
            tracking?.capture('voice_session_stopped', {
                session_id: sessionId,
                elevenlabs_conversation_id: conversationId,
                ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
            });

            // Notify voice assistant about voice session stop
            voiceHooks.onVoiceStopped();
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting'
    }), [handleMicrophonePress, realtimeStatus]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);

        // Mark session as currently being viewed (clears unread). Skipped when
        // embedded (e.g. the side-chat panel) so a second mounted chat body
        // doesn't steal "currently viewing" from the primary session.
        if (!embedded) {
            storage.getState().setCurrentViewingSession(sessionId);
        }

        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        return () => {
            if (embedded) {
                return;
            }
            // Clear viewing session on unmount
            const current = storage.getState().currentViewingSessionId;
            if (current === sessionId) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [sessionId, realtimeStatus, embedded]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList
                        session={session}
                        topContentInset={chatListTopContentInset}
                        headerOverlayHeight={safeArea.top + MOBILE_GLASS_HEADER_HEIGHT}
                        onHeaderBackdropVisibilityChange={onHeaderBackdropVisibilityChange}
                    />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const composer = (
        <ChatComposer
            composerHandleRef={composerHandleRef}
            placeholder={t('session.inputPlaceholder')}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={isRigPermissionSelectionEnabled(session.metadata) ? updatePermissionMode : undefined}
            availableModes={availableModes}
            modelMode={modelMode}
            availableModels={availableModels}
            onModelModeChange={isRigModelSelectionEnabled(session.metadata) ? updateModelMode : undefined}
            effortLevel={effortLevel}
            availableEffortLevels={availableEffortLevels}
            onEffortLevelChange={isRigReasoningSelectionEnabled(session.metadata) ? updateEffortLevel : undefined}
            metadata={session.metadata}
            connectionStatus={connectionStatus}
            blockSend={isRig && session.thinking && session.metadata?.capabilities?.steering !== true}
            onSend={handleSend}
            onMicPress={(embedded || isDisconnected) ? undefined : micButtonState.onMicPress}
            isMicActive={(embedded || isDisconnected) ? false : micButtonState.isMicActive}
            onAbort={isDisconnected || !rigCanAbort(session.metadata) ? undefined : handleAbort}
            showAbortButton={rigCanAbort(session.metadata) && (Platform.OS === 'web'
                ? sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'
                : sessionStatus.state === 'thinking')}
            onFileViewerPress={experiments && !isTablet && rigCanBrowseFiles(session.metadata) && rigCanReadFiles(session.metadata) ? handleFileViewerPress : undefined}
            selectedImages={expImageUpload && canUseAttachments ? selectedImages : undefined}
            onPickImages={expImageUpload && canUseAttachments ? pickImages : undefined}
            onRemoveImage={expImageUpload && canUseAttachments ? removeImage : undefined}
            onAddImages={expImageUpload && canUseAttachments ? addImages : undefined}
            autocompletePrefixes={AGENT_INPUT_AUTOCOMPLETE_PREFIXES}
            autocompleteSuggestions={handleAutocompleteSuggestions}
            usageData={usageData}
            alwaysShowContextSize={alwaysShowContextSize}
            zenMode={zenMode}
            showSessionStatusInfoInSettings={false}
            sessionStatusGitBranch={statusBarGitBranch}
            sessionStatusModelLabel={statusBarModelLabel}
            sessionStatusEffortLabel={statusBarEffortLabel}
        />
    );

    // Disconnected sessions get the full Resume affordance regardless of
    // whether they were explicitly archived or just lost their CLI (e.g.
    // Ctrl-C in terminal — lifecycleState stays 'running', server flips
    // active=false). InactiveArchivedHint handles both cases: shows the
    // Resume button when canResume is true, falls back to the
    // copy-this-command hint when the experiments toggle is off or the
    // machine isn't reachable.
    const inactiveHint = isDisconnected && !isRig ? (
        <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
            <InactiveArchivedHint
                resumeCommandBlock={expResumeSession ? resumeCommandBlock : null}
                canResume={canResume}
                resuming={resumingSession}
                onResume={resumeSession}
            />
        </CenteredInputWidth>
    ) : null;

    const showSessionStatusBar = sessionStatusBarDisplay === 'above' || sessionStatusBarDisplay === 'below';
    const sessionStatusBarPosition = sessionStatusBarDisplay === 'above' ? 'above' : 'below';
    const sessionStatusBar = showSessionStatusBar ? (
        <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
            <SessionStatusBar
                gitBranch={statusBarGitBranch}
                modelLabel={statusBarModelLabel}
                modelMode={modelMode}
                availableModels={availableModels}
                onModelModeChange={isRigModelSelectionEnabled(session.metadata) ? updateModelMode : undefined}
                effortLabel={statusBarEffortLabel}
                effortLevel={effortLevel}
                availableEffortLevels={availableEffortLevels}
                onEffortLevelChange={isRigReasoningSelectionEnabled(session.metadata) ? updateEffortLevel : undefined}
                contextSize={usageData?.contextSize}
                contextWindow={usageData?.contextWindow}
                usageLimits={session.agentState?.usageLimits}
            />
        </CenteredInputWidth>
    ) : null;

    const input = (
        <>
            {inactiveHint}
            {visibleAgentGoal && (
                <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                    <AgentGoalBar
                        goal={visibleAgentGoal}
                        onAction={handleGoalAction}
                        inFlightAction={goalActionInFlight}
                    />
                </CenteredInputWidth>
            )}
            {sessionStatusBarPosition === 'above' ? sessionStatusBar : null}
            <RigActivityBar metadata={session.metadata} />
            {composer}
            {sessionStatusBarPosition === 'below' ? sessionStatusBar : null}
        </>
    );


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 8 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}

function InactiveArchivedHint(props: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>> | null;
    canResume: boolean;
    resuming: boolean;
    onResume: () => void;
}) {
    const { theme } = useUnistyles();
    const hintTextStyle = {
        color: theme.colors.agentEventText,
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'left' as const,
    };

    return (
        <View style={{
            paddingTop: 12,
            paddingBottom: 10,
            gap: 10,
            alignItems: 'stretch',
        }}>
            <View style={{ paddingHorizontal: 8, gap: 4 }}>
                <Text style={hintTextStyle}>
                    {t('session.inactiveArchived')}
                </Text>
                {props.canResume ? null : props.resumeCommandBlock && (
                    <Text style={hintTextStyle}>
                        {t('session.resumeFromTerminal')}
                    </Text>
                )}
            </View>
            {props.canResume ? (
                <Pressable
                    onPress={props.onResume}
                    disabled={props.resuming}
                    style={({ pressed }) => ({
                        height: Platform.select({ web: 40, default: 44 }),
                        borderRadius: Platform.select({ web: 10, default: 18 }),
                        backgroundColor: Platform.select({
                            web: theme.colors.button.primary.background,
                            default: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                        }),
                        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
                        borderColor: theme.colors.divider,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: props.resuming ? 0.6 : Platform.OS === 'web' && pressed ? 0.8 : 1,
                        marginHorizontal: 8,
                    })}
                >
                    {props.resuming ? (
                        <ActivityIndicator size="small" color={Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text })} />
                    ) : (
                        <Text style={{ color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }), fontSize: 15, fontWeight: '600' }}>
                            {t('sessionInfo.resumeSession')}
                        </Text>
                    )}
                </Pressable>
            ) : props.resumeCommandBlock && (
                <ResumeCommandCopyBlock resumeCommandBlock={props.resumeCommandBlock} />
            )}
        </View>
    );
}

function ResumeCommandCopyBlock({ resumeCommandBlock }: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>>;
}) {
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);

    return (
        <Pressable
            onPress={async () => {
                await Clipboard.setStringAsync(resumeCommandBlock.copyText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
            style={({ pressed }) => ({
                minHeight: 48,
                borderRadius: Platform.select({ web: 14, default: 18 }),
                backgroundColor: Platform.select({
                    web: theme.colors.surfaceHigh,
                    default: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                }),
                borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
                borderColor: theme.colors.divider,
                flexDirection: 'row',
                gap: 8,
                paddingHorizontal: 16,
                paddingVertical: 12,
                alignItems: 'flex-start',
            })}
        >
            <View style={{ flex: 1 }}>
                {resumeCommandBlock.lines.map((line, index) => (
                    <Text
                        key={`${line}-${index}`}
                        style={{
                            color: theme.colors.text,
                            fontSize: 13,
                            lineHeight: 18,
                            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                        }}
                    >
                        {line}
                    </Text>
                ))}
            </View>
            <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? '#30D158' : theme.colors.textSecondary}
                style={{ marginTop: 1 }}
            />
        </Pressable>
    );
}

function CenteredInputWidth(props: {
    children: React.ReactNode;
    horizontalPadding: number;
}) {
    return (
        <View style={{
            width: '100%',
            paddingHorizontal: props.horizontalPadding,
            alignItems: 'center',
        }}>
            <View style={{
                width: '100%',
                maxWidth: layout.maxWidth,
            }}>
                {props.children}
            </View>
        </View>
    );
}
