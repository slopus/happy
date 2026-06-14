import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    resolveCurrentOption,
    EffortLevel,
} from '@/components/modelModeOptions';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { getCurrentVoiceConversationId, getCurrentVoiceSessionDurationSeconds, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, sessionUpdateMetadata } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionGitStatusFiles, useSessionMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { appendRunReviewEvent, createRunReviewEvent, getFinalRunReviewEvent, getRunReviewEvents, RUN_REVIEW_CLOCK_INTERVAL_MS, type RunReviewActionEvent } from '@/sync/runReviewState';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking } from '@/track';
import { getVoiceMessageCount, getVoiceOnboardingPromptLoadCount } from '@/sync/persistence';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { FilesSidebar, SidebarMode } from '@/components/FilesSidebar';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { FileViewPanel } from '@/components/FileViewPanel';
import { prefetchPierreDiff } from '@/components/diff/PierreDiffView';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { formatPathRelativeToHome, getResumeCommandBlock, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
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
import { useUnistyles } from 'react-native-unistyles';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';

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
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');

    // Base condition: can we show the diff sidebar at all?
    const canShowSidebar = fileDiffsSidebarEnabled
        && (isRunningOnMac() || Platform.OS === 'web')
        && windowWidth >= SIDEBAR_MIN_WINDOW_WIDTH
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

    const [sidebarMode, setSidebarMode] = React.useState<SidebarMode>('changes');

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
    const handleOpenChangeEvidence = React.useCallback(() => {
        pushOverlay({ kind: 'diff', file: '' });
    }, [pushOverlay]);
    const handleOpenFileListEvidence = React.useCallback(() => {
        router.push(`/session/${sessionId}/files`);
    }, [router, sessionId]);

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
            return { title: '', folderName: undefined, isConnected: false };
        }
        if (!session) {
            return { title: t('errors.sessionDeleted'), folderName: undefined, isConnected: false };
        }
        const isConnected = session.presence === 'online';
        const pathSegments = session.metadata?.path?.split(/[/\\]/).filter(Boolean);
        const folderName = pathSegments?.[pathSegments.length - 1];
        const sessionName = getSessionName(session);
        return {
            title: sessionName,
            folderName,
            isConnected,
        };
    }, [session, isDataReady]);

    const mainContent = (
        <>
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

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
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
                        extraPathSegment={fileViewPath ?? undefined}
                        rightSlot={(diffViewOpen || !!fileViewPath) ? headerRightSlot : null}
                        onTitlePress={session ? () => router.push(`/session/${sessionId}/info`) : undefined}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 32 : 0) : 0 }}>
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
                        onOpenChangeEvidence={canShowSidebar ? handleOpenChangeEvidence : handleOpenFileListEvidence}
                    />
                )}
            </View>
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
                            top: safeArea.top + headerHeight,
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
                            top: safeArea.top + headerHeight,
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
                        selectedPath={sidebarMode === 'changes' ? scrollToFile : fileViewPath}
                        onFilePress={handleSidebarFilePress}
                        mode={sidebarMode}
                        onModeChange={setSidebarMode}
                        onAllFilesFilePress={handleAllFilesFilePress}
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

type RunReviewRiskTone = 'neutral' | 'warning' | 'danger' | 'success';

type RunReviewRiskBadge = {
    key: string;
    label: string;
    tone: RunReviewRiskTone;
    evidence: string;
    available: boolean;
};

type RunReviewModel = {
    title: string;
    summary: string;
    source: string;
    timing: string;
    runtime: string;
    evidenceSummary: string;
    riskBadges: RunReviewRiskBadge[];
    changedFileCount: number;
    toolCallCount: number;
    permissionDecisionCount: number;
    latestToolMessageId: string | null;
    exportText: string;
};

const SILENT_RUN_WARNING_MS = 60 * 60 * 1000;
const SILENT_RUN_DANGER_MS = 4 * 60 * 60 * 1000;
const BROAD_FILE_CHANGE_COUNT = 10;
const BROAD_FILE_CHANGE_LINES = 500;

