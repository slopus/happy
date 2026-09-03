import * as React from 'react';
import {
    FlatList,
    Platform,
    Pressable,
    ScrollView,
    TextInput,
    type GestureResponderEvent,
    type LayoutChangeEvent,
    View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { mq, StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Modal } from '@/modal';
import {
    useAllMachines,
    useLocalSettingMutable,
    useSetting,
    useSettingUpdater,
    type SessionRowData,
} from '@/sync/storage';
import type { NewSessionAgentType } from '@/sync/persistence';
import { t } from '@/text';
import { DesktopDialogFrame } from './DesktopDialogFrame';
import { PathPickerContent, PickerContent, type PickerItem } from './SessionConfigPanel';
import { SessionOrganizerDialog } from './SessionOrganizerDialog';
import {
    registerSidebarDraggable,
    registerSidebarDropTarget,
    type SidebarDragData,
    type SidebarDropPosition,
} from './sidebarDrag';
import {
    buildSidebarSessionIndex,
    createSidebarOrganizationId,
    normalizeSidebarTagName,
    moveSidebarSessionToList,
    organizeSessionWithCreatedTags,
    reorderSidebarList,
    removeSidebarList,
    SIDEBAR_LIST_COLORS,
    SIDEBAR_FOLDER_MAX_COUNT,
    SIDEBAR_LIST_MAX_COUNT,
    SIDEBAR_LIST_NAME_MAX_LENGTH,
    SIDEBAR_TAG_MAX_COUNT,
    type SidebarList,
    type SidebarListColor,
    type SidebarOrganization,
    type SidebarTag,
} from '@/sync/sidebarOrganization';
import { isMachineOnline } from '@/utils/machineUtils';
import { formatPathRelativeToHome, getSessionStateLabel } from '@/utils/sessionUtils';
import { CompactSessionRow, STATUS_CONFIG } from './ActiveSessionsGroupCompact';
import { ProjectSectionHeader } from './ProjectSectionHeader';
import { useSessionManagementPreferences } from '@/hooks/useSessionManagementPreferences';
import { partitionSessionsByPinnedOrder } from '@/utils/sessionPinning';
import { useIsTablet } from '@/utils/responsive';
import {
    buildSidebarLibraryFolderGroups,
    buildSidebarLibraryProjects,
    collectSidebarSessions,
    getSidebarLibrarySessions,
    type SidebarLibrarySelection,
} from '@/utils/sidebarLibraryNavigation';
import { buildSessionNavigationTimeGroups } from '@/utils/sessionNavigationGroups';
import {
    clampDesktopSidebarOrganizationWidth,
    getDesktopSidebarOrganizationMaxWidth,
    DESKTOP_SIDEBAR_ORGANIZATION_MIN_WIDTH,
} from '@/utils/desktopNavigationLayout';

const AGENT_TYPES = ['codex', 'claude', 'opencode', 'gemini', 'openclaw'] as const satisfies readonly NewSessionAgentType[];
const AGENT_LABEL_KEYS = {
    codex: 'agentInput.agent.codex',
    claude: 'agentInput.agent.claude',
    opencode: 'agentInput.agent.opencode',
    gemini: 'agentInput.agent.gemini',
    openclaw: 'agentInput.agent.openclaw',
} as const;
const COLOR_LABEL_KEYS: Record<SidebarListColor, 'sidebarLists.colors.blue' | 'sidebarLists.colors.green' | 'sidebarLists.colors.purple' | 'sidebarLists.colors.orange' | 'sidebarLists.colors.pink'> = {
    blue: 'sidebarLists.colors.blue',
    green: 'sidebarLists.colors.green',
    purple: 'sidebarLists.colors.purple',
    orange: 'sidebarLists.colors.orange',
    pink: 'sidebarLists.colors.pink',
};

function getListColors(colors: any): Record<SidebarListColor, string> {
    return {
        blue: colors.textLink,
        green: colors.success,
        purple: colors.particle.accent,
        orange: colors.accent,
        pink: colors.deleteAction,
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, minHeight: 0 },
    tabs: {
        flexDirection: 'row',
        minHeight: 44,
        marginHorizontal: 10,
        marginTop: 1,
        position: 'relative',
    },
    tabTrack: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 7,
        bottom: 7,
        left: 0,
        position: 'absolute',
        right: 0,
        top: 7,
    },
    tab: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        minHeight: 44,
    },
    tabVisual: {
        alignItems: 'center',
        borderRadius: 6,
        height: 30,
        justifyContent: 'center',
        width: '100%',
    },
    tabSelected: { backgroundColor: theme.colors.surface },
    tabPressed: { backgroundColor: theme.colors.surfacePressed },
    tabText: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default('semiBold') },
    tabTextSelected: { color: theme.colors.text },
    listsScroll: { flex: 1, minHeight: 0 },
    listsContent: { paddingBottom: 24, paddingTop: 10 },
    sectionHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 32,
        },
        paddingLeft: 16,
        paddingRight: 10,
    },
    sectionTitle: { color: theme.colors.groupped.sectionTitle, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    iconButton: {
        alignItems: 'center',
        borderRadius: 7,
        height: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 28,
        },
        justifyContent: 'center',
        width: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 28,
        },
    },
    iconButtonPressed: { backgroundColor: theme.colors.surfacePressed },
    listBlock: { marginBottom: 2, position: 'relative' },
    listRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        minHeight: 46,
        paddingHorizontal: 10,
    },
    listRowMain: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        minWidth: 0,
    },
    listRowPressed: { backgroundColor: theme.colors.surfacePressed },
    listDropTarget: {
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.colors.textLink,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
    },
    listDropIndicator: {
        backgroundColor: theme.colors.textLink,
        borderRadius: 2,
        height: 2,
        left: 12,
        pointerEvents: 'none',
        position: 'absolute',
        right: 12,
        zIndex: 2,
    },
    listDropIndicatorBefore: { top: -2 },
    listDropIndicatorAfter: { bottom: -2 },
    listGlyph: { alignItems: 'center', borderRadius: 7, height: 30, justifyContent: 'center', width: 30 },
    listCopy: { flex: 1, minWidth: 0 },
    listName: { color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') },
    listMeta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 1, ...Typography.default() },
    count: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    sessionRow: {
        alignItems: 'center',
        borderRadius: 8,
        flexDirection: 'row',
        marginRight: 8,
        minHeight: 48,
        paddingLeft: 10,
    },
    sessionRowNested: {
        borderLeftColor: theme.colors.divider,
        borderLeftWidth: StyleSheet.hairlineWidth,
        marginLeft: 30,
    },
    sessionRowSelected: { backgroundColor: theme.colors.surfaceSelected },
    sessionRowPressed: { backgroundColor: theme.colors.surfacePressed },
    sessionRowDragging: { backgroundColor: theme.colors.surfacePressed, opacity: 0.52, transform: [{ scale: 0.99 }] },
    sessionMain: { flex: 1, minWidth: 0, paddingVertical: 6 },
    sessionTitle: { color: theme.colors.text, fontSize: 13, ...Typography.default() },
    sessionMeta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2, ...Typography.default() },
    sessionTags: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 4, overflow: 'hidden' },
    sessionTag: { backgroundColor: theme.colors.surfaceHigh, borderRadius: 8, maxWidth: 92, paddingHorizontal: 6, paddingVertical: 1 },
    sessionTagText: { color: theme.colors.textSecondary, fontSize: 10, ...Typography.default('semiBold') },
    sessionTagMore: { color: theme.colors.textSecondary, fontSize: 10, ...Typography.default('semiBold') },
    newSessionRow: {
        alignItems: 'center',
        borderLeftColor: theme.colors.divider,
        borderLeftWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 8,
        marginLeft: 30,
        marginRight: 8,
        minHeight: 44,
        paddingHorizontal: 10,
    },
    newSessionText: { color: theme.colors.textSecondary, flex: 1, fontSize: 12, ...Typography.default('semiBold') },
    tagSection: { marginTop: 10 },
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10 },
    tag: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 5,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 28,
        },
        paddingHorizontal: 9,
    },
    tagSelected: { backgroundColor: theme.colors.surfaceSelected },
    tagText: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default('semiBold') },
    tagDot: { borderRadius: 3, height: 6, width: 6 },
    empty: { color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 16, paddingVertical: 12, ...Typography.default() },
    filteredHeader: { alignItems: 'center', flexDirection: 'row', paddingHorizontal: 10, paddingBottom: 6 },
    filteredTitle: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    libraryShell: { flex: 1, flexDirection: 'row', minHeight: 0, position: 'relative' },
    libraryShellMobile: { flexDirection: 'column' },
    organizationPane: {
        borderRightColor: theme.colors.divider,
        borderRightWidth: StyleSheet.hairlineWidth,
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0,
    },
    organizationPaneMobile: { borderRightWidth: 0, flex: 1, width: '100%' },
    organizationContent: { paddingBottom: 24, paddingTop: 8 },
    organizationSectionHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        minHeight: 34,
        paddingLeft: 10,
        paddingRight: 6,
    },
    organizationSectionTitle: { color: theme.colors.groupped.sectionTitle, flex: 1, fontSize: 12, ...Typography.default('semiBold') },
    organizationRow: {
        alignItems: 'center',
        borderRadius: 8,
        flexDirection: 'row',
        gap: 8,
        marginHorizontal: 6,
        minHeight: {
            [mq.only.width(0, 768)]: 48,
            [mq.only.width(768)]: 38,
        },
        paddingHorizontal: 8,
    },
    organizationRowNested: { marginLeft: 20 },
    organizationRowSelected: { backgroundColor: theme.colors.surfaceSelected },
    organizationRowPressed: { backgroundColor: theme.colors.surfacePressed },
    organizationRowText: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    organizationRowMeta: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    organizationCount: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    organizationColorDot: { borderRadius: 4, height: 8, width: 8 },
    organizationDivider: { backgroundColor: theme.colors.divider, height: StyleSheet.hairlineWidth, marginHorizontal: 10, marginVertical: 6 },
    folderRow: { position: 'relative' },
    sessionPane: { flex: 1, minHeight: 0, minWidth: 0 },
    organizationResizeHandle: {
        alignItems: 'center',
        bottom: 0,
        justifyContent: 'center',
        position: 'absolute',
        top: 0,
        width: 10,
        zIndex: 24,
    },
    organizationResizeLine: {
        height: '100%',
        width: 1,
    },
    sessionPaneHeader: {
        alignItems: 'center',
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 6,
        minHeight: 54,
        paddingHorizontal: 10,
    },
    sessionPaneTitleWrap: { flex: 1, minWidth: 0 },
    sessionPaneTitle: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') },
    sessionPaneSubtitle: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2, ...Typography.default() },
    sessionListContent: { paddingBottom: 24, paddingTop: 6 },
    timeSection: { color: theme.colors.groupped.sectionTitle, fontSize: 11, paddingHorizontal: 12, paddingBottom: 4, paddingTop: 9, ...Typography.default('semiBold') },
    tagHeaderLabel: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7 },
    tagMenu: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        position: 'absolute',
        right: 8,
        top: 34,
        width: 190,
        zIndex: 30,
    },
    tagMenuMobileScrim: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0, zIndex: 40 },
    tagMenuMobileBackdrop: { backgroundColor: theme.colors.shadow.color, bottom: 0, left: 0, opacity: 0.24, position: 'absolute', right: 0, top: 0 },
    tagMenuMobile: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, bottom: 0, left: 0, right: 0, top: undefined, width: '100%' },
    tagMenuTitle: { color: theme.colors.text, fontSize: 13, paddingHorizontal: 14, paddingBottom: 6, paddingTop: 12, ...Typography.default('semiBold') },
    tagMenuOption: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 44, paddingHorizontal: 14 },
    tagMenuOptionSelected: { backgroundColor: theme.colors.surfaceSelected },
    tagMenuOptionText: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default() },
    tagMenuOptionTextSelected: { color: theme.colors.textLink, ...Typography.default('semiBold') },
    modalRoot: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 20 },
    modalBackdrop: { backgroundColor: theme.colors.shadow.color, bottom: 0, left: 0, opacity: 0.28, position: 'absolute', right: 0, top: 0 },
    dialog: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        maxHeight: '86%',
        maxWidth: 520,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 24,
        width: '100%',
    },
    dialogHeader: { alignItems: 'center', borderBottomColor: theme.colors.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54, paddingHorizontal: 16 },
    dialogTitle: { color: theme.colors.text, flex: 1, fontSize: 17, ...Typography.default('semiBold') },
    dialogBody: { padding: 16 },
    field: { gap: 7, marginBottom: 16 },
    fieldLabel: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') },
    input: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.divider,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        color: theme.colors.text,
        fontSize: 14,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 40,
        },
        paddingHorizontal: 11,
        paddingVertical: 8,
    },
    multilineInput: { minHeight: 88, textAlignVertical: 'top' },
    segmented: { backgroundColor: theme.colors.surfaceHigh, borderRadius: 7, flexDirection: 'row', padding: 2 },
    segment: {
        alignItems: 'center',
        borderRadius: 5,
        flex: 1,
        justifyContent: 'center',
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 34,
        },
        paddingHorizontal: 8,
    },
    segmentSelected: { backgroundColor: theme.colors.surface },
    segmentText: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') },
    segmentTextSelected: { color: theme.colors.text },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    choice: {
        alignItems: 'center',
        borderColor: theme.colors.divider,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 6,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 34,
        },
        paddingHorizontal: 10,
    },
    choiceSelected: { backgroundColor: theme.colors.surfaceSelected },
    choiceText: { color: theme.colors.text, fontSize: 12, ...Typography.default() },
    dialogFooter: { borderTopColor: theme.colors.divider, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, justifyContent: 'flex-end', padding: 12 },
    button: {
        alignItems: 'center',
        borderRadius: 7,
        justifyContent: 'center',
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 36,
        },
        minWidth: 76,
        paddingHorizontal: 14,
    },
    secondaryButton: { backgroundColor: theme.colors.surfaceHigh },
    destructiveButton: { marginRight: 'auto' },
    destructiveButtonText: { color: theme.colors.deleteAction, fontSize: 13, ...Typography.default('semiBold') },
    primaryButton: { backgroundColor: theme.colors.button.primary.background },
    buttonDisabled: { opacity: 0.45 },
    secondaryButtonText: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    primaryButtonText: { color: theme.colors.button.primary.tint, fontSize: 13, ...Typography.default('semiBold') },
    colorChoice: {
        alignItems: 'center',
        height: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 28,
        },
        justifyContent: 'center',
        width: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 28,
        },
    },
    colorSwatch: { borderRadius: 10, height: 20, width: 20 },
    colorChoiceSelected: { borderColor: theme.colors.text, borderWidth: 2 },
    assignmentRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 9,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 40,
        },
    },
    check: { alignItems: 'center', borderColor: theme.colors.divider, borderRadius: 5, borderWidth: 1, height: 20, justifyContent: 'center', width: 20 },
    checkSelected: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    assignmentLabel: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default() },
}));

