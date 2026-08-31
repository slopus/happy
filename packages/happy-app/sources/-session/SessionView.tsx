import { AgentContentView } from '@/components/AgentContentView';
import { MessageComposer } from '@/components/MessageComposer';
import type { SessionComposerDirectorySelectorConfig } from '@/components/SessionComposerDirectorySelector';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { SessionHeaderChip } from '@/components/SessionHeaderChip';
import { SessionInfoDropdown } from '@/components/SessionInfoDropdown';
import { PublicSessionShareDialog } from '@/components/PublicSessionShareDialog';
import { SessionOrganizerDialog } from '@/components/SessionOrganizerDialog';
import { DesktopRightPanel, DesktopRightPanelToggleButton } from '@/components/DesktopRightPanel';
import { DesktopPresenceTransition } from '@/components/DesktopPresenceTransition';
import type { DesktopTransitionDirection } from '@/components/DesktopPresenceTransition.types';
import { RightSwipePanelHost } from '@/components/RightSwipePanelHost';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort } from '@/sync/ops';
import { requestScreenshot } from '@/sync/ops.screenshot';
import {
    saveBase64Png,
    resolveScreenshotUri,
    addScreenshotEntry,
    useHasNewScreenshots,
    type ScreenshotEntry,
} from '@/sync/screenshotGallery';
import { ScreenshotGalleryDrawer } from '@/components/ScreenshotGalleryDrawer';
import { imageViewer } from '@/sync/imageViewer';
import { Modal } from '@/modal';
import { storage, useIsDataReady, useLocalSetting, useLocalSettingMutable, useMachine, useSessionMessages, useSessionUsage, useSetting, useSettingUpdater } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import {
    createSidebarOrganizationId,
    organizeSessionWithCreatedTags,
    SIDEBAR_LIST_COLORS,
    SIDEBAR_SESSION_TAG_MAX_COUNT,
    SIDEBAR_TAG_MAX_COUNT,
    type SidebarTag,
} from '@/sync/sidebarOrganization';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import {
    DESKTOP_MAIN_MIN_WIDTH,
    getPersistentHeaderContentInset,
    getDesktopRightPanelPresentation,
    getPersistentNavigationControlsWidth,
    getResponsiveRightPanelMode,
    shouldUseCompactSessionHeader,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
    TAURI_HEADER_CONTROL_LEFT,
} from '@/utils/desktopNavigationLayout';
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
import { useSessionTaskPermission } from '@/hooks/useSessionTaskPermission';
import { useSessionWorkingDirectory } from '@/hooks/useSessionWorkingDirectory';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useNavigation } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { resolveRunningSessionTurnModes } from '@/utils/runningSessionTurnModes';
import { supportsCodexFast } from '@/utils/codexFast';
import {
    SubagentInspectorProvider,
    useSubagentInspector,
} from '@/components/subagent/SubagentInspectorContext';
import { SubagentInspectorPanel } from '@/components/subagent/SubagentInspectorPanel';
import { findSessionTitleTagQuery, removeSessionTitleTagQuery } from '@/utils/sessionTitleTags';

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

function hasVisibleWebDialog(): boolean {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return false;

    return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]:not([aria-hidden="true"])')).some((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof window === 'undefined' ? null : window.getComputedStyle(element);
        return style?.display !== 'none' && style?.visibility !== 'hidden';
    });
}