function useRunReviewClock(session: Session): number {
    const [now, setNow] = React.useState(() => Date.now());
    const shouldTick = session.presence === 'online' && (session.thinking || session.active);

    React.useEffect(() => {
        if (!shouldTick) {
            setNow(Date.now());
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), RUN_REVIEW_CLOCK_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [shouldTick]);

    return now;
}

function SessionViewLoaded({ sessionId, session, onOpenChangeEvidence }: {
    sessionId: string,
    session: Session,
    onOpenChangeEvidence?: () => void,
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const zenMode = useLocalSetting('zenMode');
    const { width: windowWidth } = useWindowDimensions();
    const sessionInputHorizontalPadding = Platform.OS === 'web' || isRunningOnMac() || isTablet ? 12 : 8;
    const reviewClockNow = useRunReviewClock(session);
    const reviewEvents = React.useMemo(() => getRunReviewEvents(session.metadata), [session.metadata]);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    const flavor = session.metadata?.flavor;
    const availableModels = React.useMemo(() => (
        getAvailableModels(flavor, session.metadata, t)
    ), [flavor, session.metadata]);
    const availableModes = React.useMemo(() => (
        getAvailablePermissionModes(flavor, session.metadata, t)
    ), [flavor, session.metadata]);
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, flavor)
    ), [agentDefaultOverrides, flavor]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session.permissionMode,
            effectiveAgentDefaults.permissionMode,
            session.metadata?.currentOperatingModeCode,
        ])
    ), [availableModes, session.permissionMode, effectiveAgentDefaults.permissionMode, session.metadata?.currentOperatingModeCode]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            session.modelMode,
            effectiveAgentDefaults.modelMode,
            session.metadata?.currentModelCode,
        ])
    ), [availableModels, session.modelMode, effectiveAgentDefaults.modelMode, session.metadata?.currentModelCode]);

    // Effort level state
    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(() => (
        getEffortLevelsForModel(flavor, modelKey)
    ), [flavor, modelKey]);
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        resolveCurrentOption(availableEffortLevels, [
            session.effortLevel,
            effectiveAgentDefaults.effortLevel,
        ])
    ), [availableEffortLevels, session.effortLevel, effectiveAgentDefaults.effortLevel]);

    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');
    const expResumeSession = useSetting('expResumeSession');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);

    // Image attachment state (expImageUpload feature flag)
    const expImageUpload = useSetting('expImageUpload');
    const { selectedImages, pickImages, removeImage, clearImages, addImages } = useImagePicker();

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
        storage.getState().updateSessionPermissionMode(sessionId, mode.key);
    }, [sessionId]);

    const updateModelMode = React.useCallback((mode: ModelMode) => {
        storage.getState().updateSessionModelMode(sessionId, mode.key);
    }, [sessionId]);

    const updateEffortLevel = React.useCallback((level: EffortLevel) => {
        storage.getState().updateSessionEffortLevel(sessionId, level.key);
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
        storage.getState().resetSessionAgentOverrides(sessionId);
        sessionAbort(sessionId);
    }, [sessionId]);

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
        };
    }, [sessionUsage, session.latestUsage]);

    const runReview = React.useMemo(() => (
        createRunReviewModel(session, messages, gitStatusFiles, reviewClockNow, reviewEvents)
    ), [session, messages, gitStatusFiles, reviewClockNow, reviewEvents]);
    const isReviewCompact = windowWidth < 700 || (deviceType === 'phone' && !isLandscape);
    const finalizedReview = React.useMemo(() => (
        getFinalRunReviewEvent(reviewEvents)
    ), [reviewEvents]);

    const appendReviewEvent = React.useCallback(async (event: RunReviewActionEvent) => {
        if (!session.metadata) {
            Modal.alert('Run review', 'Session metadata is not available yet. Try again after sync finishes.');
            return;
        }

        const nextEvents = appendRunReviewEvent(reviewEvents, event);
        if (nextEvents === reviewEvents) return;

        const optimisticMetadata = {
            ...session.metadata,
            runReviewEvents: nextEvents,
        };
        storage.getState().applySessions([{ ...session, metadata: optimisticMetadata }]);

        try {
            await sessionUpdateMetadata(sessionId, optimisticMetadata, session.metadataVersion, 3, (latestMetadata) => ({
                ...latestMetadata,
                runReviewEvents: appendRunReviewEvent(getRunReviewEvents(latestMetadata), event),
            }));
        } catch (error) {
            storage.getState().applySessions([session]);
            console.error('Failed to persist run review event:', error);
            Modal.alert('Run review', 'Could not save this review action. Try again after sync reconnects.');
        }
    }, [reviewEvents, session, sessionId]);

    const handleAcceptReview = React.useCallback(() => {
        if (finalizedReview) return;
        void appendReviewEvent(createRunReviewEvent('accepted', Date.now()));
    }, [appendReviewEvent, finalizedReview]);

    const handleFlagReview = React.useCallback(async () => {
        if (finalizedReview) return;
        const note = await Modal.prompt(
            'Flag suspicious run',
            'Add the reason this run needs follow-up.',
            { placeholder: 'Reason', confirmText: 'Flag' }
        );
        const trimmed = note?.trim();
        if (!trimmed) return;
        void appendReviewEvent(createRunReviewEvent('flagged', Date.now(), trimmed));
    }, [appendReviewEvent, finalizedReview]);

    const handleAddReviewNote = React.useCallback(async () => {
        const note = await Modal.prompt(
            'Add review note',
            finalizedReview ? 'Final decision is read-only; notes are appended as follow-up evidence.' : 'Add a note without changing the review state.',
            { placeholder: 'Review note', confirmText: 'Add' }
        );
        const trimmed = note?.trim();
        if (!trimmed) return;
        void appendReviewEvent(createRunReviewEvent('note', Date.now(), trimmed));
    }, [appendReviewEvent, finalizedReview]);

    const handleCopyReviewEvidence = React.useCallback(async () => {
        await Clipboard.setStringAsync(runReview.exportText);
        Modal.alert('Run review', 'Evidence summary copied.');
    }, [runReview.exportText]);

    const handleOpenReviewEvidence = React.useCallback(() => {
        if (runReview.changedFileCount > 0 && onOpenChangeEvidence) {
            onOpenChangeEvidence();
            return;
        }
        void handleCopyReviewEvidence();
    }, [handleCopyReviewEvidence, onOpenChangeEvidence, runReview.changedFileCount]);


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

        // Mark session as currently being viewed (clears unread)
        storage.getState().setCurrentViewingSession(sessionId);

        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId);

        return () => {
            // Clear viewing session on unmount
            const current = storage.getState().currentViewingSessionId;
            if (current === sessionId) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [sessionId, realtimeStatus]);

    let content = (
        <View style={{ flex: 1 }}>
            <RunReviewStrip
                model={runReview}
                compact={isReviewCompact}
                finalizedEvent={finalizedReview}
                onAccept={handleAcceptReview}
                onFlag={handleFlagReview}
                onAddNote={handleAddReviewNote}
                onCopyEvidence={handleCopyReviewEvidence}
                onOpenEvidence={handleOpenReviewEvidence}
            />
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} />
                )}
            </Deferred>
        </View>
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
            onPermissionModeChange={updatePermissionMode}
            availableModes={availableModes}
            modelMode={modelMode}
            availableModels={availableModels}
            onModelModeChange={updateModelMode}
            effortLevel={effortLevel}
            availableEffortLevels={availableEffortLevels}
            onEffortLevelChange={updateEffortLevel}
            metadata={session.metadata}
            connectionStatus={connectionStatus}
            blockSend={false}
            onSend={handleSend}
            onMicPress={isDisconnected ? undefined : micButtonState.onMicPress}
            isMicActive={isDisconnected ? false : micButtonState.isMicActive}
            onAbort={isDisconnected ? undefined : handleAbort}
            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
            onFileViewerPress={experiments && !isTablet ? handleFileViewerPress : undefined}
            selectedImages={expImageUpload ? selectedImages : undefined}
            onPickImages={expImageUpload ? pickImages : undefined}
            onRemoveImage={expImageUpload ? removeImage : undefined}
            onAddImages={expImageUpload ? addImages : undefined}
            autocompletePrefixes={AGENT_INPUT_AUTOCOMPLETE_PREFIXES}
            autocompleteSuggestions={handleAutocompleteSuggestions}
            usageData={usageData}
            alwaysShowContextSize={alwaysShowContextSize}
            zenMode={zenMode}
        />
    );

    // Disconnected sessions get the full Resume affordance regardless of
    // whether they were explicitly archived or just lost their CLI (e.g.
    // Ctrl-C in terminal — lifecycleState stays 'running', server flips
    // active=false). InactiveArchivedHint handles both cases: shows the
    // Resume button when canResume is true, falls back to the
    // copy-this-command hint when the experiments toggle is off or the
    // machine isn't reachable.
    const inactiveHint = isDisconnected ? (
        <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
            <InactiveArchivedHint
                resumeCommandBlock={expResumeSession ? resumeCommandBlock : null}
                canResume={canResume}
                resuming={resumingSession}
                onResume={resumeSession}
            />
        </CenteredInputWidth>
    ) : null;

    const input = (
        <>
            {inactiveHint}
            {composer}
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

const RunReviewStrip = React.memo(function RunReviewStrip(props: {
    model: RunReviewModel;
    compact: boolean;
    finalizedEvent: RunReviewActionEvent | null;
    onAccept: () => void;
    onFlag: () => void;
    onAddNote: () => void;
    onCopyEvidence: () => void;
    onOpenEvidence: () => void;
}) {
    const { theme } = useUnistyles();
    const { model, compact, finalizedEvent } = props;
    const disabled = !!finalizedEvent;
    const visibleBadges = compact ? model.riskBadges.slice(0, 2) : model.riskBadges;
    const overflowCount = model.riskBadges.length - visibleBadges.length;
    const finalizedLabel = finalizedEvent
        ? finalizedEvent.kind === 'accepted' ? 'Accepted' : 'Flagged'
        : null;

    const showActionMenu = React.useCallback(() => {
        const buttons = [
            { text: 'Open evidence', onPress: props.onOpenEvidence },
            { text: 'Copy evidence', onPress: props.onCopyEvidence },
            { text: 'Add note', onPress: props.onAddNote },
            ...(!disabled ? [
                { text: 'Accept', onPress: props.onAccept },
                { text: 'Flag suspicious', onPress: props.onFlag, style: 'destructive' as const },
            ] : []),
            { text: 'Cancel', style: 'cancel' as const },
        ];
        Modal.alert('Run review', model.evidenceSummary, buttons);
    }, [disabled, model.evidenceSummary, props.onAccept, props.onAddNote, props.onCopyEvidence, props.onFlag, props.onOpenEvidence]);

    return (
        <View style={{
            paddingHorizontal: compact ? 8 : 12,
            paddingTop: 8,
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.divider,
            backgroundColor: theme.colors.surface,
        }}>
            <View style={{
                width: '100%',
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                borderWidth: 1,
                borderColor: theme.colors.divider,
                borderRadius: 8,
                backgroundColor: theme.colors.surfaceHigh,
                paddingHorizontal: compact ? 10 : 12,
                paddingVertical: compact ? 8 : 10,
                gap: compact ? 8 : 10,
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: getRiskToneColor(model.riskBadges[0]?.tone ?? 'neutral'),
                    }}>
                        <Ionicons name="shield-checkmark-outline" size={16} color="#fff" />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                            numberOfLines={1}
                            style={{
                                color: theme.colors.text,
                                fontSize: compact ? 13 : 14,
                                lineHeight: compact ? 18 : 19,
                                fontWeight: '700',
                            }}
                        >
                            {finalizedLabel ? `${finalizedLabel}: ${model.summary}` : model.summary}
                        </Text>
                        {!compact && (
                            <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 }}>
                                {model.timing} · {model.runtime}
                            </Text>
                        )}
                    </View>
                    {compact ? (
                        <Pressable
                            onPress={showActionMenu}
                            hitSlop={10}
                            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {visibleBadges.map((badge) => (
                        <RunReviewBadge key={badge.key} badge={badge} />
                    ))}
                    {overflowCount > 0 && (
                        <RunReviewBadge badge={{
                            key: 'overflow',
                            label: `+${overflowCount}`,
                            tone: 'neutral',
                            evidence: 'Additional review signals',
                            available: true,
                        }} />
                    )}
                </View>

                {!compact && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <RunReviewAction label="Evidence" icon="git-compare-outline" onPress={props.onOpenEvidence} />
                        <RunReviewAction label="Copy" icon="copy-outline" onPress={props.onCopyEvidence} />
                        <RunReviewAction label="Note" icon="create-outline" onPress={props.onAddNote} />
                        <RunReviewAction label="Accept" icon="checkmark" onPress={props.onAccept} disabled={disabled} />
                        <RunReviewAction label="Flag" icon="flag-outline" onPress={props.onFlag} disabled={disabled} danger />
                    </View>
                )}
            </View>
        </View>
    );
});