export const DesktopSidebarSessionsNavigation = React.memo(function DesktopSidebarSessionsNavigation({
    desktopDensity,
}: {
    desktopDensity?: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const isDesktop = desktopDensity ?? isTablet;
    const pathname = usePathname();
    const router = useRouter();
    const data = useVisibleSessionListViewData();
    const machines = useAllMachines({ includeOffline: true });
    const organization = useSetting('sidebarOrganization');
    const updateOrganization = useSettingUpdater('sidebarOrganization');
    const [tagVisibility, setTagVisibility] = useLocalSettingMutable('sidebarTagsVisibility');
    const [organizationCollapsed, setOrganizationCollapsed] = useLocalSettingMutable('desktopSidebarOrganizationCollapsed');
    const [storedOrganizationWidth, setStoredOrganizationWidth] = useLocalSettingMutable('desktopSidebarOrganizationWidth');
    const [navigationWidth, setNavigationWidth] = React.useState<number | undefined>();
    const [liveOrganizationWidth, setLiveOrganizationWidth] = React.useState(() => (
        clampDesktopSidebarOrganizationWidth(storedOrganizationWidth)
    ));
    const [resizingOrganization, setResizingOrganization] = React.useState(false);
    const organizationResizeRef = React.useRef<{ startPointerX: number; startWidth: number } | null>(null);
    const liveOrganizationWidthRef = React.useRef(liveOrganizationWidth);
    const sessions = React.useMemo(() => collectSidebarSessions(data), [data]);
    const sessionManagement = useSessionManagementPreferences(sessions.map((session) => session.id), { prune: false });
    const projects = React.useMemo(() => buildSidebarLibraryProjects({
        machines,
        pinnedOrder: sessionManagement.preferences.pinnedOrder,
        sessions,
        unknownLabel: t('common.unknown'),
    }), [machines, sessionManagement.preferences.pinnedOrder, sessions]);
    const folderGroups = React.useMemo(() => buildSidebarLibraryFolderGroups(organization), [organization]);
    const [selection, setSelection] = React.useState<SidebarLibrarySelection>({ kind: 'timeline' });
    const [mobileStage, setMobileStage] = React.useState<'organization' | 'sessions'>('organization');
    const [expandedSections, setExpandedSections] = React.useState(() => new Set(['projects', 'lists', 'tags']));
    const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => new Set());
    const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
    const [editorVisible, setEditorVisible] = React.useState(false);
    const [editingList, setEditingList] = React.useState<SidebarList | null>(null);
    const [organizingSession, setOrganizingSession] = React.useState<SessionRowData | null>(null);
    const [draggedSessionId, setDraggedSessionId] = React.useState<string | null>(null);
    const [draggedListId, setDraggedListId] = React.useState<string | null>(null);
    const [dropFeedback, setDropFeedback] = React.useState<{
        entity: SidebarDragData['entity'];
        listId: string;
        position: SidebarDropPosition | null;
    } | null>(null);
    const selectedSessionId = pathname.startsWith('/session/') ? pathname.split('/')[2] : null;
    const listColors = getListColors(theme.colors);

    React.useEffect(() => {
        liveOrganizationWidthRef.current = liveOrganizationWidth;
    }, [liveOrganizationWidth]);
    React.useEffect(() => {
        if (!organizationResizeRef.current) {
            const nextWidth = clampDesktopSidebarOrganizationWidth(storedOrganizationWidth, navigationWidth);
            liveOrganizationWidthRef.current = nextWidth;
            setLiveOrganizationWidth(nextWidth);
        }
    }, [navigationWidth, storedOrganizationWidth]);

    const organizationMaxWidth = getDesktopSidebarOrganizationMaxWidth(navigationWidth);
    const handleNavigationLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.round(event.nativeEvent.layout.width);
        setNavigationWidth((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    }, []);

    const resizeOrganizationBy = React.useCallback((delta: number) => {
        const nextWidth = clampDesktopSidebarOrganizationWidth(
            liveOrganizationWidthRef.current + delta,
            navigationWidth,
        );
        liveOrganizationWidthRef.current = nextWidth;
        setLiveOrganizationWidth(nextWidth);
        setStoredOrganizationWidth(nextWidth);
    }, [navigationWidth, setStoredOrganizationWidth]);
    const beginOrganizationResize = React.useCallback((event: GestureResponderEvent) => {
        organizationResizeRef.current = {
            startPointerX: event.nativeEvent.pageX,
            startWidth: liveOrganizationWidthRef.current,
        };
        setResizingOrganization(true);
    }, []);
    const continueOrganizationResize = React.useCallback((event: GestureResponderEvent) => {
        const resize = organizationResizeRef.current;
        if (!resize) return;
        const nextWidth = clampDesktopSidebarOrganizationWidth(
            resize.startWidth + event.nativeEvent.pageX - resize.startPointerX,
            navigationWidth,
        );
        liveOrganizationWidthRef.current = nextWidth;
        setLiveOrganizationWidth(nextWidth);
    }, [navigationWidth]);
    const endOrganizationResize = React.useCallback(() => {
        if (!organizationResizeRef.current) return;
        organizationResizeRef.current = null;
        setResizingOrganization(false);
        setStoredOrganizationWidth(liveOrganizationWidthRef.current);
    }, [setStoredOrganizationWidth]);
    const handleOrganizationResizeKeyDown = React.useCallback((event: any) => {
        const key = event.nativeEvent?.key ?? event.key;
        let delta: number | undefined;
        if (key === 'ArrowLeft') delta = -16;
        if (key === 'ArrowRight') delta = 16;
        if (key === 'Home') delta = DESKTOP_SIDEBAR_ORGANIZATION_MIN_WIDTH - liveOrganizationWidthRef.current;
        if (key === 'End') delta = organizationMaxWidth - liveOrganizationWidthRef.current;
        if (delta === undefined) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        resizeOrganizationBy(delta);
    }, [organizationMaxWidth, resizeOrganizationBy]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !resizingOrganization || typeof document === 'undefined') return;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };
    }, [resizingOrganization]);

    React.useEffect(() => {
        setExpandedFolders((current) => {
            if (current.size > 0 || (organization.folders?.length ?? 0) === 0) return current;
            return new Set(organization.folders?.map((folder) => folder.id));
        });
    }, [organization.folders]);

    const chooseSelection = React.useCallback((next: SidebarLibrarySelection) => {
        setSelection(next);
        if (!isDesktop) setMobileStage('sessions');
    }, [isDesktop]);
    const toggleSection = React.useCallback((section: string) => {
        setExpandedSections((current) => {
            const next = new Set(current);
            next.has(section) ? next.delete(section) : next.add(section);
            return next;
        });
    }, []);
    const toggleFolder = React.useCallback((folderId: string) => {
        setExpandedFolders((current) => {
            const next = new Set(current);
            next.has(folderId) ? next.delete(folderId) : next.add(folderId);
            return next;
        });
    }, []);
    const startSessionDrag = React.useCallback((data: SidebarDragData) => setDraggedSessionId(data.id), []);
    const startListDrag = React.useCallback((data: SidebarDragData) => setDraggedListId(data.id), []);
    const finishSidebarDrag = React.useCallback(() => {
        setDraggedSessionId(null);
        setDraggedListId(null);
        setDropFeedback(null);
    }, []);
    const changeDropTarget = React.useCallback((listId: string, data: SidebarDragData, position: SidebarDropPosition | null) => {
        setDropFeedback({ entity: data.entity, listId, position });
    }, []);
    const leaveDropTarget = React.useCallback((listId: string) => {
        setDropFeedback((current) => current?.listId === listId ? null : current);
    }, []);
    const dropOntoList = React.useCallback((listId: string, data: SidebarDragData, position: SidebarDropPosition | null) => {
        if (data.entity === 'list') {
            if (position) updateOrganization((current) => reorderSidebarList(current, data.id, listId, position));
            finishSidebarDrag();
            return;
        }
        updateOrganization((current) => moveSidebarSessionToList(current, data.id, listId === 'unassigned' ? null : listId));
        finishSidebarDrag();
    }, [finishSidebarDrag, updateOrganization]);
    const addTag = React.useCallback(async () => {
        if (organization.tags.length >= SIDEBAR_TAG_MAX_COUNT) return;
        const name = normalizeSidebarTagName((await Modal.prompt(t('sidebarLists.newTag'), undefined, {
            placeholder: t('sidebarLists.tagNamePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('common.create'),
        })) ?? '');
        if (!name) return;
        updateOrganization((current) => ({
            ...current,
            tags: current.tags.some((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())
                ? current.tags
                : [...current.tags, {
                    id: createSidebarOrganizationId('tag'),
                    name,
                    color: SIDEBAR_LIST_COLORS[current.tags.length % SIDEBAR_LIST_COLORS.length],
                    createdAt: Date.now(),
                }],
        }));
    }, [organization.tags.length, updateOrganization]);
    const addFolder = React.useCallback(async () => {
        if ((organization.folders?.length ?? 0) >= SIDEBAR_FOLDER_MAX_COUNT) return;
        const name = (await Modal.prompt(t('sidebarLists.newFolder'), undefined, {
            placeholder: t('sidebarLists.folderNamePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('common.create'),
        }))?.trim().slice(0, SIDEBAR_LIST_NAME_MAX_LENGTH);
        if (!name) return;
        const folderId = createSidebarOrganizationId('folder');
        updateOrganization((current) => ({
            ...current,
            folders: [...(current.folders ?? []), { id: folderId, name, createdAt: Date.now() }],
        }));
        setExpandedFolders((current) => new Set(current).add(folderId));
    }, [organization.folders?.length, updateOrganization]);
    const openCreate = React.useCallback(() => {
        setEditingList(null);
        setEditorVisible(true);
    }, []);
    const openEdit = React.useCallback((list: SidebarList) => {
        setEditingList(list);
        setEditorVisible(true);
    }, []);
    const createSession = React.useCallback((list: SidebarList) => {
        const draft = useNewSessionDraft.getState();
        if (list.kind === 'workspace') {
            if (list.machineId) draft.setMachineId(list.machineId);
            if (list.path) draft.setPath(list.path);
            if (list.defaultAgent) draft.setAgentType(list.defaultAgent);
        } else {
            draft.setAgentType('ask');
            draft.setInput('');
        }
        router.navigate({ pathname: '/new', params: { sidebarListId: list.id } });
    }, [router]);
    const filteredSessions = React.useMemo(() => getSidebarLibrarySessions({
        organization,
        pinnedOrder: sessionManagement.preferences.pinnedOrder,
        projects,
        selection,
        sessions,
    }), [organization, projects, selection, sessionManagement.preferences.pinnedOrder, sessions]);
    const visibleSessionPartitions = React.useMemo(
        () => partitionSessionsByPinnedOrder(sessions, sessionManagement.preferences.pinnedOrder),
        [sessionManagement.preferences.pinnedOrder, sessions],
    );
    const selectionList = selection.kind === 'list'
        ? organization.lists.find((list) => list.id === selection.id) ?? null
        : null;
    const selectionTitle = selection.kind === 'timeline'
        ? t('sidebar.timelineTab')
        : selection.kind === 'pinned'
            ? t('sessionSearch.sections.pinned')
            : selection.kind === 'project'
                ? projects.find((project) => project.key === selection.key)?.displayPath ?? t('sidebar.projectsTab')
                : selection.kind === 'list'
                    ? selectionList?.name ?? t('sidebarLists.lists')
                    : selection.kind === 'tag'
                        ? `#${organization.tags.find((tag) => tag.id === selection.id)?.name ?? t('sidebarLists.tags')}`
                        : t('sidebarLists.unassigned');
    const selectionSubtitle = selection.kind === 'project'
        ? projects.find((project) => project.key === selection.key)?.machineName
        : selection.kind === 'unassigned'
            ? t('sidebarLists.unassignedDescription')
            : undefined;
    const timeGroups = React.useMemo(
        () => selection.kind === 'timeline' ? buildSessionNavigationTimeGroups(filteredSessions) : [],
        [filteredSessions, selection.kind],
    );
    const sessionRows = React.useMemo(() => selection.kind === 'timeline'
        ? timeGroups.flatMap((group) => [
            { key: `time-${group.key}`, type: 'time' as const, label: group.dayOffset === 0 ? t('sessionHistory.today') : t('sessionSearch.sections.recent') },
            ...group.sessions.map((session) => ({ key: session.id, type: 'session' as const, session })),
        ])
        : filteredSessions.map((session) => ({ key: session.id, type: 'session' as const, session })), [filteredSessions, selection.kind, timeGroups]);
    const showTagRows = expandedSections.has('tags')
        && tagVisibility !== 'hidden'
        && (tagVisibility === 'always' || organization.tags.length > 0);

    const renderOrganizationRow = React.useCallback(({
        count,
        icon,
        nested = false,
        onPress,
        selected,
        subtitle,
        testID,
        title,
    }: {
        count?: number;
        icon: React.ReactNode;
        nested?: boolean;
        onPress: () => void;
        selected: boolean;
        subtitle?: string;
        testID: string;
        title: string;
    }) => (
        <Pressable
            aria-selected={selected}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={onPress}
            style={({ pressed }) => [styles.organizationRow, nested && styles.organizationRowNested, selected && styles.organizationRowSelected, pressed && styles.organizationRowPressed]}
            testID={testID}
        >
            {icon}
            <View style={styles.listCopy}>
                <Text numberOfLines={1} style={styles.organizationRowText}>{title}</Text>
                {subtitle ? <Text numberOfLines={1} style={styles.organizationRowMeta}>{subtitle}</Text> : null}
            </View>
            {count !== undefined ? <Text style={styles.organizationCount}>{count}</Text> : null}
        </Pressable>
    ), [styles]);

    const organizationPane = (
        <ScrollView contentContainerStyle={styles.organizationContent} style={styles.listsScroll} testID="sidebar-organization-pane">
            {renderOrganizationRow({
                count: visibleSessionPartitions.regular.length,
                icon: <Feather color={theme.colors.textSecondary} name="clock" size={16} />,
                onPress: () => chooseSelection({ kind: 'timeline' }),
                selected: selection.kind === 'timeline',
                testID: 'sidebar-organization-timeline',
                title: t('sidebar.timelineTab'),
            })}
            {renderOrganizationRow({
                count: visibleSessionPartitions.pinned.length,
                icon: <Feather color={theme.colors.textSecondary} name="bookmark" size={16} />,
                onPress: () => chooseSelection({ kind: 'pinned' }),
                selected: selection.kind === 'pinned',
                testID: 'sidebar-organization-pinned',
                title: t('sessionSearch.sections.pinned'),
            })}
            <View style={styles.organizationDivider} />
            <View style={styles.organizationSectionHeader}>
                <Pressable accessibilityRole="button" onPress={() => toggleSection('projects')} style={styles.tagHeaderLabel} testID="sidebar-projects-toggle">
                    <Feather color={theme.colors.textSecondary} name={expandedSections.has('projects') ? 'chevron-down' : 'chevron-right'} size={14} />
                    <Text style={styles.organizationSectionTitle}>{t('sidebar.projectsTab')}</Text>
                </Pressable>
            </View>
            {expandedSections.has('projects') ? projects.map((project) => {
                const current = selection.kind === 'project' && selection.key === project.key;
                const selectedSession = selectedSessionId ? project.sessions.find((session) => session.id === selectedSessionId) : null;
                const activitySession = selectedSession ?? project.sessions.find((session) => session.state === 'permission_required' || session.state === 'running' || session.hasUnread);
                const baseStatus = activitySession ? STATUS_CONFIG[activitySession.state] : null;
                const activity = activitySession && baseStatus ? {
                    color: activitySession.hasUnread && activitySession.state === 'idle' ? theme.colors.accent : baseStatus.dotColor,
                    isPulsing: activitySession.hasUnread ? false : baseStatus.isPulsing,
                    label: `${getSessionStateLabel(activitySession.state)}${activitySession.isConnected ? '' : ` · ${t('status.disconnected')}`}`,
                    textColor: baseStatus.color,
                } : null;
                return (
                    <ProjectSectionHeader
                        activity={activity}
                        current={current}
                        displayPath={project.displayPath}
                        expanded={current}
                        key={project.key}
                        machineId={project.machineId}
                        onCreateSession={() => router.navigate('/new')}
                        onToggle={() => chooseSelection({ kind: 'project', key: project.key, machineId: project.machineId, path: project.path })}
                        path={project.path}
                        session={project.sessions[0]!}
                        testID={`sidebar-project-toggle-${project.key}`}
                    />
                );
            }) : null}
            <View style={styles.organizationSectionHeader}>
                <Pressable accessibilityRole="button" onPress={() => toggleSection('lists')} style={styles.tagHeaderLabel} testID="sidebar-lists-toggle">
                    <Feather color={theme.colors.textSecondary} name={expandedSections.has('lists') ? 'chevron-down' : 'chevron-right'} size={14} />
                    <Text style={styles.organizationSectionTitle}>{t('sidebarLists.lists')}</Text>
                </Pressable>
                <Pressable accessibilityLabel={t('sidebarLists.newFolder')} accessibilityRole="button" onPress={() => void addFolder()} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-create-folder-button">
                    <Feather color={theme.colors.textSecondary} name="folder-plus" size={15} />
                </Pressable>
                <Pressable accessibilityLabel={t('sidebarLists.newList')} accessibilityRole="button" onPress={openCreate} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-create-list-button">
                    <Feather color={theme.colors.textSecondary} name="plus" size={17} />
                </Pressable>
            </View>
            {expandedSections.has('lists') ? folderGroups.flatMap((group) => {
                const folderExpanded = group.folderId ? expandedFolders.has(group.folderId) : true;
                return [
                    group.folderId ? (
                        <Pressable accessibilityRole="button" accessibilityState={{ expanded: folderExpanded }} key={`folder-${group.folderId}`} onPress={() => toggleFolder(group.folderId!)} style={({ pressed }) => [styles.organizationRow, pressed && styles.organizationRowPressed]} testID={`sidebar-folder-${group.folderId}`}>
                            <Feather color={theme.colors.textSecondary} name={folderExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                            <Feather color={theme.colors.textSecondary} name="folder" size={17} />
                            <Text numberOfLines={1} style={styles.organizationRowText}>{group.name}</Text>
                            <Text style={styles.organizationCount}>{group.lists.length}</Text>
                        </Pressable>
                    ) : null,
                    ...(folderExpanded ? group.lists.map((list) => (
                        <WebDropTarget
                            active={dropFeedback?.entity === 'session' && dropFeedback.listId === list.id}
                            draggableEntity="list"
                            draggableId={list.id}
                            dropPosition={dropFeedback?.entity === 'list' && dropFeedback.listId === list.id ? dropFeedback.position : null}
                            key={list.id}
                            onDragEnd={finishSidebarDrag}
                            onDragStart={startListDrag}
                            onDrop={dropOntoList}
                            onTargetChange={changeDropTarget}
                            onTargetLeave={leaveDropTarget}
                            style={[styles.listBlock, styles.folderRow, draggedListId === list.id && styles.sessionRowDragging]}
                            targetId={list.id}
                            testID={`sidebar-drop-list-${list.id}`}
                        >
                            {renderOrganizationRow({
                                count: visibleSessionPartitions.regular.filter((session) => organization.sessions[session.id]?.listId === list.id).length,
                                icon: <View style={[styles.organizationColorDot, { backgroundColor: listColors[list.color] }]} />,
                                nested: !!group.folderId,
                                onPress: () => chooseSelection({ kind: 'list', id: list.id }),
                                selected: selection.kind === 'list' && selection.id === list.id,
                                testID: `sidebar-list-${list.id}`,
                                title: list.name,
                            })}
                            <Pressable accessibilityLabel={`${t('sidebarLists.editList')} ${list.name}`} accessibilityRole="button" onPress={() => openEdit(list)} style={({ pressed }) => [styles.iconButton, { position: 'absolute', right: 4, top: 5 }, pressed && styles.iconButtonPressed]} testID={`sidebar-edit-list-${list.id}`}>
                                <Feather color={theme.colors.textSecondary} name="more-horizontal" size={14} />
                            </Pressable>
                        </WebDropTarget>
                    )) : []),
                ];
            }) : null}
            {expandedSections.has('lists') ? (
                <WebDropTarget
                    active={dropFeedback?.entity === 'session' && dropFeedback.listId === 'unassigned'}
                    dropPosition={null}
                    onDrop={dropOntoList}
                    onTargetChange={changeDropTarget}
                    onTargetLeave={leaveDropTarget}
                    targetId="unassigned"
                    testID="sidebar-drop-list-unassigned"
                >
                    {renderOrganizationRow({
                        count: visibleSessionPartitions.regular.filter((session) => !organization.sessions[session.id]?.listId).length,
                        icon: <Feather color={theme.colors.textSecondary} name="inbox" size={16} />,
                        onPress: () => chooseSelection({ kind: 'unassigned' }),
                        selected: selection.kind === 'unassigned',
                        subtitle: t('sidebarLists.unassignedDescription'),
                        testID: 'sidebar-list-unassigned',
                        title: t('sidebarLists.unassigned'),
                    })}
                </WebDropTarget>
            ) : null}
            <View style={[styles.organizationSectionHeader, { zIndex: 31 }]}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedSections.has('tags') }} onPress={() => toggleSection('tags')} style={styles.tagHeaderLabel} testID="sidebar-tags-toggle">
                    <Feather color={theme.colors.textSecondary} name={expandedSections.has('tags') ? 'chevron-down' : 'chevron-right'} size={14} />
                    <Feather color={theme.colors.textSecondary} name="tag" size={15} />
                    <Text style={styles.organizationSectionTitle}>{t('sidebarLists.tags')}</Text>
                </Pressable>
                <Pressable accessibilityLabel={t('sidebarLists.tagVisibility')} accessibilityRole="button" onPress={() => setTagMenuOpen((open) => !open)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-tags-visibility-button">
                    <Feather color={theme.colors.textSecondary} name="more-horizontal" size={16} />
                </Pressable>
                <Pressable accessibilityLabel={t('sidebarLists.newTag')} accessibilityRole="button" onPress={() => void addTag()} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-create-tag-button">
                    <Feather color={theme.colors.textSecondary} name="plus" size={17} />
                </Pressable>
                {tagMenuOpen && isDesktop ? <TagVisibilityMenu onChange={(value) => { setTagVisibility(value); setTagMenuOpen(false); }} value={tagVisibility} /> : null}
            </View>
            {showTagRows ? organization.tags.map((tag) => (
                <React.Fragment key={tag.id}>
                    {renderOrganizationRow({
                        count: visibleSessionPartitions.regular.filter((session) => organization.sessions[session.id]?.tagIds.includes(tag.id)).length,
                        icon: <View style={[styles.organizationColorDot, { backgroundColor: listColors[tag.color] }]} />,
                        onPress: () => chooseSelection({ kind: 'tag', id: tag.id }),
                        selected: selection.kind === 'tag' && selection.id === tag.id,
                        testID: `sidebar-tag-${tag.id}`,
                        title: tag.name,
                    })}
                </React.Fragment>
            )) : null}
        </ScrollView>
    );

    const sessionPane = (
        <View style={styles.sessionPane} testID="sidebar-session-pane">
            <View style={styles.sessionPaneHeader}>
                {!isDesktop ? (
                    <Pressable accessibilityLabel={t('common.back')} accessibilityRole="button" onPress={() => setMobileStage('organization')} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-session-pane-back">
                        <Feather color={theme.colors.textSecondary} name="chevron-left" size={20} />
                    </Pressable>
                ) : null}
                {isDesktop ? (
                    <Pressable
                        aria-expanded={!organizationCollapsed}
                        accessibilityLabel={organizationCollapsed ? t('sidebarLists.showNavigation') : t('sidebarLists.hideNavigation')}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: !organizationCollapsed }}
                        onPress={() => setOrganizationCollapsed(!organizationCollapsed)}
                        style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
                        testID="sidebar-organization-collapse-button"
                    >
                        <Feather color={theme.colors.textSecondary} name="sidebar" size={17} />
                    </Pressable>
                ) : null}
                <View style={styles.sessionPaneTitleWrap}>
                    <Text numberOfLines={1} style={styles.sessionPaneTitle} testID="sidebar-session-pane-title">{selectionTitle}</Text>
                    <Text numberOfLines={1} style={styles.sessionPaneSubtitle}>{selectionSubtitle ?? t('sidebarLists.sessionCount', { count: filteredSessions.length })}</Text>
                </View>
                {selectionList ? (
                    <Pressable accessibilityLabel={t('sidebarLists.newSessionInList')} accessibilityRole="button" onPress={() => createSession(selectionList)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID={`sidebar-new-session-${selectionList.id}`}>
                        <Feather color={theme.colors.textSecondary} name="plus" size={18} />
                    </Pressable>
                ) : null}
            </View>
            <FlatList
                contentContainerStyle={styles.sessionListContent}
                data={sessionRows}
                initialNumToRender={18}
                keyExtractor={(item) => item.key}
                maxToRenderPerBatch={12}
                renderItem={({ item }) => item.type === 'time'
                    ? <Text style={styles.timeSection}>{item.label}</Text>
                    : <OrganizedSessionRow dragging={draggedSessionId === item.session.id} onDragEnd={finishSidebarDrag} onDragStart={startSessionDrag} onOrganize={setOrganizingSession} selected={selectedSessionId === item.session.id} session={item.session} />}
                ListEmptyComponent={<Text style={styles.empty}>{t('sessionSearch.empty')}</Text>}
                removeClippedSubviews={Platform.OS !== 'web'}
                style={styles.listsScroll}
                windowSize={7}
            />
        </View>
    );

    return (
        <View onLayout={isDesktop ? handleNavigationLayout : undefined} style={[styles.libraryShell, !isDesktop && styles.libraryShellMobile]} testID="desktop-sidebar-session-navigation">
            {((isDesktop && !organizationCollapsed) || (!isDesktop && mobileStage === 'organization')) ? (
                <View
                    style={[
                        styles.organizationPane,
                        !isDesktop && styles.organizationPaneMobile,
                        isDesktop && { width: liveOrganizationWidth },
                    ]}
                >
                    {organizationPane}
                </View>
            ) : null}
            {isDesktop && !organizationCollapsed ? (
                <View
                    accessibilityLabel={t('sidebarLists.resizeNavigation')}
                    accessibilityRole="adjustable"
                    accessibilityValue={{
                        min: DESKTOP_SIDEBAR_ORGANIZATION_MIN_WIDTH,
                        max: organizationMaxWidth,
                        now: liveOrganizationWidth,
                        text: `${liveOrganizationWidth} px`,
                    }}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={beginOrganizationResize}
                    onResponderMove={continueOrganizationResize}
                    onResponderRelease={endOrganizationResize}
                    onResponderTerminate={endOrganizationResize}
                    onStartShouldSetResponder={() => true}
                    {...(Platform.OS === 'web' ? ({
                        'aria-orientation': 'vertical',
                        'aria-valuemax': organizationMaxWidth,
                        'aria-valuemin': DESKTOP_SIDEBAR_ORGANIZATION_MIN_WIDTH,
                        'aria-valuenow': liveOrganizationWidth,
                        'aria-valuetext': `${liveOrganizationWidth} px`,
                        onKeyDown: handleOrganizationResizeKeyDown,
                        tabIndex: 0,
                    } as any) : {})}
                    style={[
                        styles.organizationResizeHandle,
                        { left: liveOrganizationWidth - 5 },
                        Platform.OS === 'web' && ({ cursor: 'col-resize', outlineStyle: 'none', touchAction: 'none' } as any),
                    ]}
                    testID="sidebar-organization-resize-handle"
                >
                    <View style={[
                        styles.organizationResizeLine,
                        { backgroundColor: resizingOrganization ? theme.colors.textLink : theme.colors.divider },
                    ]} />
                </View>
            ) : null}
            {(isDesktop || mobileStage === 'sessions') ? sessionPane : null}
            {tagMenuOpen && !isDesktop ? (
                <View accessibilityViewIsModal style={styles.tagMenuMobileScrim} testID="sidebar-tags-visibility-sheet">
                    <Pressable accessibilityLabel={t('sidebarLists.close')} onPress={() => setTagMenuOpen(false)} style={styles.tagMenuMobileBackdrop} />
                    <TagVisibilityMenu mobile onChange={(value) => { setTagVisibility(value); setTagMenuOpen(false); }} value={tagVisibility} />
                </View>
            ) : null}
            <ListEditorDialog
                list={editingList}
                onClose={() => setEditorVisible(false)}
                onDelete={(listId) => updateOrganization((current) => removeSidebarList(current, listId))}
                onSave={(list) => updateOrganization((current) => ({
                    ...current,
                    lists: editingList ? current.lists.map((item) => item.id === list.id ? list : item) : [...current.lists, list],
                }))}
                organization={organization}
                sessions={sessions}
                visible={editorVisible}
            />
            {organizingSession ? (
                <SessionOrganizerDialog
                    assignment={organization.sessions[organizingSession.id] ?? { listId: null, tagIds: [] }}
                    onClose={() => setOrganizingSession(null)}
                    onSave={(assignment, createdTags) => updateOrganization((current) => organizeSessionWithCreatedTags(current, organizingSession.id, assignment, createdTags))}
                    organization={organization}
                    sessionName={organizingSession.name}
                    visible
                />
            ) : null}
        </View>
    );
});