function SessionHeaderTitle({
    availableTags = [],
    compact = false,
    onAddTag,
    session,
    tags = [],
    title,
    tintColor,
}: {
    availableTags?: readonly SidebarTag[];
    compact?: boolean;
    onAddTag?: (tag: SidebarTag) => void;
    session: Session;
    tags?: readonly SidebarTag[];
    title: string;
    tintColor?: string;
}) {
    const { theme } = useUnistyles();
    const [editing, setEditing] = React.useState(false);
    const [draftTitle, setDraftTitle] = React.useState(title);
    const [activeTagOption, setActiveTagOption] = React.useState(0);
    const editingRef = React.useRef(false);
    const draftTitleRef = React.useRef(title);
    const inputRef = React.useRef<TextInput>(null);
    const choosingTagRef = React.useRef(false);
    const { renameSessionToTitle, renamingSession } = useSessionQuickActions(session);
    const sessionStatus = useSessionStatus(session);

    React.useEffect(() => {
        if (!editingRef.current) {
            draftTitleRef.current = title;
            setDraftTitle(title);
        }
    }, [title]);

    const beginEditing = React.useCallback(() => {
        draftTitleRef.current = title;
        setDraftTitle(title);
        editingRef.current = true;
        setEditing(true);
    }, [title]);

    const beginAddingTag = React.useCallback(() => {
        const nextTitle = `${title.trimEnd()} #`;
        draftTitleRef.current = nextTitle;
        setDraftTitle(nextTitle);
        setActiveTagOption(0);
        editingRef.current = true;
        setEditing(true);
    }, [title]);

    const finishEditing = React.useCallback((save: boolean) => {
        if (!editingRef.current) {
            return;
        }
        editingRef.current = false;
        setEditing(false);

        if (save) {
            const pendingTagQuery = findSessionTitleTagQuery(draftTitleRef.current);
            const cleanTitle = pendingTagQuery
                ? removeSessionTitleTagQuery(draftTitleRef.current, pendingTagQuery.start) || title
                : draftTitleRef.current;
            draftTitleRef.current = cleanTitle;
            setDraftTitle(cleanTitle);
            renameSessionToTitle(cleanTitle);
        } else {
            draftTitleRef.current = title;
            setDraftTitle(title);
        }
    }, [renameSessionToTitle, title]);

    const handleDraftTitleChange = React.useCallback((value: string) => {
        draftTitleRef.current = value;
        setDraftTitle(value);
        setActiveTagOption(0);
    }, []);
    const tagQuery = React.useMemo(() => findSessionTitleTagQuery(draftTitle), [draftTitle]);
    const foldedTagQuery = tagQuery?.query.toLocaleLowerCase() ?? '';
    const matchingTags = React.useMemo(() => tagQuery
        ? availableTags.filter((tag) => tag.name.toLocaleLowerCase().includes(foldedTagQuery))
        : [], [availableTags, foldedTagQuery, tagQuery]);
    const exactTag = tagQuery
        ? availableTags.find((tag) => tag.name.toLocaleLowerCase() === foldedTagQuery)
        : undefined;
    const canCreateTag = !!tagQuery
        && tagQuery.query.trim().length > 0
        && !exactTag
        && availableTags.length < SIDEBAR_TAG_MAX_COUNT
        && tags.length < SIDEBAR_SESSION_TAG_MAX_COUNT;
    const tagOptionCount = matchingTags.length + (canCreateTag ? 1 : 0);
    const sessionTagLimitReached = tags.length >= SIDEBAR_SESSION_TAG_MAX_COUNT;
    const tagCreationLimitReached = availableTags.length >= SIDEBAR_TAG_MAX_COUNT || sessionTagLimitReached;

    React.useEffect(() => {
        setActiveTagOption((current) => Math.max(0, Math.min(current, Math.max(0, tagOptionCount - 1))));
    }, [tagOptionCount]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !tagQuery || tagOptionCount === 0 || typeof document === 'undefined') return;
        document
            .getElementById(`session-title-tag-option-${activeTagOption}`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeTagOption, tagOptionCount, tagQuery]);

    const applyTag = React.useCallback((tag: SidebarTag) => {
        if (!tagQuery || !onAddTag) return;
        if (!tags.some((selectedTag) => selectedTag.id === tag.id) && sessionTagLimitReached) return;
        const cleanTitle = removeSessionTitleTagQuery(draftTitleRef.current, tagQuery.start) || title;
        draftTitleRef.current = cleanTitle;
        setDraftTitle(cleanTitle);
        setActiveTagOption(0);
        onAddTag(tag);
        setTimeout(() => {
            inputRef.current?.focus();
            choosingTagRef.current = false;
        }, 0);
    }, [onAddTag, sessionTagLimitReached, tagQuery, tags, title]);

    const createTag = React.useCallback(() => {
        if (!tagQuery || !canCreateTag) return;
        applyTag({
            id: createSidebarOrganizationId('tag'),
            name: tagQuery.query.trim(),
            color: SIDEBAR_LIST_COLORS[availableTags.length % SIDEBAR_LIST_COLORS.length],
            createdAt: Date.now(),
        });
    }, [applyTag, availableTags.length, canCreateTag, tagQuery]);

    const activateTagOption = React.useCallback(() => {
        const tag = matchingTags[activeTagOption];
        if (tag) applyTag(tag);
        else if (canCreateTag && activeTagOption === matchingTags.length) createTag();
    }, [activeTagOption, applyTag, canCreateTag, createTag, matchingTags]);
    sessionHeaderTitleStyles.useVariants({ headerTitleDensity: compact ? 'compact' : 'regular' });

    return (
        <View style={sessionHeaderTitleStyles.headerTitleWrapper}>
            <View style={sessionHeaderTitleStyles.headerTitleLine}>
                {editing ? (
                    <TextInput
                        accessibilityLabel={t('sessionInfo.renameSession')}
                        autoFocus
                        aria-activedescendant={tagQuery && tagOptionCount > 0 ? `session-title-tag-option-${activeTagOption}` : undefined}
                        aria-controls="session-title-tag-results"
                        aria-expanded={!!tagQuery}
                        blurOnSubmit={false}
                        onBlur={() => {
                            setTimeout(() => {
                                if (!choosingTagRef.current) finishEditing(true);
                            }, 0);
                        }}
                        onChangeText={handleDraftTitleChange}
                        onKeyPress={(event) => {
                            if (event.nativeEvent.key === 'Escape') {
                                if (tagQuery) {
                                    const cleanTitle = removeSessionTitleTagQuery(draftTitleRef.current, tagQuery.start) || title;
                                    draftTitleRef.current = cleanTitle;
                                    setDraftTitle(cleanTitle);
                                } else {
                                    finishEditing(false);
                                }
                            } else if (tagQuery && event.nativeEvent.key === 'ArrowDown') {
                                if (Platform.OS === 'web') event.preventDefault();
                                setActiveTagOption((current) => tagOptionCount > 0 ? (current + 1) % tagOptionCount : 0);
                            } else if (tagQuery && event.nativeEvent.key === 'ArrowUp') {
                                if (Platform.OS === 'web') event.preventDefault();
                                setActiveTagOption((current) => tagOptionCount > 0 ? (current - 1 + tagOptionCount) % tagOptionCount : 0);
                            }
                        }}
                        onSubmitEditing={() => tagQuery ? activateTagOption() : finishEditing(true)}
                        ref={inputRef}
                        returnKeyType="done"
                        role="combobox"
                        style={[
                            sessionHeaderTitleStyles.headerTitleInput,
                            tintColor ? { color: tintColor, borderColor: tintColor } : null,
                        ]}
                        testID="session-header-title-input"
                        value={draftTitle}
                    />
                ) : (
                    <Pressable
                        accessibilityLabel={`${t('sessionInfo.renameSession')}: ${title}`}
                        accessibilityRole="button"
                        {...({ tabIndex: 0 } as any)}
                        onPress={beginEditing}
                        style={sessionHeaderTitleStyles.headerTitleTarget}
                        testID="session-header-title"
                    >
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[sessionHeaderTitleStyles.headerTitleText, tintColor ? { color: tintColor } : null]}
                        >
                            {title}
                        </Text>
                    </Pressable>
                )}
                {renamingSession ? (
                    <ActivityIndicator size="small" color={tintColor ?? theme.colors.header.tint} />
                ) : null}
                {!editing && onAddTag ? (
                    <Pressable
                        accessibilityLabel={t('sidebarLists.tagInputPlaceholder')}
                        accessibilityRole="button"
                        onPress={beginAddingTag}
                        style={({ pressed }) => [
                            sessionHeaderTitleStyles.headerTagsButton,
                            pressed && sessionHeaderTitleStyles.headerTagsButtonPressed,
                        ]}
                        testID="session-header-tags-button"
                    >
                        <Text numberOfLines={1} style={sessionHeaderTitleStyles.headerTagsText}>
                            #
                        </Text>
                    </Pressable>
                ) : null}
                <View
                    accessibilityLabel={sessionStatus.statusText}
                    style={sessionHeaderTitleStyles.headerRunStatus}
                    testID="session-header-run-status"
                >
                    <View style={[sessionHeaderTitleStyles.headerRunStatusDot, { backgroundColor: sessionStatus.statusDotColor }]} />
                    <Text
                        numberOfLines={1}
                        style={[sessionHeaderTitleStyles.headerRunStatusText, { color: sessionStatus.statusColor }]}
                    >
                        {sessionStatus.statusText}
                    </Text>
                </View>
            </View>
            {editing && tagQuery ? (
                <ScrollView
                    keyboardShouldPersistTaps="handled"
                    nativeID="session-title-tag-results"
                    role={'listbox' as never}
                    style={sessionHeaderTitleStyles.tagResults}
                    testID="session-title-tag-results"
                >
                    {matchingTags.map((tag, index) => (
                        <Pressable
                            accessibilityState={{
                                disabled: !tags.some((selectedTag) => selectedTag.id === tag.id) && sessionTagLimitReached,
                                selected: tags.some((selectedTag) => selectedTag.id === tag.id),
                            }}
                            aria-disabled={!tags.some((selectedTag) => selectedTag.id === tag.id) && sessionTagLimitReached}
                            aria-selected={tags.some((selectedTag) => selectedTag.id === tag.id)}
                            disabled={!tags.some((selectedTag) => selectedTag.id === tag.id) && sessionTagLimitReached}
                            key={tag.id}
                            nativeID={`session-title-tag-option-${index}`}
                            onPress={() => applyTag(tag)}
                            onPressIn={() => { choosingTagRef.current = true; }}
                            role="option"
                            style={({ pressed }) => [
                                sessionHeaderTitleStyles.tagResult,
                                (pressed || activeTagOption === index) && sessionHeaderTitleStyles.tagResultActive,
                                !tags.some((selectedTag) => selectedTag.id === tag.id) && sessionTagLimitReached && sessionHeaderTitleStyles.tagResultDisabled,
                            ]}
                            testID={`session-title-tag-result-${tag.id}`}
                        >
                            <Text numberOfLines={1} style={sessionHeaderTitleStyles.tagResultText}>#{tag.name}</Text>
                            {tags.some((selectedTag) => selectedTag.id === tag.id) ? <Ionicons color={theme.colors.accent} name="checkmark" size={15} /> : null}
                        </Pressable>
                    ))}
                    {canCreateTag ? (
                        <Pressable
                            nativeID={`session-title-tag-option-${matchingTags.length}`}
                            onPress={createTag}
                            onPressIn={() => { choosingTagRef.current = true; }}
                            role="option"
                            style={({ pressed }) => [sessionHeaderTitleStyles.tagResult, (pressed || activeTagOption === matchingTags.length) && sessionHeaderTitleStyles.tagResultActive]}
                            testID="session-title-create-tag"
                        >
                            <Ionicons color={theme.colors.textSecondary} name="add" size={16} />
                            <Text numberOfLines={1} style={sessionHeaderTitleStyles.tagResultText}>{t('sidebarLists.createTagNamed', { name: `#${tagQuery.query.trim()}` })}</Text>
                        </Pressable>
                    ) : null}
                    {matchingTags.length === 0 && !canCreateTag ? (
                        <Text style={sessionHeaderTitleStyles.tagEmpty}>{tagCreationLimitReached ? t('sidebarLists.tagLimitReached') : t('sidebarLists.noTags')}</Text>
                    ) : null}
                </ScrollView>
            ) : null}
        </View>
    );
}

