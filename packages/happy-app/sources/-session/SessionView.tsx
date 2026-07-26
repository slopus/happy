import { AgentContentView } from '@/components/AgentContentView';
import { MessageComposer } from '@/components/MessageComposer';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { SessionHeaderChip } from '@/components/SessionHeaderChip';
import { SessionInfoDropdown } from '@/components/SessionInfoDropdown';
import { RightSwipePanelHost } from '@/components/RightSwipePanelHost';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort } from '@/sync/ops';
import { requestScreenshot } from '@/sync/ops.screenshot';
import { saveBase64Png, addScreenshotEntry, useHasNewScreenshots, type ScreenshotEntry } from '@/sync/screenshotGallery';
import { ScreenshotGalleryDrawer } from '@/components/ScreenshotGalleryDrawer';
import { imageViewer } from '@/sync/imageViewer';
import { Modal } from '@/modal';
import { storage, useIsDataReady, useLocalSetting, useSessionMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { getPersistentHeaderContentInset, TAURI_HEADER_CONTROL_LEFT } from '@/utils/desktopNavigationLayout';
import { isTauri } from '@/utils/isTauri';
import { FilesSidebar, SidebarMode } from '@/components/FilesSidebar';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { FileViewPanel } from '@/components/FileViewPanel';
import { AgentSpaceExitButton, SessionRightPanelContent } from '@/components/agents/SessionAgentSpaceBoundary';
import { useAgentSpace, useSpaceAgentForSession } from '@/hooks/useAgentSpace';
import { prefetchPierreDiff } from '@/components/diff/PierreDiffView';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { formatPathRelativeToHome, getResumeCommandBlock, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, useNavigation } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

// Agent display labels for the header chip. Mirrors ComposeHome's map, but keyed
// off the running session's `flavor` (an active session reports its agent there).
const AGENT_LABELS: Record<string, string> = {
    ask: 'ask',
    claude: 'claude code',
    codex: 'codex',
    opencode: 'opencode',
    openclaw: 'openclaw',
    gemini: 'gemini',
};

const CAN_COPY_SESSION_ID = Application.applicationId === 'build.paws.preview';

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const navigation = useNavigation();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');
    const sessionComposerHandleRef = React.useRef<ChatComposerHandle | null>(null);

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

    // When sidebar capability is lost (screen too narrow, disabled), close views.
    // Don't close on zen mode toggle — keep the view visible.
    React.useEffect(() => {
        if (!canShowSidebar) {
            setOverlayHistory({ stack: [{ kind: 'none' }], cursor: 0 });
        }
    }, [canShowSidebar]);

    // Right-side header content published by the active overlay (diff toggle / save button).
    const [headerRightSlot, setHeaderRightSlot] = React.useState<React.ReactNode>(null);

    // Opens the phone session-list drawer (same root Drawer the compose home opens).
    const openSessionList = React.useCallback(() => {
        navigation.dispatch(DrawerActions.openDrawer());
    }, [navigation]);

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

    // Header chip (replaces the breadcrumb title): shows the running session's
    // agent + machine + connection state. Tapping it drops down a read-only
    // info panel — an active session can't switch machine/agent, so there's
    // nothing to pick, just metadata to surface.
    const [infoPanelOpen, setInfoPanelOpen] = React.useState(false);
    const sessionOnline = session?.presence === 'online';
    const agentLabel = React.useMemo(() => {
        const flavor = session?.metadata?.flavor ?? 'claude';
        return AGENT_LABELS[flavor] ?? flavor;
    }, [session?.metadata?.flavor]);
    const machineName = session?.metadata?.name || session?.metadata?.host || null;
    const showChip = isDataReady && !!session;
    // 会话内「进入空间/退出空间」：进入 = 设 agentSpaceId + 拉出工作台抽屉；退出 = 清空间并回首页。
    const { enter: enterSpace, exit: exitSpace } = useAgentSpace();

    // Resolve the session's persisted Agent once through the canonical matcher,
    // then share that identity between the header skin and the phone panel.
    const spaceAgent = useSpaceAgentForSession(session);

    const headerTitleSlot = showChip ? (
        <SessionHeaderChip
            agentLabel={agentLabel}
            machineName={machineName}
            online={sessionOnline}
            open={infoPanelOpen}
            onPress={() => setInfoPanelOpen(v => !v)}
        />
    ) : undefined;

    // 「空间皮肤」会话顶栏（第三张图）：会话属于某空间 Agent 时，顶栏染 accent 色 + 头像 + 会话名，
    // 左「进入空间」拉出工作台抽屉、右「退出空间」离开空间回首页。发送键/气泡保持原样。
    const spaceTint = '#FFFFFF';
    const enterSpaceButton = spaceAgent ? (
        <Pressable
            onPress={() => { enterSpace(spaceAgent.id); openSessionList(); }}
            hitSlop={12}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
        >
            <Ionicons name="albums-outline" size={22} color={spaceTint} />
        </Pressable>
    ) : undefined;
    const exitSpaceButton = spaceAgent ? (
        <AgentSpaceExitButton
            color={spaceTint}
            onPress={() => { exitSpace(); router.navigate('/'); }}
        />
    ) : undefined;
    const spaceTitleSlot = spaceAgent ? (
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>{spaceAgent.glyph}</Text>
            </View>
            <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: spaceTint, fontSize: 15, fontWeight: '600' }}>{headerProps.title}</Text>
        </View>
    ) : undefined;

    // New-session button on the header's right edge. Returns to the particle
    // home (ComposeHome) to start a fresh session — not the older /new composer.
    // A Kimi-style "new chat" bubble+plus glyph. Hidden while a file / diff
    // overlay owns the right slot.
    const newSessionButton = (
        <Pressable onPress={() => router.navigate('/')} hitSlop={12} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <MaterialCommunityIcons name="message-plus-outline" size={23} color={theme.colors.header.tint} />
        </Pressable>
    );
    const persistentHeaderContentInset = isTablet
        ? getPersistentHeaderContentInset({
            windowWidth,
            headerMaxWidth: layout.headerMaxWidth,
            headerHorizontalPadding: Platform.OS === 'ios' ? 8 : 16,
            controlStartPadding: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 0,
            buttonCount: Platform.OS === 'web' ? 3 : 2,
            targetHitSlop: 8,
        })
        : 0;

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
                        backgroundColor={spaceAgent ? spaceAgent.color : undefined}
                        tintColor={spaceAgent ? spaceTint : undefined}
                        headerContentLeftInset={persistentHeaderContentInset}
                        leftSlot={enterSpaceButton}
                        titleSlot={spaceAgent ? spaceTitleSlot : headerTitleSlot}
                        rightSlot={(diffViewOpen || !!fileViewPath) ? headerRightSlot : (spaceAgent ? exitSpaceButton : newSessionButton)}
                        onTitlePress={session && !spaceAgent ? () => router.push(`/session/${sessionId}/info`) : undefined}
                        onListPress={openSessionList}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight : 0 }}>
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
                    <SessionViewLoaded key={sessionId} composerHandleRef={sessionComposerHandleRef} sessionId={sessionId} session={session} />
                )}
            </View>

            {/* Read-only session-info dropdown, anchored under the header chip.
                A sibling of the (padded) content view — not a child — so its
                absolute `top` measures from the screen edge without the content
                padding offsetting it. Its backdrop covers the chat; the header's
                zIndex keeps the chip itself tappable above the panel. */}
            {infoPanelOpen && session && (
                <SessionInfoDropdown
                    session={session}
                    machineName={machineName}
                    online={sessionOnline}
                    top={safeArea.top + headerHeight}
                    canCopySessionId={CAN_COPY_SESSION_ID}
                    onClose={() => setInfoPanelOpen(false)}
                    onViewDetails={() => {
                        setInfoPanelOpen(false);
                        router.push(`/session/${sessionId}/info`);
                    }}
                />
            )}
        </>
    );

    if (!canShowSidebar) {
        const rightPanel = (
            <SessionRightPanelContent
                composerHandleRef={sessionComposerHandleRef}
                sessionId={sessionId}
                spaceAgent={spaceAgent}
            />
        );
        return (
            <RightSwipePanelHost panelContent={rightPanel}>
                {mainContent}
            </RightSwipePanelHost>
        );
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
                        style={{
                            pointerEvents: 'box-none',
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
                        style={{
                            pointerEvents: 'box-none',
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

// Hoisted so MessageComposer's React.memo doesn't see a new array ref on every keystroke
const AGENT_INPUT_AUTOCOMPLETE_PREFIXES = ['@', '/'];
const CODEX_AGENT_INPUT_AUTOCOMPLETE_PREFIXES = ['@', '/', '$'];

function isCodexSessionFlavor(flavor: string | null | undefined): boolean {
    return flavor === 'codex' || flavor === 'openai' || flavor === 'gpt';
}

// Imperative handle exposed by ChatComposer so SessionViewLoaded can read /
// clear the message text without subscribing to it (which would re-render
// the whole loaded screen on every keystroke).
type ChatComposerHandle = {
    getMessage: () => string;
    clearMessage: () => void;
    setMessage: (text: string) => void;
};

type ChatComposerProps = Omit<
    React.ComponentProps<typeof MessageComposer>,
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
        setMessage: (text: string) => {
            inputHandleRef.current?.setTextAndSelection(text, { start: text.length, end: text.length });
            inputHandleRef.current?.focus();
            setMessage(text);
        },
    }), [clearDraft]);

    return (
        <MessageComposer
            {...rest}
            ref={inputHandleRef}
            sessionId={sessionId}
            initialValue={initialDraft}
            onChangeText={handleChangeText}
        />
    );
});