const RunReviewBadge = React.memo(function RunReviewBadge({ badge }: { badge: RunReviewRiskBadge }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => Modal.alert(badge.label, badge.available ? badge.evidence : 'Evidence unavailable.')}
            style={{
                minHeight: 24,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 4,
                backgroundColor: getRiskToneColor(badge.tone),
                opacity: badge.available ? 1 : 0.7,
            }}
        >
            <Text style={{ color: badge.tone === 'neutral' ? theme.colors.text : '#fff', fontSize: 11, lineHeight: 15, fontWeight: '700' }}>
                {badge.label}
            </Text>
        </Pressable>
    );
});

const RunReviewAction = React.memo(function RunReviewAction(props: {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.disabled ? undefined : props.onPress}
            disabled={props.disabled}
            style={({ pressed }: { pressed: boolean }) => ({
                minHeight: 32,
                borderRadius: 8,
                paddingHorizontal: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: props.danger ? '#FF453A' : theme.colors.surface,
                opacity: props.disabled ? 0.45 : pressed ? 0.8 : 1,
            })}
        >
            <Ionicons name={props.icon} size={14} color={props.danger ? '#fff' : theme.colors.text} />
            <Text style={{ color: props.danger ? '#fff' : theme.colors.text, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>
                {props.label}
            </Text>
        </Pressable>
    );
});

function createRunReviewModel(
    session: Session,
    messages: Message[],
    gitStatusFiles: ReturnType<typeof useSessionGitStatusFiles>,
    now: number,
    reviewEvents: RunReviewActionEvent[],
): RunReviewModel {
    const toolMessages = collectToolMessages(messages);
    const changedFiles = collectChangedFiles(gitStatusFiles);
    const lineChangeCount = changedFiles.reduce((sum, file) => sum + file.linesAdded + file.linesRemoved, 0);
    const permissions = collectPermissionSignals(session, toolMessages);
    const lastMessageAt = messages.reduce((max, message) => Math.max(max, message.createdAt || 0), 0);
    const lastActivityAt = Math.max(lastMessageAt, session.thinkingAt || 0, session.activeAt || 0, session.updatedAt || 0);
    const isActive = session.presence === 'online' && (session.thinking || session.active);
    const silentMs = isActive && lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0;
    const hasDangerousPermissions = !!session.metadata?.dangerouslySkipPermissions
        || session.permissionMode === 'bypassPermissions'
        || session.permissionMode === 'yolo'
        || permissions.some((permission) => permission.mode === 'bypassPermissions' || permission.decision === 'approved_for_session');
    const broadFiles = changedFiles.length >= BROAD_FILE_CHANGE_COUNT || lineChangeCount >= BROAD_FILE_CHANGE_LINES;
    const latestToolMessageId = toolMessages[toolMessages.length - 1]?.id ?? null;
    const finalized = [...reviewEvents].reverse().find((event) => event.kind === 'accepted' || event.kind === 'flagged') ?? null;
    const title = finalized
        ? finalized.kind === 'accepted' ? 'Reviewed' : 'Suspicious'
        : silentMs >= SILENT_RUN_WARNING_MS || hasDangerousPermissions || broadFiles ? 'Review needed' : isActive ? 'Active run' : 'Run review';
    const source = session.metadata?.startedBy ?? session.metadata?.flavor ?? 'unknown';
    const runtimeParts = [
        session.metadata?.flavor ?? 'agent',
        session.modelMode ?? session.metadata?.currentModelCode,
        session.permissionMode ?? session.metadata?.currentOperatingModeCode,
    ].filter(Boolean);

    const riskBadges: RunReviewRiskBadge[] = [
        {
            key: 'silent',
            label: silentMs >= SILENT_RUN_WARNING_MS ? `Silent ${formatDuration(silentMs)}` : 'No silent risk',
            tone: silentMs >= SILENT_RUN_DANGER_MS ? 'danger' : silentMs >= SILENT_RUN_WARNING_MS ? 'warning' : 'success',
            evidence: isActive
                ? `Last visible activity ${lastActivityAt ? formatClock(lastActivityAt) : 'unavailable'}; warning threshold ${formatDuration(SILENT_RUN_WARNING_MS)}.`
                : 'Run is not currently active.',
            available: lastActivityAt > 0 || !isActive,
        },
        {
            key: 'permission',
            label: hasDangerousPermissions ? 'Permission escalation' : `${permissions.length} permissions`,
            tone: hasDangerousPermissions ? 'danger' : permissions.length > 0 ? 'warning' : 'success',
            evidence: permissions.length > 0
                ? permissions.map((permission) => `${permission.tool}: ${permission.status}${permission.mode ? ` (${permission.mode})` : ''}`).join('\n')
                : 'No permission decisions visible in session evidence.',
            available: permissions.length > 0,
        },
        {
            key: 'files',
            label: changedFiles.length > 0 ? `${changedFiles.length} changed files` : 'No file changes',
            tone: broadFiles ? 'warning' : changedFiles.length > 0 ? 'neutral' : 'success',
            evidence: changedFiles.length > 0
                ? changedFiles.slice(0, 12).map((file) => `${file.fullPath} +${file.linesAdded}/-${file.linesRemoved}`).join('\n')
                : 'Git status has no changed files.',
            available: changedFiles.length > 0,
        },
        {
            key: 'long-running',
            label: silentMs >= SILENT_RUN_DANGER_MS ? 'Long silence' : 'Runtime ok',
            tone: silentMs >= SILENT_RUN_DANGER_MS ? 'danger' : silentMs >= SILENT_RUN_WARNING_MS ? 'warning' : 'success',
            evidence: `Silent duration ${formatDuration(silentMs)}; critical threshold ${formatDuration(SILENT_RUN_DANGER_MS)}.`,
            available: isActive,
        },
        {
            key: 'replay',
            label: toolMessages.length > 0 ? 'Replay available' : messages.length > 0 ? 'Replay partial' : 'Replay unavailable',
            tone: toolMessages.length > 0 ? 'success' : messages.length > 0 ? 'warning' : 'neutral',
            evidence: toolMessages.length > 0
                ? `Latest tool message: ${latestToolMessageId}`
                : messages.length > 0 ? 'Chat messages are available, but no tool-call replay pointer is visible.' : 'No messages have loaded for this session.',
            available: messages.length > 0,
        },
    ];

    const summary = `${title} · ${toolMessages.length} tools · ${changedFiles.length} files`;
    const timing = lastActivityAt > 0 ? `last activity ${formatClock(lastActivityAt)}` : 'last activity unavailable';
    const runtime = runtimeParts.join(' · ') || 'runtime unknown';
    const evidenceSummary = `${toolMessages.length} tool calls, ${permissions.length} permissions, ${changedFiles.length} changed files`;
    const notes = reviewEvents.filter((event) => event.note).map((event) => `- ${event.kind} ${formatClock(event.createdAt)}: ${event.note}`).join('\n');

    return {
        title,
        summary,
        source,
        timing,
        runtime,
        evidenceSummary,
        riskBadges,
        changedFileCount: changedFiles.length,
        toolCallCount: toolMessages.length,
        permissionDecisionCount: permissions.length,
        latestToolMessageId,
        exportText: [
            `Run review: ${summary}`,
            `Session: ${session.id}`,
            `Source: ${source}`,
            `Timing: ${timing}`,
            `Runtime: ${runtime}`,
            `Evidence: ${evidenceSummary}`,
            '',
            'Risks:',
            ...riskBadges.map((badge) => `- ${badge.label}: ${badge.evidence.replace(/\n/g, '; ')}`),
            notes ? `\nReview notes:\n${notes}` : '',
        ].filter(Boolean).join('\n'),
    };
}

function collectToolMessages(messages: Message[]): ToolCallMessage[] {
    const out: ToolCallMessage[] = [];
    const visit = (message: Message) => {
        if (message.kind === 'tool-call') {
            out.push(message);
            message.children.forEach(visit);
        }
    };
    messages.forEach(visit);
    return out;
}

function collectChangedFiles(gitStatusFiles: ReturnType<typeof useSessionGitStatusFiles>) {
    const files = [...(gitStatusFiles?.stagedFiles ?? []), ...(gitStatusFiles?.unstagedFiles ?? [])];
    const byPath = new Map<string, GitFileStatus>();
    for (const file of files) {
        const existing = byPath.get(file.fullPath);
        if (!existing) {
            byPath.set(file.fullPath, file);
        } else {
            byPath.set(file.fullPath, {
                ...file,
                linesAdded: existing.linesAdded + file.linesAdded,
                linesRemoved: existing.linesRemoved + file.linesRemoved,
            });
        }
    }
    return Array.from(byPath.values());
}

function collectPermissionSignals(session: Session, toolMessages: ToolCallMessage[]) {
    const permissions = toolMessages
        .map((message) => message.tool.permission ? {
            tool: message.tool.name,
            status: message.tool.permission.status,
            mode: message.tool.permission.mode,
            decision: message.tool.permission.decision,
        } : null)
        .filter(Boolean) as Array<{ tool: string; status: string; mode?: string; decision?: string }>;
    const pendingRequests = Object.values((session.agentState?.requests ?? {}) as Record<string, { tool: string }>);
    for (const request of pendingRequests) {
        permissions.push({ tool: request.tool, status: 'pending' });
    }
    const completedRequests = Object.values((session.agentState?.completedRequests ?? {}) as Record<string, {
        tool: string;
        status: string;
        mode?: string | null;
        decision?: string | null;
    }>);
    for (const request of completedRequests) {
        permissions.push({
            tool: request.tool,
            status: request.status,
            mode: request.mode ?? undefined,
            decision: request.decision ?? undefined,
        });
    }
    return permissions;
}

function getRiskToneColor(tone: RunReviewRiskTone) {
    switch (tone) {
        case 'success': return '#30D158';
        case 'warning': return '#FF9F0A';
        case 'danger': return '#FF453A';
        case 'neutral':
        default: return 'rgba(142, 142, 147, 0.18)';
    }
}

function formatDuration(ms: number) {
    if (ms <= 0) return '0m';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatClock(value: number) {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
                        height: 40,
                        borderRadius: 10,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: props.resuming ? 0.6 : pressed ? 0.8 : 1,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginHorizontal: 8,
                    })}
                >
                    {props.resuming ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={{ color: theme.colors.button.primary.tint, fontSize: 15, fontWeight: '600' }}>
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
            style={{
                minHeight: 48,
                borderRadius: 14,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                gap: 8,
                paddingHorizontal: 16,
                paddingVertical: 12,
                alignItems: 'flex-start',
            }}
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