function TagVisibilityMenu({ mobile = false, onChange, value }: {
    mobile?: boolean;
    onChange: (value: 'always' | 'when-populated' | 'hidden') => void;
    value: 'always' | 'when-populated' | 'hidden';
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View accessibilityLabel={t('sidebarLists.tagVisibility')} accessibilityRole="radiogroup" style={[styles.tagMenu, mobile && styles.tagMenuMobile]} testID={mobile ? 'sidebar-tags-visibility-sheet-menu' : 'sidebar-tags-visibility-menu'}>
            <Text style={styles.tagMenuTitle}>{t('sidebarLists.tagVisibility')}</Text>
            {(['always', 'when-populated', 'hidden'] as const).map((option) => {
                const selected = value === option;
                return (
                    <Pressable aria-checked={selected} accessibilityRole="radio" accessibilityState={{ checked: selected }} key={option} onPress={() => onChange(option)} style={[styles.tagMenuOption, selected && styles.tagMenuOptionSelected]} testID={`sidebar-tags-visibility-${option}`}>
                        <Text style={[styles.tagMenuOptionText, selected && styles.tagMenuOptionTextSelected]}>{t(`sidebarLists.tagVisibilityOptions.${option}` as const)}</Text>
                        {selected ? <Feather color={theme.colors.textLink} name="check" size={17} /> : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

type SidebarVirtualRow =
    | { key: string; type: 'section'; section: 'lists' | 'pinned' | 'tags' }
    | { key: string; type: 'pinned-session'; session: SessionRowData }
    | { key: string; type: 'list'; list: SidebarList }
    | { key: string; type: 'unassigned' }
    | { key: string; type: 'new-session'; list: SidebarList }
    | { key: string; type: 'session'; session: SessionRowData; nested: boolean }
    | { key: string; type: 'empty'; label: string; nested: boolean }
    | { key: string; type: 'filtered-header'; tagName: string }
    | { key: string; type: 'tags' };

function WebDropTarget({ active, children, draggableEntity, draggableId, dropPosition, onDragEnd, onDragStart, onDrop, onTargetChange, onTargetLeave, style, targetId, testID }: {
    active: boolean;
    children: React.ReactNode;
    draggableEntity?: SidebarDragData['entity'];
    draggableId?: string;
    dropPosition: SidebarDropPosition | null;
    onDragEnd?: () => void;
    onDragStart?: (data: SidebarDragData) => void;
    onDrop: (targetId: string, data: SidebarDragData, position: SidebarDropPosition | null) => void;
    onTargetChange: (targetId: string, data: SidebarDragData, position: SidebarDropPosition | null) => void;
    onTargetLeave: (targetId: string) => void;
    style?: React.ComponentProps<typeof View>['style'];
    targetId: string;
    testID: string;
}) {
    const ref = React.useRef<View>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = ref.current as unknown as HTMLElement | null;
        if (!element) return;
        const cleanups = [registerSidebarDropTarget({
            element,
            onDrop: (data, position) => onDrop(targetId, data, position),
            onTargetChange: (data, position) => onTargetChange(targetId, data, position),
            onTargetLeave: () => onTargetLeave(targetId),
            targetId,
        })];
        if (draggableEntity && draggableId) {
            cleanups.push(registerSidebarDraggable({
                data: { entity: draggableEntity, id: draggableId, type: 'paws-sidebar-drag' },
                element,
                onDragStart: (data) => onDragStart?.(data),
                onDrop: () => onDragEnd?.(),
            }));
        }
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [draggableEntity, draggableId, onDragEnd, onDragStart, onDrop, onTargetChange, onTargetLeave, targetId]);

    return (
        <View ref={ref} style={[style, active && stylesheet.listDropTarget]} testID={testID}>
            {children}
            {dropPosition ? (
                <View
                    style={[stylesheet.listDropIndicator, dropPosition === 'before' ? stylesheet.listDropIndicatorBefore : stylesheet.listDropIndicatorAfter]}
                    testID={`sidebar-list-drop-indicator-${dropPosition}`}
                />
            ) : null}
        </View>
    );
}

function SidebarListsView() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const listColors = getListColors(theme.colors);
    const pathname = usePathname();
    const data = useVisibleSessionListViewData();
    const organization = useSetting('sidebarOrganization');
    const updateOrganization = useSettingUpdater('sidebarOrganization');
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
    const [selectedTagId, setSelectedTagId] = React.useState<string | null>(null);
    const [editorVisible, setEditorVisible] = React.useState(false);
    const [editingList, setEditingList] = React.useState<SidebarList | null>(null);
    const [organizingSession, setOrganizingSession] = React.useState<SessionRowData | null>(null);
    const [draggedSessionId, setDraggedSessionId] = React.useState<string | null>(null);
    const [draggedListId, setDraggedListId] = React.useState<string | null>(null);
    const [dropFeedback, setDropFeedback] = React.useState<{
        entity: SidebarDragData['entity'];
        listId: string;
        position: SidebarDropPosition | null;
    } | null>(null);
    const selectedSessionId = pathname.startsWith('/session/') ? pathname.split('/')[2] : null;
    const sessions = React.useMemo(() => {
        if (!data) return [];
        const byId = new Map<string, SessionRowData>();
        data.forEach((item) => {
            if (item.type === 'active-sessions') item.sessions.forEach((session) => byId.set(session.id, session));
            if (item.type === 'session') byId.set(item.session.id, item.session);
        });
        return Array.from(byId.values());
    }, [data]);
    const sessionManagement = useSessionManagementPreferences(sessions.map((session) => session.id), { prune: false });
    const partitionedSessions = React.useMemo(() => partitionSessionsByPinnedOrder(
        sessions,
        sessionManagement.preferences.pinnedOrder,
    ), [sessionManagement.preferences.pinnedOrder, sessions]);
    const sessionIndex = React.useMemo(
        () => buildSidebarSessionIndex(partitionedSessions.regular, organization.sessions),
        [organization.sessions, partitionedSessions.regular],
    );

    React.useEffect(() => {
        if (!selectedSessionId) return;
        const selectedListId = organization.sessions[selectedSessionId]?.listId ?? 'unassigned';
        setExpanded((current) => {
            if (current.has(selectedListId)) return current;
            const next = new Set(current);
            next.add(selectedListId);
            return next;
        });
    }, [organization.sessions, selectedSessionId]);

    const toggleExpanded = React.useCallback((id: string) => {
        setExpanded((current) => {
            const next = new Set(current);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }, []);

    const addTag = React.useCallback(async () => {
        if (organization.tags.length >= SIDEBAR_TAG_MAX_COUNT) return;
        const name = normalizeSidebarTagName((await Modal.prompt(t('sidebarLists.newTag'), undefined, {
            placeholder: t('sidebarLists.tagNamePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('common.create'),
        })) ?? '');
        if (!name) return;
        updateOrganization((current) => {
            if (current.tags.length >= SIDEBAR_TAG_MAX_COUNT || current.tags.some((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return current;
            return {
                ...current,
                tags: [...current.tags, {
                    id: createSidebarOrganizationId('tag'),
                    name,
                    color: SIDEBAR_LIST_COLORS[current.tags.length % SIDEBAR_LIST_COLORS.length],
                    createdAt: Date.now(),
                }],
            };
        });
    }, [organization.tags.length, updateOrganization]);

    const createSession = React.useCallback((list: SidebarList) => {
        const draft = useNewSessionDraft.getState();
        if (list.kind === 'workspace') {
            if (list.machineId) draft.setMachineId(list.machineId);
            if (list.path) draft.setPath(list.path);
            if (list.defaultAgent) draft.setAgentType(list.defaultAgent);
        } else {
            draft.setAgentType('ask');
            draft.setInput('');
        }
        router.navigate({ pathname: '/new', params: { sidebarListId: list.id } });
    }, [router]);

    const openCreate = React.useCallback(() => {
        setEditingList(null);
        setEditorVisible(true);
    }, []);
    const openEdit = React.useCallback((list: SidebarList) => {
        setEditingList(list);
        setEditorVisible(true);
    }, []);
    const closeEditor = React.useCallback(() => setEditorVisible(false), []);
    const openOrganizer = React.useCallback((session: SessionRowData) => setOrganizingSession(session), []);
    const startSessionDrag = React.useCallback((data: SidebarDragData) => {
        setDraggedSessionId(data.id);
    }, []);
    const startListDrag = React.useCallback((data: SidebarDragData) => {
        setDraggedListId(data.id);
    }, []);
    const finishSidebarDrag = React.useCallback(() => {
        setDraggedSessionId(null);
        setDraggedListId(null);
        setDropFeedback(null);
    }, []);
    const changeDropTarget = React.useCallback((listId: string, data: SidebarDragData, position: SidebarDropPosition | null) => {
        setDropFeedback({ entity: data.entity, listId, position });
    }, []);
    const leaveDropTarget = React.useCallback((listId: string) => {
        setDropFeedback((current) => current?.listId === listId ? null : current);
    }, []);
    const dropOntoList = React.useCallback((listId: string, data: SidebarDragData, position: SidebarDropPosition | null) => {
        if (data.entity === 'list') {
            if (position) updateOrganization((current) => reorderSidebarList(current, data.id, listId, position));
            finishSidebarDrag();
            return;
        }
        const nextListId = listId === 'unassigned' ? null : listId;
        updateOrganization((current) => moveSidebarSessionToList(current, data.id, nextListId));
        setExpanded((current) => new Set(current).add(listId));
        finishSidebarDrag();
    }, [finishSidebarDrag, updateOrganization]);
    const deleteList = React.useCallback(async (list: SidebarList) => {
        const confirmed = await Modal.confirm(
            t('sidebarLists.deleteList'),
            t('sidebarLists.deleteListConfirm', { name: list.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        updateOrganization((current) => removeSidebarList(current, list.id));
    }, [updateOrganization]);

    const rows = React.useMemo<SidebarVirtualRow[]>(() => {
        const next: SidebarVirtualRow[] = [];
        if (partitionedSessions.pinned.length > 0) {
            next.push({ key: 'pinned-section', type: 'section', section: 'pinned' });
            partitionedSessions.pinned.forEach((session) => next.push({
                key: `pinned-${session.id}`,
                type: 'pinned-session',
                session,
            }));
        }
        if (selectedTagId) {
            const tag = organization.tags.find((item) => item.id === selectedTagId);
            next.push({ key: 'filtered-header', type: 'filtered-header', tagName: tag?.name ?? '' });
            const filteredSessions = sessionIndex.byTagId.get(selectedTagId) ?? [];
            if (filteredSessions.length > 0) {
                filteredSessions.forEach((session) => next.push({ key: `filtered-${session.id}`, type: 'session', session, nested: false }));
            } else {
                next.push({ key: 'filtered-empty', type: 'empty', label: t('sidebarLists.noTaggedSessions'), nested: false });
            }
        } else {
            next.push({ key: 'lists-section', type: 'section', section: 'lists' });
            for (const list of organization.lists) {
                next.push({ key: `list-${list.id}`, type: 'list', list });
                if (!expanded.has(list.id)) continue;
                next.push({ key: `new-session-${list.id}`, type: 'new-session', list });
                const listSessions = sessionIndex.byListId.get(list.id) ?? [];
                if (listSessions.length > 0) {
                    listSessions.forEach((session) => next.push({ key: `list-${list.id}-${session.id}`, type: 'session', session, nested: true }));
                } else {
                    next.push({ key: `empty-${list.id}`, type: 'empty', label: t('sidebarLists.emptyList'), nested: true });
                }
            }
            next.push({ key: 'unassigned', type: 'unassigned' });
            if (expanded.has('unassigned')) {
                sessionIndex.unassigned.forEach((session) => next.push({ key: `unassigned-${session.id}`, type: 'session', session, nested: true }));
            }
        }
        next.push({ key: 'tags-section', type: 'section', section: 'tags' });
        next.push({ key: 'tags', type: 'tags' });
        return next;
    }, [expanded, organization.lists, organization.tags, partitionedSessions.pinned, selectedTagId, sessionIndex]);

    const renderRow = React.useCallback(({ item }: { item: SidebarVirtualRow }) => {
        if (item.type === 'section') {
            const isLists = item.section === 'lists';
            const isPinned = item.section === 'pinned';
            return (
                <View
                    style={[styles.sectionHeader, !isLists && !isPinned && styles.tagSection]}
                    testID={isPinned ? 'sidebar-pinned-section' : undefined}
                >
                    <Text style={styles.sectionTitle}>
                        {isPinned ? t('sessionSearch.sections.pinned') : isLists ? t('sidebarLists.lists') : t('sidebarLists.tags')}
                    </Text>
                    {!isPinned ? (
                        <Pressable
                            accessibilityLabel={isLists ? t('sidebarLists.newList') : t('sidebarLists.newTag')}
                            accessibilityState={{ disabled: isLists ? organization.lists.length >= SIDEBAR_LIST_MAX_COUNT : organization.tags.length >= SIDEBAR_TAG_MAX_COUNT }}
                            disabled={isLists ? organization.lists.length >= SIDEBAR_LIST_MAX_COUNT : organization.tags.length >= SIDEBAR_TAG_MAX_COUNT}
                            onPress={isLists ? openCreate : addTag}
                            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
                            testID={isLists ? 'sidebar-create-list-button' : 'sidebar-create-tag-button'}
                        >
                            <Feather color={theme.colors.textSecondary} name="plus" size={17} />
                        </Pressable>
                    ) : null}
                </View>
            );
        }
        if (item.type === 'pinned-session') {
            return (
                <CompactSessionRow
                    session={item.session}
                    selected={selectedSessionId === item.session.id}
                    showLocation
                />
            );
        }
        if (item.type === 'filtered-header') {
            return (
                <View style={styles.filteredHeader}>
                    <Text style={styles.filteredTitle} numberOfLines={1}>#{item.tagName}</Text>
                    <Pressable accessibilityLabel={t('sidebarLists.close')} accessibilityRole="button" onPress={() => setSelectedTagId(null)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID="sidebar-close-tag-filter">
                        <Feather color={theme.colors.textSecondary} name="x" size={16} />
                    </Pressable>
                </View>
            );
        }
        if (item.type === 'list') {
            const { list } = item;
            const isExpanded = expanded.has(list.id);
            const meta = list.kind === 'agent'
                ? `${t('sidebarLists.agentList')} · ${t('newSession.askMode')}`
                : [list.machineId, list.path].filter(Boolean).join(' · ') || t('sidebarLists.workspaceList');
            return (
                <WebDropTarget
                    active={dropFeedback?.entity === 'session' && dropFeedback.listId === list.id}
                    draggableEntity="list"
                    draggableId={list.id}
                    dropPosition={dropFeedback?.entity === 'list' && dropFeedback.listId === list.id ? dropFeedback.position : null}
                    onDragEnd={finishSidebarDrag}
                    onDragStart={startListDrag}
                    onDrop={dropOntoList}
                    onTargetChange={changeDropTarget}
                    onTargetLeave={leaveDropTarget}
                    style={[styles.listBlock, draggedListId === list.id && styles.sessionRowDragging]}
                    targetId={list.id}
                    testID={`sidebar-drop-list-${list.id}`}
                >
                    <View style={styles.listRow}>
                        <Pressable accessibilityRole="button" accessibilityState={{ expanded: isExpanded }} onPress={() => toggleExpanded(list.id)} style={({ pressed }) => [styles.listRowMain, pressed && styles.listRowPressed]} testID={`sidebar-list-${list.id}`}>
                            <Feather color={theme.colors.textSecondary} name={isExpanded ? 'chevron-down' : 'chevron-right'} size={15} />
                            <View style={[styles.listGlyph, { backgroundColor: theme.colors.surfaceHigh }]}>
                                <Feather color={listColors[list.color]} name={list.kind === 'agent' ? 'cpu' : 'folder'} size={16} />
                            </View>
                            <View style={styles.listCopy}>
                                <Text numberOfLines={1} style={styles.listName}>{list.name}</Text>
                                <Text numberOfLines={1} style={styles.listMeta}>{meta}</Text>
                            </View>
                        </Pressable>
                        <Text style={styles.count}>{sessionIndex.byListId.get(list.id)?.length ?? 0}</Text>
                        <Pressable accessibilityLabel={`${t('sidebarLists.editList')} ${list.name}`} accessibilityRole="button" onPress={() => openEdit(list)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID={`sidebar-edit-list-${list.id}`}>
                            <Feather color={theme.colors.textSecondary} name="edit-2" size={14} />
                        </Pressable>
                        <Pressable accessibilityLabel={`${t('sidebarLists.deleteList')} ${list.name}`} accessibilityRole="button" onPress={() => void deleteList(list)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID={`sidebar-delete-list-${list.id}`}>
                            <Feather color={theme.colors.deleteAction} name="trash-2" size={14} />
                        </Pressable>
                    </View>
                </WebDropTarget>
            );
        }
        if (item.type === 'unassigned') {
            const isExpanded = expanded.has('unassigned');
            return (
                <WebDropTarget
                    active={dropFeedback?.entity === 'session' && dropFeedback.listId === 'unassigned'}
                    dropPosition={null}
                    onDrop={dropOntoList}
                    onTargetChange={changeDropTarget}
                    onTargetLeave={leaveDropTarget}
                    targetId="unassigned"
                    testID="sidebar-drop-list-unassigned"
                >
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isExpanded }}
                        onPress={() => toggleExpanded('unassigned')}
                        style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
                        testID="sidebar-list-unassigned"
                    >
                        <Feather color={theme.colors.textSecondary} name={isExpanded ? 'chevron-down' : 'chevron-right'} size={15} />
                        <View style={[styles.listGlyph, { backgroundColor: theme.colors.surfaceHigh }]}><Feather color={theme.colors.textSecondary} name="inbox" size={16} /></View>
                        <View style={styles.listCopy}><Text style={styles.listName}>{t('sidebarLists.unassigned')}</Text><Text style={styles.listMeta}>{t('sidebarLists.unassignedDescription')}</Text></View>
                        <Text style={styles.count}>{sessionIndex.unassigned.length}</Text>
                    </Pressable>
                </WebDropTarget>
            );
        }
        if (item.type === 'new-session') {
            return (
                <Pressable accessibilityLabel={t('sidebarLists.newSessionInList')} onPress={() => createSession(item.list)} style={({ pressed }) => [styles.newSessionRow, pressed && styles.listRowPressed]} testID={`sidebar-new-session-${item.list.id}`}>
                    <Feather color={theme.colors.textSecondary} name="plus" size={15} />
                    <Text style={styles.newSessionText}>{t('sidebarLists.newSessionInList')}</Text>
                </Pressable>
            );
        }
        if (item.type === 'session') {
            return <OrganizedSessionRow dragging={draggedSessionId === item.session.id} onDragEnd={finishSidebarDrag} onDragStart={startSessionDrag} onOrganize={openOrganizer} selected={selectedSessionId === item.session.id} session={item.session} />;
        }
        if (item.type === 'empty') {
            return <Text style={[styles.empty, item.nested && styles.sessionRowNested]}>{item.label}</Text>;
        }
        return (
            <View style={styles.tags}>
                {organization.tags.map((tag) => {
                    const selected = tag.id === selectedTagId;
                    const count = sessionIndex.byTagId.get(tag.id)?.length ?? 0;
                    return (
                        <Pressable aria-selected={selected} accessibilityRole="button" accessibilityState={{ selected }} key={tag.id} onPress={() => setSelectedTagId(selected ? null : tag.id)} style={({ pressed }) => [styles.tag, selected && styles.tagSelected, pressed && styles.tagSelected]} testID={`sidebar-tag-${tag.id}`}>
                            <View style={[styles.tagDot, { backgroundColor: listColors[tag.color] }]} />
                            <Text style={styles.tagText}>{tag.name} {count}</Text>
                        </Pressable>
                    );
                })}
                {organization.tags.length === 0 ? <Text style={styles.empty}>{t('sidebarLists.noTags')}</Text> : null}
            </View>
        );
    }, [addTag, changeDropTarget, createSession, deleteList, draggedListId, draggedSessionId, dropFeedback, dropOntoList, expanded, finishSidebarDrag, leaveDropTarget, listColors, openCreate, openEdit, openOrganizer, organization.lists.length, organization.sessions, organization.tags, selectedSessionId, selectedTagId, sessionIndex, startListDrag, startSessionDrag, styles, theme.colors]);

    return (
        <View style={styles.container} testID="sidebar-lists-view">
            <FlatList
                contentContainerStyle={styles.listsContent}
                data={rows}
                initialNumToRender={18}
                keyExtractor={(item) => item.key}
                keyboardShouldPersistTaps="handled"
                maxToRenderPerBatch={12}
                removeClippedSubviews={Platform.OS !== 'web'}
                renderItem={renderRow}
                style={styles.listsScroll}
                windowSize={7}
            />
            <ListEditorDialog
                list={editingList}
                onClose={closeEditor}
                onDelete={(listId) => updateOrganization((current) => removeSidebarList(current, listId))}
                onSave={(list) => updateOrganization((current) => ({
                    ...current,
                    lists: editingList
                        ? current.lists.map((item) => item.id === list.id ? list : item)
                        : [...current.lists, list],
                }))}
                organization={organization}
                sessions={sessions}
                visible={editorVisible}
            />
            {organizingSession ? (
                <SessionOrganizerDialog
                    assignment={organization.sessions[organizingSession.id] ?? { listId: null, tagIds: [] }}
                    onClose={() => setOrganizingSession(null)}
                    onSave={(assignment, createdTags) => updateOrganization((current) => organizeSessionWithCreatedTags(current, organizingSession.id, assignment, createdTags))}
                    organization={organization}
                    sessionName={organizingSession.name}
                    visible
                />
            ) : null}
        </View>
    );
}

const OrganizedSessionRow = React.memo(function OrganizedSessionRow({ dragging, onDragEnd, onDragStart, onOrganize, selected, session }: { dragging: boolean; onDragEnd: () => void; onDragStart: (data: SidebarDragData) => void; onOrganize: (session: SessionRowData) => void; selected: boolean; session: SessionRowData }) {
    const styles = stylesheet;
    const ref = React.useRef<View>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = ref.current as unknown as HTMLElement | null;
        if (!element) return;
        return registerSidebarDraggable({
            data: { entity: 'session', id: session.id, type: 'paws-sidebar-drag' },
            element,
            onDragStart,
            onDrop: onDragEnd,
        });
    }, [onDragEnd, onDragStart, session.id]);

    return (
        <View
            ref={ref}
            style={dragging ? styles.sessionRowDragging : undefined}
            testID={`sidebar-drag-session-${session.id}`}
        >
            <CompactSessionRow compactActions onOrganize={onOrganize} selected={selected} session={session} showLocation />
        </View>
    );
});

function ListEditorDialog({ list, onClose, onDelete, onSave, organization, sessions, visible }: {
    list: SidebarList | null;
    onClose: () => void;
    onDelete: (listId: string) => void;
    onSave: (list: SidebarList) => void;
    organization: SidebarOrganization;
    sessions: readonly SessionRowData[];
    visible: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const listColors = getListColors(theme.colors);
    const machines = useAllMachines({ includeOffline: true });
    const [name, setName] = React.useState('');
    const [kind, setKind] = React.useState<'workspace' | 'agent'>('workspace');
    const [color, setColor] = React.useState<SidebarListColor>('blue');
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [path, setPath] = React.useState('');
    const [defaultAgent, setDefaultAgent] = React.useState<NewSessionAgentType | null>(null);
    const [folderId, setFolderId] = React.useState<string | null>(null);
    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === machineId) ?? null,
        [machineId, machines],
    );
    const machineItems = React.useMemo<PickerItem[]>(() => machines.map((machine) => ({
        key: machine.id,
        label: machine.metadata?.displayName || machine.metadata?.host || machine.id,
        subtitle: isMachineOnline(machine) ? t('status.online') : t('agents.machineOffline'),
    })), [machines]);
    const pathItems = React.useMemo<PickerItem[]>(() => {
        if (!machineId) return [];
        const paths = new Set<string>();
        sessions.forEach((session) => {
            if (session.machineId === machineId && session.path) paths.add(session.path);
        });
        return Array.from(paths).sort().map((value) => ({
            key: value,
            label: formatPathRelativeToHome(value, selectedMachine?.metadata?.homeDir),
        }));
    }, [machineId, selectedMachine, sessions]);
    const duplicate = organization.lists.some((item) => item.id !== list?.id && item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    const canSave = name.trim().length > 0 && !duplicate && (list !== null || organization.lists.length < SIDEBAR_LIST_MAX_COUNT);

    React.useEffect(() => {
        if (!visible) return;
        setName(list?.name ?? '');
        setKind(list?.kind ?? 'workspace');
        setColor(list?.color ?? 'blue');
        setMachineId(list?.kind === 'workspace' ? list.machineId : null);
        setPath(list?.kind === 'workspace' ? list.path ?? '' : '');
        setDefaultAgent(list?.kind === 'workspace' ? list.defaultAgent : null);
        setFolderId(list?.folderId ?? null);
    }, [list, visible]);

    const save = () => {
        if (!canSave) return;
        const common = {
            id: list?.id ?? createSidebarOrganizationId('list'),
            name: name.trim(),
            color,
            folderId,
            createdAt: list?.createdAt ?? Date.now(),
        };
        onSave(kind === 'agent'
            ? { ...common, kind: 'agent' }
            : { ...common, kind: 'workspace', machineId, path: path.trim() || null, defaultAgent });
        onClose();
    };
    const deleteList = async () => {
        if (!list) return;
        const confirmed = await Modal.confirm(
            t('sidebarLists.deleteList'),
            t('sidebarLists.deleteListConfirm', { name: list.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        onDelete(list.id);
        onClose();
    };

    return (
        <DesktopDialogFrame onClose={onClose} title={list ? t('sidebarLists.editList') : t('sidebarLists.newList')} visible={visible}>
            <ScrollView contentContainerStyle={styles.dialogBody}>
                <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('sidebarLists.listName')}</Text>
                    <TextInput autoFocus maxLength={SIDEBAR_LIST_NAME_MAX_LENGTH} onChangeText={setName} placeholder={t('sidebarLists.listNamePlaceholder')} placeholderTextColor={stylesheet.fieldLabel.color} style={styles.input} testID="sidebar-list-name-input" value={name} />
                    {duplicate ? <Text style={styles.fieldLabel}>{t('sidebarLists.duplicateListName')}</Text> : null}
                </View>
                <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('sidebarLists.listType')}</Text>
                    <View accessibilityLabel={t('sidebarLists.listType')} accessibilityRole="radiogroup" style={styles.segmented}>
                        {(['workspace', 'agent'] as const).map((value) => <Pressable aria-checked={kind === value} accessibilityRole="radio" accessibilityState={{ checked: kind === value }} key={value} onPress={() => setKind(value)} style={[styles.segment, kind === value && styles.segmentSelected]} testID={`sidebar-list-kind-${value}`}><Text style={[styles.segmentText, kind === value && styles.segmentTextSelected]}>{value === 'workspace' ? t('sidebarLists.workspaceList') : t('sidebarLists.agentList')}</Text></Pressable>)}
                    </View>
                </View>
                <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('sidebarLists.color')}</Text>
                    <View accessibilityLabel={t('sidebarLists.color')} accessibilityRole="radiogroup" style={styles.choices}>{SIDEBAR_LIST_COLORS.map((value) => <Pressable aria-checked={color === value} accessibilityLabel={t(COLOR_LABEL_KEYS[value])} accessibilityRole="radio" accessibilityState={{ checked: color === value }} key={value} onPress={() => setColor(value)} style={styles.colorChoice} testID={`sidebar-list-color-${value}`}><View style={[styles.colorSwatch, { backgroundColor: listColors[value] }, color === value && styles.colorChoiceSelected]} /></Pressable>)}</View>
                </View>
                {(organization.folders?.length ?? 0) > 0 ? (
                    <View style={styles.field}>
                        <Text style={styles.fieldLabel}>{t('sidebarLists.folder')}</Text>
                        <View accessibilityLabel={t('sidebarLists.folder')} accessibilityRole="radiogroup" style={styles.choices}>
                            <Choice label={t('sidebarLists.noFolder')} onPress={() => setFolderId(null)} selected={folderId === null} testID="sidebar-list-folder-none" />
                            {(organization.folders ?? []).map((folder) => (
                                <Choice key={folder.id} label={folder.name} onPress={() => setFolderId(folder.id)} selected={folderId === folder.id} testID={`sidebar-list-folder-${folder.id}`} />
                            ))}
                        </View>
                    </View>
                ) : null}
                {kind === 'workspace' ? (
                    <>
                        <View style={styles.field} testID="sidebar-list-machine-picker">
                            <Text style={styles.fieldLabel}>{t('sidebarLists.defaultMachine')}</Text>
                            <PickerContent
                                embedded
                                fixedItems={[{ key: '__none__', label: t('sidebarLists.noPreset') }]}
                                items={machineItems}
                                onSelect={(key) => {
                                    const nextMachineId = key === '__none__' ? null : key;
                                    if (nextMachineId !== machineId) setPath('');
                                    setMachineId(nextMachineId);
                                }}
                                searchPlaceholder={t('sidebarLists.defaultMachine')}
                                selectedKey={machineId ?? '__none__'}
                                title={t('sidebarLists.defaultMachine')}
                            />
                        </View>
                        <View style={styles.field} testID="sidebar-list-directory-picker">
                            <Text style={styles.fieldLabel}>{t('sidebarLists.defaultDirectory')}</Text>
                            <View style={styles.choices}>
                                <Choice
                                    label={t('sidebarLists.noPreset')}
                                    onPress={() => setPath('')}
                                    selected={path.trim().length === 0}
                                    testID="sidebar-list-directory-none"
                                />
                            </View>
                            <PathPickerContent
                                embedded
                                emptyRecentLabel={t('agents.folderNoRecent')}
                                homeDir={selectedMachine?.metadata?.homeDir}
                                inputPlaceholder={t('sidebarLists.directoryPlaceholder')}
                                items={pathItems}
                                machineId={machineId}
                                machineOnline={selectedMachine ? isMachineOnline(selectedMachine) : false}
                                manualInput={false}
                                onChangeValue={setPath}
                                recentLabel={t('agents.folderRecent')}
                                title={t('sidebarLists.defaultDirectory')}
                                value={path}
                            />
                        </View>
                        <View style={styles.field}><Text style={styles.fieldLabel}>{t('sidebarLists.defaultAgent')}</Text><View accessibilityLabel={t('sidebarLists.defaultAgent')} accessibilityRole="radiogroup" style={styles.choices}><Choice label={t('sidebarLists.noPreset')} onPress={() => setDefaultAgent(null)} selected={defaultAgent === null} />{AGENT_TYPES.map((agent) => <Choice key={agent} label={t(AGENT_LABEL_KEYS[agent])} onPress={() => setDefaultAgent(agent)} selected={defaultAgent === agent} />)}</View></View>
                    </>
                ) : (
                    <View style={styles.field}>
                        <Text style={styles.fieldLabel}>{t('sidebarLists.defaultAgent')}</Text>
                        <View accessibilityRole="radiogroup" style={styles.choices}>
                            <Choice disabled label={t('newSession.askMode')} onPress={() => undefined} selected />
                        </View>
                    </View>
                )}
            </ScrollView>
            <View style={styles.dialogFooter}>
                {list ? <Pressable accessibilityRole="button" onPress={() => void deleteList()} style={[styles.button, styles.destructiveButton]} testID="sidebar-delete-list"><Text style={styles.destructiveButtonText}>{t('common.delete')}</Text></Pressable> : null}
                <Pressable accessibilityRole="button" onPress={onClose} style={[styles.button, styles.secondaryButton]} testID="sidebar-create-list-cancel"><Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSave }} disabled={!canSave} onPress={save} style={[styles.button, styles.primaryButton, !canSave && styles.buttonDisabled]} testID={list ? 'sidebar-edit-list-submit' : 'sidebar-create-list-submit'}><Text style={styles.primaryButtonText}>{list ? t('common.save') : t('common.create')}</Text></Pressable>
            </View>
        </DesktopDialogFrame>
    );
}

function Choice({ disabled = false, label, onPress, selected, testID }: { disabled?: boolean; label: string; onPress: () => void; selected: boolean; testID?: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return <Pressable aria-checked={selected} accessibilityLabel={label} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]} testID={testID}><Feather color={selected ? theme.colors.accent : theme.colors.textSecondary} name={selected ? 'check-circle' : 'circle'} size={14} /><Text style={styles.choiceText}>{label}</Text></Pressable>;
}