/** 判断 CLI 返回的截图错误是否属于「平台不支持」（截图仅 macOS）。
 *  CLI 的 error 文案可能是中/英混合，匹配几个稳定特征词即可，无需精确解析。 */
function isUnsupportedPlatformError(error: string | undefined): boolean {
    if (!error) {
        return false;
    }
    return /macOS|platform|仅支持/i.test(error);
}

function SessionViewLoaded({
    sessionId,
    session,
    composerHandleRef,
}: {
    sessionId: string;
    session: Session;
    composerHandleRef: React.RefObject<ChatComposerHandle | null>;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const zenMode = useLocalSetting('zenMode');
    const sessionInputHorizontalPadding = Platform.OS === 'web' || isRunningOnMac() || isTablet ? 12 : 8;

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;

    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');
    const expResumeSession = useSetting('expResumeSession');
    const desktopScreenshotEnabled = useSetting('expDesktopScreenshot');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);

    // Attachment state（图片/音视频，会话内默认可用）。pickAttachment 弹出
    // 图片/音视频选择器；音视频不支持的 flavor 由 sendMessage 兜底提示。
    const { selectedImages, pickAttachment, removeImage, clearImages, addImages } = useImagePicker();

    // Screenshot gallery drawer (能力 B). Reactive red-dot signal for unseen
    // screenshots; opening the drawer clears it (handled inside the drawer).
    const [galleryOpen, setGalleryOpen] = React.useState(false);
    const { hasNew: galleryHasNew } = useHasNewScreenshots(sessionId);

    // 截图进行中标记：点相机后 RPC 往返 1-5 秒静默无反馈，用它把相机按钮切成菊花
    const [screenshotCapturing, setScreenshotCapturing] = React.useState(false);
    const handleOpenGallery = React.useCallback(() => setGalleryOpen(true), []);
    const handleCloseGallery = React.useCallback(() => setGalleryOpen(false), []);
    // Attach a gallery screenshot to the composer input. Intrinsic size is
    // unknown for screenshots (0/0 is accepted by the upload pipeline).
    const handleAttachScreenshot = React.useCallback((entry: ScreenshotEntry) => {
        addImages([{
            id: entry.id,
            uri: entry.uri,
            width: 0,
            height: 0,
            mimeType: 'image/png',
            size: 0,
            name: entry.id,
        }]);
    }, [addImages]);

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
        if (liveMessage.trim() || selectedImages.length > 0) {
            const attachments = selectedImages.length > 0 ? selectedImages : undefined;
            composerHandleRef.current?.clearMessage();
            if (attachments) clearImages();
            sync.sendMessage(sessionId, liveMessage, { source: 'chat', attachments });
        }
    }, [composerHandleRef, sessionId, selectedImages, clearImages]);

    // Manual screenshot: ask the CLI for a capture, persist it to the local
    // gallery and immediately open it in the fullscreen viewer. Self-contained
    // try/catch (instead of useHappyAction, which takes a no-arg action) so we
    // can pass `target` and still surface every failure — including RPC throws —
    // via Modal (RN Alert is banned). No unhandled rejection escapes.
    const handleCaptureScreenshot = React.useCallback((target: 'desktop' | 'browser') => {
        (async () => {
            setScreenshotCapturing(true);
            try {
                const res = await requestScreenshot(sessionId, target);
                if (!res.success || !res.dataBase64) {
                    // 平台不支持（如非 macOS）时给本地化文案，否则原样回显 CLI error
                    const body = isUnsupportedPlatformError(res.error)
                        ? t('components.messageComposer.screenshotUnsupportedPlatform')
                        : (res.error ?? t('components.messageComposer.screenshotFailedBody'));
                    Modal.alert(
                        t('components.messageComposer.screenshotFailedTitle'),
                        body,
                    );
                    return;
                }
                const uri = await saveBase64Png(res.dataBase64);
                const entry = addScreenshotEntry(sessionId, { uri, source: 'manual', target, createdAt: Date.now() });
                imageViewer.open({ uri, filename: `screenshot-${entry.id}.png` });
                // 请求了浏览器但 CLI 没找到浏览器窗口、回退成整屏：截图仍打开，只是轻提示一下
                if (target === 'browser' && res.targetUsed === 'desktop') {
                    Modal.alert(
                        t('components.messageComposer.screenshotBrowserFallbackTitle'),
                        t('components.messageComposer.screenshotBrowserFallbackBody'),
                    );
                }
            } catch (e) {
                Modal.alert(
                    t('components.messageComposer.screenshotFailedTitle'),
                    e instanceof Error ? e.message : t('components.messageComposer.screenshotFailedBody'),
                );
            } finally {
                setScreenshotCapturing(false);
            }
        })();
    }, [sessionId]);

    const handleAbort = React.useCallback(() => {
        storage.getState().resetSessionAgentOverrides(sessionId);
        sessionAbort(sessionId);
    }, [sessionId]);

    const handleFileViewerPress = React.useCallback(() => {
        router.push(`/session/${sessionId}/files`);
    }, [router, sessionId]);

    const handleAutocompleteSuggestions = React.useCallback((query: string) => (
        getSuggestions(sessionId, query, { flavor: session.metadata?.flavor ?? null })
    ), [sessionId, session.metadata?.flavor]);

    const autocompletePrefixes = React.useMemo(
        () => (isCodexSessionFlavor(session.metadata?.flavor) ? CODEX_AGENT_INPUT_AUTOCOMPLETE_PREFIXES : AGENT_INPUT_AUTOCOMPLETE_PREFIXES),
        [session.metadata?.flavor],
    );

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
    }, [sessionId]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} />
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
            mode="session"
            composerHandleRef={composerHandleRef}
            placeholder={t('session.inputPlaceholder')}
            sessionId={sessionId}
            connectionStatus={connectionStatus}
            blockSend={false}
            onSend={handleSend}
            onAbort={isDisconnected ? undefined : handleAbort}
            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
            onFileViewerPress={experiments && !isTablet ? handleFileViewerPress : undefined}
            selectedImages={selectedImages}
            onPickImages={pickAttachment}
            onRemoveImage={removeImage}
            onAddImages={addImages}
            onCaptureScreenshot={desktopScreenshotEnabled ? handleCaptureScreenshot : undefined}
            screenshotCapturing={screenshotCapturing}
            onOpenGallery={desktopScreenshotEnabled ? handleOpenGallery : undefined}
            galleryHasNew={galleryHasNew}
            autocompletePrefixes={autocompletePrefixes}
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

            {/* Screenshot gallery bottom drawer (能力 B) */}
            <ScreenshotGalleryDrawer
                visible={galleryOpen}
                onClose={handleCloseGallery}
                sessionId={sessionId}
                onAttach={handleAttachScreenshot}
            />
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