function SessionHeaderMoreAction({
    expanded,
    onPress,
}: {
    expanded: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const label = t('sessionInfo.viewDetails');

    return (
        <View style={workspaceStyles.headerIconWrapper}>
            <Pressable
                accessibilityLabel={label}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={onPress}
                hitSlop={8}
                style={({ pressed }) => [
                    workspaceStyles.headerIconButton,
                    expanded && workspaceStyles.headerIconButtonSelected,
                    pressed && workspaceStyles.headerIconButtonPressed,
                ]}
                testID="session-header-more-button"
            >
                <Ionicons
                    name="ellipsis-horizontal"
                    size={20}
                    color={theme.colors.header.tint}
                />
            </Pressable>
        </View>
    );
}

export const SessionView = React.memo((props: { id: string }) => (
    <SubagentInspectorProvider sessionId={props.id}>
        <SessionViewContent {...props} />
    </SubagentInspectorProvider>
));

const SessionViewContent = React.memo((props: { id: string }) => {
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
    const sidebarOrganization = useSetting('sidebarOrganization');
    const updateSidebarOrganization = useSettingUpdater('sidebarOrganization');
    const [desktopRightPanelCollapsed, setDesktopRightPanelCollapsed] = useLocalSettingMutable('desktopRightPanelCollapsed');
    const [rightDrawerOpen, setRightDrawerOpen] = React.useState(false);
    const [organizerOpen, setOrganizerOpen] = React.useState(false);
    const {
        leftVisible: desktopLeftSidebarVisible,
        leftWidth: desktopLeftSidebarWidth,
        rightPanelAvailable: layoutRightPanelAvailable,
        rightExpandedWidth: layoutRightPanelExpandedWidth,
        rightWidth: layoutRightPanelWidth,
    } = useDesktopWorkspaceLayout();
    const sessionComposerHandleRef = React.useRef<ChatComposerHandle | null>(null);
    const subagentInspector = useSubagentInspector();
    const subagentSelection = subagentInspector?.selection ?? null;

    // The capability hub is a first-class desktop panel. File browsing is an
    // optional mode inside that same panel instead of a separate fourth column.
    const desktopRightPanelAvailable = layoutRightPanelAvailable && isDataReady && !!session;
    const widthRightPanelMode = getResponsiveRightPanelMode(windowWidth);
    const responsiveRightPanelMode = desktopRightPanelAvailable
        ? 'persistent'
        : widthRightPanelMode === 'edge-handle'
            ? 'edge-handle'
            : 'drawer-toggle';
    const compactRightDrawerAvailable = !desktopRightPanelAvailable && isDataReady && !!session;
    const canShowFilePanel = desktopRightPanelAvailable && fileDiffsSidebarEnabled;
    const desktopRightPanelPresentation = getDesktopRightPanelPresentation({
        available: desktopRightPanelAvailable,
        collapsed: desktopRightPanelCollapsed,
        zenMode,
    });
    const showDesktopRightPanel = desktopRightPanelPresentation === 'expanded';

    React.useEffect(() => {
        if (responsiveRightPanelMode === 'persistent' || !isDataReady || !session) {
            setRightDrawerOpen(false);
        }
    }, [isDataReady, responsiveRightPanelMode, session]);

    const rightPanelWidth = desktopRightPanelAvailable
        ? Math.max(layoutRightPanelWidth, layoutRightPanelExpandedWidth)
        : 0;

    // Animate diff sidebar width.
    //
    // On web we snap the value (duration: 0). The animated `width` change
    // triggers a flex-row reflow on every frame, which in turn re-measures
    // the entire chat tree (FlatList rows, message blocks). At ~60fps that
    // grinds to ~15fps on dev builds. Snapping skips the layout thrash —
    // the chat reflows once instead of 60 times. Native keeps the smooth
    // animation because it runs on Reanimated's UI thread.
    const rightPanelAnim = useSharedValue(showDesktopRightPanel ? 1 : 0);
    React.useEffect(() => {
        rightPanelAnim.value = withTiming(showDesktopRightPanel ? 1 : 0, {
            duration: Platform.OS === 'web' ? 0 : 250,
            easing: Easing.out(Easing.cubic),
        });
    }, [showDesktopRightPanel]);
    const animatedRightPanelStyle = useAnimatedStyle(() => ({
        width: rightPanelAnim.value * rightPanelWidth,
        opacity: Platform.OS === 'web' ? 1 : rightPanelAnim.value,
        overflow: Platform.OS === 'web' ? 'visible' as const : 'hidden' as const,
    }));

    const [sidebarMode, setSidebarMode] = React.useState<SidebarMode>('changes');
    const [desktopPanelMode, setDesktopPanelMode] = React.useState<'capabilities' | 'files'>('capabilities');
    React.useEffect(() => {
        if (!canShowFilePanel && desktopPanelMode === 'files') {
            setDesktopPanelMode('capabilities');
        }
    }, [canShowFilePanel, desktopPanelMode]);

    // Overlay state is managed as a browser-style history stack so the
    // sidebar's back / forward arrows can navigate between chat ↔ diff ↔ file
    // without a per-overlay close button. Stack + cursor live in one piece
    // of state so functional updates stay coordinated.
    type OverlayEntry =
        | { kind: 'none' }
        | { kind: 'diff'; file: string }
        | { kind: 'file'; path: string };
    type OverlayHistoryState = {
        cursor: number;
        direction: DesktopTransitionDirection;
        immediate: boolean;
        stack: OverlayEntry[];
    };
    const [overlayHistory, setOverlayHistory] = React.useState<OverlayHistoryState>({
        cursor: 0,
        direction: 'forward',
        immediate: true,
        stack: [{ kind: 'none' }],
    });
    const overlayCurrent = overlayHistory.stack[overlayHistory.cursor] ?? { kind: 'none' };
    const diffViewOpen = overlayCurrent.kind === 'diff';
    const fileViewPath = overlayCurrent.kind === 'file' ? overlayCurrent.path : null;
    const scrollToFile = overlayCurrent.kind === 'diff' ? overlayCurrent.file : null;
    const overlayTransitionKey = overlayCurrent.kind === 'diff'
        ? `diff:${overlayCurrent.file}`
        : overlayCurrent.kind === 'file'
            ? `file:${overlayCurrent.path}`
            : 'chat';

    const pushOverlay = React.useCallback((entry: OverlayEntry) => {
        setOverlayHistory((prev) => {
            const truncated = prev.stack.slice(0, prev.cursor + 1);
            truncated.push(entry);
            return {
                stack: truncated,
                cursor: truncated.length - 1,
                direction: 'forward',
                immediate: false,
            };
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
        if (!canShowFilePanel) {
            setOverlayHistory({
                stack: [{ kind: 'none' }],
                cursor: 0,
                direction: 'back',
                immediate: true,
            });
        }
    }, [canShowFilePanel]);

    // Right-side header content published by the active overlay (diff toggle / save button).
    type OwnedHeaderRightSlot = { ownerKey: string; slot: React.ReactNode };
    const [ownedHeaderRightSlot, setOwnedHeaderRightSlot] = React.useState<OwnedHeaderRightSlot>({
        ownerKey: 'chat',
        slot: null,
    });
    const headerRightSlot = ownedHeaderRightSlot.ownerKey === overlayTransitionKey
        ? ownedHeaderRightSlot.slot
        : null;
    const activeOverlayKeyRef = React.useRef(overlayTransitionKey);
    const publishOverlayHeaderRightSlot = React.useCallback((slot: React.ReactNode) => {
        const publisherOwnerKey = overlayTransitionKey;
        if (activeOverlayKeyRef.current !== publisherOwnerKey) return;
        setOwnedHeaderRightSlot((current) => {
            if (activeOverlayKeyRef.current !== publisherOwnerKey) return current;
            return { ownerKey: publisherOwnerKey, slot };
        });
    }, [overlayTransitionKey]);

    React.useLayoutEffect(() => {
        activeOverlayKeyRef.current = overlayTransitionKey;
        setOwnedHeaderRightSlot({ ownerKey: overlayTransitionKey, slot: null });
    }, [overlayTransitionKey]);

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
                    prev.cursor <= 0 ? prev : {
                        ...prev,
                        cursor: prev.cursor - 1,
                        direction: 'back',
                        immediate: false,
                    }
                ));
                return true;
            },
            forward: () => {
                if (!canOverlayForward) return false;
                setOverlayHistory((prev) => (
                    prev.cursor >= prev.stack.length - 1 ? prev : {
                        ...prev,
                        cursor: prev.cursor + 1,
                        direction: 'forward',
                        immediate: false,
                    }
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
    // agent + machine + connection state. The dropdown keeps runtime identity
    // read-only while letting next-turn model, effort, and permissions update.
    const [infoPanelOpen, setInfoPanelOpen] = React.useState(false);
    React.useEffect(() => {
        if (!subagentSelection || !isDataReady || !session) return;
        setInfoPanelOpen(false);
        if (desktopRightPanelAvailable) {
            setDesktopRightPanelCollapsed(false);
        } else {
            setRightDrawerOpen(true);
        }
    }, [desktopRightPanelAvailable, isDataReady, session, setDesktopRightPanelCollapsed, subagentSelection]);
    const toggleCompactRightDrawer = React.useCallback(() => {
        if (!compactRightDrawerAvailable) return;
        if (rightDrawerOpen) {
            subagentInspector?.close();
            setRightDrawerOpen(false);
            return;
        }
        // Do not stack the Capability Hub over another top-level dialog such
        // as the composer permission picker. The open drawer itself remains
        // closable through this same shortcut.
        if (hasVisibleWebDialog()) return;
        setInfoPanelOpen(false);
        setRightDrawerOpen(true);
    }, [compactRightDrawerAvailable, rightDrawerOpen, subagentInspector]);
    useGlobalKeyboard(undefined, {
        onToggleRightSidebar: compactRightDrawerAvailable ? toggleCompactRightDrawer : undefined,
    });
    const sessionOnline = session?.presence === 'online';
    const agentLabel = React.useMemo(() => {
        const flavor = session?.metadata?.flavor ?? 'claude';
        return AGENT_LABELS[flavor] ?? flavor;
    }, [session?.metadata?.flavor]);
    const sessionMachine = useMachine(session?.metadata?.machineId ?? '');
    const machineName = sessionMachine?.metadata?.displayName
        || session?.metadata?.name
        || sessionMachine?.metadata?.host
        || session?.metadata?.host
        || null;
    const showChip = isDataReady && !!session;
    const compactSessionHeader = shouldUseCompactSessionHeader({ isTablet, windowWidth });
    const sessionOrganization = sidebarOrganization.sessions[sessionId] ?? { listId: null, tagIds: [] };
    const sessionTags = sessionOrganization.tagIds
        .map((tagId) => sidebarOrganization.tags.find((tag) => tag.id === tagId))
        .filter((tag): tag is SidebarTag => !!tag);
    const addSessionTag = React.useCallback((tag: SidebarTag) => {
        updateSidebarOrganization((current) => {
            const currentAssignment = current.sessions[sessionId] ?? { listId: null, tagIds: [] };
            if (currentAssignment.tagIds.includes(tag.id)) return current;
            if (currentAssignment.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT) return current;
            return organizeSessionWithCreatedTags(current, sessionId, {
                ...currentAssignment,
                tagIds: [...currentAssignment.tagIds, tag.id],
            }, current.tags.some((currentTag) => currentTag.id === tag.id) ? [] : [tag]);
        });
    }, [sessionId, updateSidebarOrganization]);
    const removeSessionTag = React.useCallback((tagId: string) => {
        updateSidebarOrganization((current) => {
            const currentAssignment = current.sessions[sessionId] ?? { listId: null, tagIds: [] };
            if (!currentAssignment.tagIds.includes(tagId)) return current;
            return organizeSessionWithCreatedTags(current, sessionId, {
                ...currentAssignment,
                tagIds: currentAssignment.tagIds.filter((currentTagId) => currentTagId !== tagId),
            }, []);
        });
    }, [sessionId, updateSidebarOrganization]);
    const constrainedDrawerHeader = compactSessionHeader && compactRightDrawerAvailable && rightDrawerOpen;
    // 会话内「进入空间/退出空间」：进入 = 设 agentSpaceId + 拉出工作台抽屉；退出 = 清空间并回首页。
    const { enter: enterSpace, exit: exitSpace } = useAgentSpace();

    // Resolve the session's persisted Agent once through the canonical matcher,
    // then share that identity between the header skin and the phone panel.
    const spaceAgent = useSpaceAgentForSession(session);
    workspaceStyles.useVariants({
        agentChipDensity: constrainedDrawerHeader ? 'constrained' : 'regular',
        headerDensity: compactSessionHeader ? 'compact' : 'regular',
    });

    const sessionHeaderChip = showChip ? (
        <SessionHeaderChip
            agentLabel={agentLabel}
            compact={compactSessionHeader}
            condensed={constrainedDrawerHeader}
            machineName={machineName}
            online={sessionOnline}
            open={infoPanelOpen}
            onPress={() => setInfoPanelOpen(v => !v)}
        />
    ) : undefined;
    const desktopWebHeader = Platform.OS === 'web' && isTablet;
    const headerTitleSlot = showChip ? (
        desktopWebHeader ? (
            <View style={workspaceStyles.headerIdentity}>
                <SessionHeaderTitle
                    availableTags={sidebarOrganization.tags}
                    compact={compactSessionHeader}
                    onAddTag={addSessionTag}
                    session={session!}
                    tags={sessionTags}
                    title={headerProps.title}
                />
            </View>
        ) : isTablet ? (
            <View style={workspaceStyles.headerIdentity}>
                <SessionHeaderTitle
                    availableTags={sidebarOrganization.tags}
                    compact={compactSessionHeader}
                    onAddTag={addSessionTag}
                    session={session!}
                    tags={sessionTags}
                    title={headerProps.title}
                />
                <View style={workspaceStyles.headerAgentChip}>
                    {sessionHeaderChip}
                </View>
            </View>
        ) : sessionHeaderChip
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
            {isTablet ? (
                <SessionHeaderTitle availableTags={sidebarOrganization.tags} onAddTag={addSessionTag} session={session!} tags={sessionTags} title={headerProps.title} tintColor={spaceTint} />
            ) : (
                <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: spaceTint, fontSize: 15, fontWeight: '600' }}>
                    {headerProps.title}
                </Text>
            )}
        </View>
    ) : undefined;

    const subagentPanelLabel = subagentSelection
        ? t('toolGroup.subagentPanelLabel', { title: subagentSelection.title ?? subagentSelection.id })
        : null;
    const desktopPanelLabel = subagentPanelLabel ?? (desktopPanelMode === 'files' && canShowFilePanel
        ? t('common.files')
        : t('rightPanelCapabilityHub.title'));
    const compactPanelLabel = subagentPanelLabel ?? (spaceAgent
        ? t('agentSpace.companion.panelTitle')
        : t('rightPanelCapabilityHub.title'));
    const rightPanelToggleLabel = desktopRightPanelAvailable
        ? desktopPanelLabel
        : compactPanelLabel;
    const rightPanelToggleButton = (
        (desktopRightPanelAvailable && desktopRightPanelPresentation !== 'zen')
        || compactRightDrawerAvailable
    ) ? (
        <DesktopRightPanelToggleButton
            expanded={desktopRightPanelAvailable ? showDesktopRightPanel : rightDrawerOpen}
            label={(desktopRightPanelAvailable ? showDesktopRightPanel : rightDrawerOpen)
                ? t('desktopWorkspace.hidePanel', { panel: rightPanelToggleLabel })
                : t('desktopWorkspace.showPanel', { panel: rightPanelToggleLabel })}
            onPress={() => {
                if (desktopRightPanelAvailable) {
                    if (showDesktopRightPanel) subagentInspector?.close();
                    setDesktopRightPanelCollapsed(showDesktopRightPanel);
                    return;
                }
                toggleCompactRightDrawer();
            }}
        />
    ) : null;

    const moreButton = isTablet && !spaceAgent ? (
        <SessionHeaderMoreAction
            expanded={infoPanelOpen}
            onPress={() => setInfoPanelOpen((value) => !value)}
        />
    ) : null;
    const defaultHeaderRightSlot = (
        <View style={workspaceStyles.headerActions}>
            {moreButton}
            {rightPanelToggleButton}
            {spaceAgent ? exitSpaceButton : null}
        </View>
    );
    const overlayHeaderRightSlot = (
        <View style={workspaceStyles.headerActions}>
            {moreButton}
            {rightPanelToggleButton}
            {headerRightSlot}
        </View>
    );
    const persistentHeaderContentInset = isTablet
        ? getPersistentHeaderContentInset({
            windowWidth,
            headerMaxWidth: layout.headerMaxWidth,
            headerHorizontalPadding: Platform.OS === 'ios' ? 8 : 16,
            sidebarVisible: desktopLeftSidebarVisible,
            sidebarWidth: desktopLeftSidebarWidth,
            rightPanelWidth: showDesktopRightPanel ? rightPanelWidth : 0,
            // SidebarNavigator 同时存在 `left: sidebar + 16` 和非 Tauri 环境下的
            // `paddingLeft: 16`，命中区域计算必须包含第二段偏移。
            controlStartPadding: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
            buttonCount: Platform.OS === 'web' ? 4 : 3,
            controlsWidth: Platform.OS === 'web'
                ? PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH
                : getPersistentNavigationControlsWidth(3),
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
                        compactRightSlot={compactSessionHeader}
                        leftSlot={enterSpaceButton}
                        titleSlot={spaceAgent ? spaceTitleSlot : headerTitleSlot}
                        rightSlot={(diffViewOpen || !!fileViewPath) ? overlayHeaderRightSlot : defaultHeaderRightSlot}
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
                    <SessionViewLoaded
                        key={sessionId}
                        composerHandleRef={sessionComposerHandleRef}
                        onManageTags={() => setOrganizerOpen(true)}
                        onRemoveTag={removeSessionTag}
                        sessionId={sessionId}
                        session={session}
                        tags={sessionTags}
                    />
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
                    onShareSession={() => {
                        setInfoPanelOpen(false);
                        Modal.show({
                            accessibilityLabel: t('sessionShare.shareSession'),
                            component: PublicSessionShareDialog,
                            props: {
                                sessionId,
                                title: headerProps.title,
                            },
                        });
                    }}
                    onViewDetails={() => {
                        setInfoPanelOpen(false);
                        router.push(`/session/${sessionId}/info`);
                    }}
                />
            )}
            {session ? (
                <SessionOrganizerDialog
                    assignment={sessionOrganization}
                    autoFocusTags
                    onClose={() => setOrganizerOpen(false)}
                    onSave={(assignment, createdTags) => updateSidebarOrganization((current) => (
                        organizeSessionWithCreatedTags(current, sessionId, assignment, createdTags)
                    ))}
                    organization={sidebarOrganization}
                    sessionName={headerProps.title}
                    visible={organizerOpen}
                />
            ) : null}
        </>
    );

    if (!desktopRightPanelAvailable) {
        const rightPanel = subagentSelection ? (
            <SubagentInspectorPanel
                onBack={() => subagentInspector?.close()}
                selection={subagentSelection}
                sessionId={sessionId}
            />
        ) : (
            <SessionRightPanelContent
                composerHandleRef={sessionComposerHandleRef}
                sessionId={sessionId}
                spaceAgent={spaceAgent}
            />
        );
        return (
            <RightSwipePanelHost
                closeAccessibilityLabel={t('desktopWorkspace.hidePanel', { panel: compactPanelLabel })}
                enabled={isDataReady && !!session}
                gestureEnabled={false}
                fullWidth={subagentSelection !== null}
                mode={responsiveRightPanelMode === 'edge-handle' ? 'edge-handle' : 'drawer-toggle'}
                onOpenChange={(nextOpen) => {
                    if (nextOpen) setInfoPanelOpen(false);
                    if (!nextOpen) subagentInspector?.close();
                    setRightDrawerOpen(nextOpen);
                }}
                open={rightDrawerOpen}
                openAccessibilityLabel={t('desktopWorkspace.showPanel', { panel: compactPanelLabel })}
                panelAccessibilityLabel={compactPanelLabel}
                panelContent={rightPanel}
                showEdgeHandle={false}
            >
                {mainContent}
            </RightSwipePanelHost>
        );
    }

    const desktopPanelTabs = [
        {
            key: 'capabilities',
            label: t('rightPanelCapabilityHub.title'),
            icon: 'sparkles-outline' as const,
        },
        ...(canShowFilePanel ? [{
            key: 'files',
            label: t('common.files'),
            icon: 'folder-outline' as const,
        }] : []),
    ];

    // Desktop layout: chat + one independently collapsible capability panel.
    // File browsing is a tab in that panel, so enabling it never removes quick
    // prompts or creates a fourth column.
    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            <View
                style={[
                    workspaceStyles.desktopMain,
                    // Web-only: isolate the chat subtree's layout from the
                    // parent flex-row so right-panel layout work stays local.
                    Platform.OS === 'web' && ({ contain: 'layout style paint' } as any),
                ]}
                testID="desktop-workspace-main"
            >
                {mainContent}
                <View
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        top: safeArea.top + headerHeight,
                        left: 0,
                        right: 0,
                        bottom: 0,
                    }}
                >
                    <DesktopPresenceTransition
                        direction={overlayHistory.direction}
                        immediate={overlayHistory.immediate}
                        testID="workspace-overlay-transition"
                        transitionKey={overlayTransitionKey}
                    >
                        {diffViewOpen && canShowFilePanel ? (
                            <View style={workspaceStyles.overlaySurface} testID="workspace-diff-panel">
                                <AllFilesDiffView
                                    onHeaderRightSlotChange={publishOverlayHeaderRightSlot}
                                    scrollToFile={scrollToFile}
                                    sessionId={sessionId}
                                />
                            </View>
                        ) : fileViewPath && canShowFilePanel ? (
                            <View style={workspaceStyles.overlaySurface} testID="workspace-file-panel">
                                <FileViewPanel
                                    filePath={fileViewPath}
                                    onHeaderRightSlotChange={publishOverlayHeaderRightSlot}
                                    sessionId={sessionId}
                                />
                            </View>
                        ) : null}
                    </DesktopPresenceTransition>
                </View>
            </View>
            <Animated.View
                {...(Platform.OS === 'web' ? { inert: showDesktopRightPanel ? undefined : true } as any : {})}
                aria-hidden={!showDesktopRightPanel}
                accessibilityElementsHidden={!showDesktopRightPanel}
                importantForAccessibility={showDesktopRightPanel ? 'auto' : 'no-hide-descendants'}
                pointerEvents={showDesktopRightPanel ? 'auto' : 'none'}
                style={[workspaceStyles.desktopPanelClip, animatedRightPanelStyle]}
            >
                <View
                    {...(Platform.OS === 'web' ? {
                        dataSet: {
                            happyMotion: 'desktop-panel',
                            happyMotionSide: 'right',
                            happyMotionState: showDesktopRightPanel ? 'open' : 'closed',
                        },
                    } as any : {})}
                    style={[
                        workspaceStyles.desktopPanel,
                        { width: rightPanelWidth },
                        Platform.OS === 'web' && workspaceStyles.desktopPanelWeb,
                    ]}
                    testID="desktop-right-panel-motion"
                >
                    {subagentSelection ? (
                        <SubagentInspectorPanel
                            onBack={() => subagentInspector?.close()}
                            selection={subagentSelection}
                            sessionId={sessionId}
                        />
                    ) : <DesktopRightPanel
                        activeTab={desktopPanelMode}
                        collapseAccessibilityLabel={t('desktopWorkspace.hidePanel', {
                            panel: desktopPanelLabel,
                        })}
                        collapseLabel={t('desktopWorkspace.hidePanelShort')}
                        onCollapse={() => setDesktopRightPanelCollapsed(true)}
                        onTabChange={(key) => setDesktopPanelMode(key === 'files' ? 'files' : 'capabilities')}
                        showCollapseButton={false}
                        tabs={desktopPanelTabs}
                    >
                        <DesktopPresenceTransition
                            direction={desktopPanelMode === 'files' ? 'forward' : 'back'}
                            immediate={!canShowFilePanel}
                            testID="desktop-right-panel-content-transition"
                            transitionKey={desktopPanelMode}
                        >
                            {desktopPanelMode === 'files' && canShowFilePanel ? (
                                <FilesSidebar
                                    mode={sidebarMode}
                                    onAllFilesFilePress={handleAllFilesFilePress}
                                    onFilePress={handleSidebarFilePress}
                                    onModeChange={setSidebarMode}
                                    selectedPath={sidebarMode === 'changes' ? scrollToFile : fileViewPath}
                                    sessionId={sessionId}
                                />
                            ) : (
                                <SessionRightPanelContent
                                    composerHandleRef={sessionComposerHandleRef}
                                    sessionId={sessionId}
                                    spaceAgent={spaceAgent}
                                />
                            )}
                        </DesktopPresenceTransition>
                    </DesktopRightPanel>}
                </View>
            </Animated.View>
        </View>
    );
});

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
    onManageTags,
    onRemoveTag,
    tags,
}: {
    sessionId: string;
    session: Session;
    composerHandleRef: React.RefObject<ChatComposerHandle | null>;
    onManageTags: () => void;
    onRemoveTag: (tagId: string) => void;
    tags: readonly SidebarTag[];
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
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const experiments = useSetting('experiments');
    const expResumeSession = useSetting('expResumeSession');
    const desktopScreenshotEnabled = useSetting('expDesktopScreenshot');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);
    const permissionSelector = useSessionTaskPermission(session, !isDisconnected);
    const getCurrentDraft = React.useCallback(
        () => composerHandleRef.current?.getMessage() ?? '',
        [composerHandleRef],
    );
    const workingDirectory = useSessionWorkingDirectory(session, getCurrentDraft);
    const directorySelector = React.useMemo<SessionComposerDirectorySelectorConfig | undefined>(() => {
        if (!workingDirectory.currentPath || !workingDirectory.machineId) {
            return undefined;
        }
        return {
            currentPath: workingDirectory.currentPath,
            currentPathLabel: workingDirectory.currentPathLabel,
            homeDir: workingDirectory.homeDir,
            machineId: workingDirectory.machineId,
            machineOnline: workingDirectory.machineOnline,
            recentPaths: workingDirectory.recentPaths,
            switching: workingDirectory.switching,
            onSwitch: async (path: string) => {
                const result = await workingDirectory.switchDirectory(path);
                return result.success ? { success: true } : result;
            },
        };
    }, [workingDirectory]);

    const nextTurnModes = React.useMemo(() => resolveRunningSessionTurnModes({
        session,
        agentDefaultOverrides,
        translate: t,
    }), [agentDefaultOverrides, session]);
    const handleModelChange = React.useCallback((key: string) => {
        storage.getState().updateSessionModelMode(sessionId, key);
        if (!supportsCodexFast(session.metadata, key)) {
            storage.getState().updateSessionFastMode(sessionId, false);
        }
    }, [session.metadata, sessionId]);
    const handleEffortChange = React.useCallback((key: string) => {
        storage.getState().updateSessionEffortLevel(sessionId, key);
    }, [sessionId]);
    const handleFastModeChange = React.useCallback((enabled: boolean) => {
        storage.getState().updateSessionFastMode(sessionId, enabled);
    }, [sessionId]);
    const modeSelector = React.useMemo(() => ({
        online: !isDisconnected,
        model: nextTurnModes.modelMode,
        modelOptions: nextTurnModes.availableModels,
        effort: nextTurnModes.effortLevel,
        effortOptions: nextTurnModes.availableEffortLevels,
        onModelChange: handleModelChange,
        onEffortChange: handleEffortChange,
        fastMode: session.fastMode === true,
        supportsFast: nextTurnModes.supportsFast,
        onFastModeChange: handleFastModeChange,
    }), [handleEffortChange, handleFastModeChange, handleModelChange, isDisconnected, nextTurnModes, session.fastMode]);

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
                const persistentUri = await saveBase64Png(res.dataBase64);
                const entry = addScreenshotEntry(sessionId, {
                    uri: persistentUri,
                    source: 'manual',
                    target,
                    createdAt: Date.now(),
                });
                const displayUri = await resolveScreenshotUri(persistentUri);
                imageViewer.open({ uri: displayUri, filename: `screenshot-${entry.id}.png` });
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
        return sessionAbort(sessionId);
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
            showAbortButton={sessionStatus.state === 'running'}
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
            permissionSelector={permissionSelector}
            modeSelector={modeSelector}
            directorySelector={directorySelector}
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
            <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                <View style={sessionCanvasTagStyles.row} testID="session-canvas-tags">
                    {tags.length > 0 ? (
                        <>
                        {tags.map((tag) => (
                            <SessionCanvasTag
                                key={tag.id}
                                onManageTags={onManageTags}
                                onRemove={() => onRemoveTag(tag.id)}
                                tag={tag}
                            />
                        ))}
                        </>
                    ) : null}
                    <Pressable accessibilityLabel={t('sidebarLists.organizeSession')} accessibilityRole="button" onPress={onManageTags} style={({ pressed }) => [sessionCanvasTagStyles.add, pressed && sessionCanvasTagStyles.tagPressed]} testID="session-canvas-add-tag">
                        <Ionicons color={theme.colors.textLink} name="add" size={18} />
                    </Pressable>
                </View>
            </CenteredInputWidth>
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

function SessionCanvasTag({
    onManageTags,
    onRemove,
    tag,
}: {
    onManageTags: () => void;
    onRemove: () => void;
    tag: SidebarTag;
}) {
    const { theme } = useUnistyles();
    const removable = Platform.OS === 'web';
    const [hovered, setHovered] = React.useState(false);
    const [removeFocused, setRemoveFocused] = React.useState(false);
    const showRemove = removable && (hovered || removeFocused);

    return (
        <View style={sessionCanvasTagStyles.tag}>
            <Pressable
                accessibilityLabel={`${t('sidebarLists.organizeSession')}: #${tag.name}`}
                accessibilityRole="button"
                onHoverIn={removable ? () => setHovered(true) : undefined}
                onHoverOut={removable ? () => setHovered(false) : undefined}
                onPress={onManageTags}
                style={({ pressed }) => [
                    sessionCanvasTagStyles.tagLabel,
                    pressed && sessionCanvasTagStyles.tagPressed,
                ]}
                testID={`session-canvas-tag-${tag.id}`}
            >
                <Text numberOfLines={1} style={sessionCanvasTagStyles.tagText}>#{tag.name}</Text>
            </Pressable>
            {removable ? (
                <Pressable
                    accessibilityLabel={`${t('common.delete')} #${tag.name}`}
                    accessibilityRole="button"
                    onBlur={() => setRemoveFocused(false)}
                    onFocus={() => setRemoveFocused(true)}
                    onHoverIn={() => setHovered(true)}
                    onHoverOut={() => setHovered(false)}
                    onPress={onRemove}
                    style={({ pressed }) => [
                        sessionCanvasTagStyles.remove,
                        showRemove ? sessionCanvasTagStyles.removeVisible : sessionCanvasTagStyles.removeHidden,
                        pressed && sessionCanvasTagStyles.removePressed,
                    ]}
                    testID={`session-canvas-remove-tag-${tag.id}`}
                >
                    <Ionicons color={theme.colors.textSecondary} name="close" size={13} />
                </Pressable>
            ) : null}
        </View>
    );
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

const sessionHeaderTitleStyles = StyleSheet.create((theme) => ({
    headerTitleWrapper: {
        position: 'relative',
        flex: 1,
        variants: {
            headerTitleDensity: {
                regular: {
                    minWidth: 64,
                },
                compact: {
                    minWidth: 39,
                },
            },
        },
    },
    headerTitleLine: {
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        variants: {
            headerTitleDensity: {
                regular: {
                    gap: 8,
                },
                compact: {
                    gap: 0,
                },
            },
        },
    },
    headerTitleTarget: {
        minHeight: 40,
        minWidth: 32,
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        overflow: 'hidden',
    },
    headerTitleText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.header.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    headerTitleInput: {
        minHeight: 32,
        flex: 1,
        minWidth: 0,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: theme.colors.textLink,
        color: theme.colors.header.tint,
        fontSize: 14,
        fontWeight: '600',
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    },
    tagResults: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        left: 0,
        maxHeight: 280,
        minWidth: 220,
        overflow: 'hidden',
        position: 'absolute',
        top: 38,
        width: '100%',
        zIndex: 1200,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
    },
    tagResult: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        minHeight: 40,
        paddingHorizontal: 12,
    },
    tagResultActive: { backgroundColor: theme.colors.surfaceSelected },
    tagResultDisabled: { opacity: 0.45 },
    tagResultText: { color: theme.colors.text, flex: 1, fontSize: 13, fontWeight: '600' },
    tagEmpty: { color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 12, paddingVertical: 12 },
    headerTagsButton: {
        alignItems: 'center',
        borderRadius: 12,
        flexShrink: 1,
        justifyContent: 'center',
        maxWidth: 180,
        minHeight: 28,
        minWidth: 28,
        paddingHorizontal: 8,
    },
    headerTagsButtonSelected: { backgroundColor: theme.colors.surfaceSelected },
    headerTagsButtonPressed: { backgroundColor: theme.colors.surfacePressed },
    headerTagsText: { color: theme.colors.header.tint, flexShrink: 1, fontSize: 11, fontWeight: '600' },
    headerRunStatus: {
        maxWidth: 122,
        minWidth: 0,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    headerRunStatusDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        flexShrink: 0,
    },
    headerRunStatusText: {
        flexShrink: 1,
        fontSize: 11,
        fontWeight: '600',
    },
}));

const sessionCanvasTagStyles = StyleSheet.create((theme) => ({
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingBottom: 8,
        paddingHorizontal: 6,
        paddingTop: 4,
    },
    tag: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceSelected,
        borderRadius: 14,
        flexDirection: 'row',
        minHeight: 28,
        maxWidth: 204,
        overflow: 'hidden',
    },
    tagLabel: {
        flexShrink: 1,
        justifyContent: 'center',
        minHeight: 28,
        minWidth: 0,
        paddingHorizontal: 11,
    },
    tagPressed: { opacity: 0.72 },
    tagText: { color: theme.colors.text, fontSize: 12, fontWeight: '600' },
    remove: {
        alignItems: 'center',
        alignSelf: 'stretch',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    removeHidden: {
        opacity: 0,
        width: 0,
    },
    removeVisible: {
        opacity: 1,
        paddingRight: 7,
        width: 22,
    },
    removePressed: { backgroundColor: theme.colors.surfacePressed },
    add: {
        alignItems: 'center',
        borderColor: theme.colors.textLink,
        borderRadius: 14,
        borderWidth: 1,
        height: 28,
        justifyContent: 'center',
        width: 38,
    },
}));

const workspaceStyles = StyleSheet.create((theme) => ({
    headerIdentity: {
        flex: 1,
        alignSelf: 'stretch',
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        variants: {
            headerDensity: {
                regular: {
                    gap: 10,
                },
                compact: {
                    gap: 0,
                },
            },
        },
    },
    headerAgentChip: {
        flexShrink: 1,
        variants: {
            agentChipDensity: {
                regular: {
                    flexBasis: 160,
                    minWidth: 116,
                    maxWidth: 220,
                },
                constrained: {
                    flexBasis: 60,
                    minWidth: 60,
                    maxWidth: 60,
                },
            },
        },
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        variants: {
            headerDensity: {
                regular: {
                    gap: 5,
                },
                compact: {
                    gap: 3,
                },
            },
        },
    },
    headerIconWrapper: {
        position: 'relative',
        width: 40,
        height: 40,
    },
    headerIconButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
    },
    headerIconButtonSelected: {
        backgroundColor: theme.colors.surfacePressed,
    },
    headerIconButtonPressed: {
        opacity: 0.7,
    },
    desktopMain: {
        flex: 1,
        minWidth: DESKTOP_MAIN_MIN_WIDTH,
    },
    overlaySurface: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: theme.colors.surface,
        pointerEvents: 'box-none',
    },
    desktopPanelClip: {
        minWidth: 0,
        alignSelf: 'stretch',
    },
    desktopPanel: {
        flex: 1,
    },
    desktopPanelWeb: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
    },
}));
