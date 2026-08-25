import * as React from 'react';
import {
    FlatList,
    Platform,
    Pressable,
    ScrollView,
    TextInput,
    View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { mq, StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Modal } from '@/modal';
import {
    useAllMachines,
    useLocalSettingMutable,
    useLocalSettingUpdater,
    type SessionRowData,
} from '@/sync/storage';
import type { NewSessionAgentType } from '@/sync/persistence';
import { t } from '@/text';
import { MainView } from './MainView';
import { DesktopDialogFrame } from './DesktopDialogFrame';
import { PathPickerContent, PickerContent, type PickerItem } from './SessionConfigPanel';
import { SessionOrganizerDialog } from './SessionOrganizerDialog';
import {
    buildSidebarSessionIndex,
    createSidebarOrganizationId,
    normalizeSidebarTagName,
    moveSidebarSessionToList,
    organizeSessionWithCreatedTags,
    reorderSidebarList,
    removeSidebarList,
    SIDEBAR_LIST_COLORS,
    SIDEBAR_LIST_MAX_COUNT,
    SIDEBAR_LIST_NAME_MAX_LENGTH,
    SIDEBAR_TAG_MAX_COUNT,
    type SidebarList,
    type SidebarListColor,
    type SidebarOrganization,
    type SidebarTag,
} from '@/sync/sidebarOrganization';
import { isMachineOnline } from '@/utils/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';

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
    listBlock: { marginBottom: 2 },
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
    listDropTarget: { backgroundColor: theme.colors.surfaceSelected },
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
    sessionRowDragging: { opacity: 0.55 },
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

export const DesktopSidebarSessionsNavigation = React.memo(() => {
    const [mode, setMode] = useLocalSettingMutable('desktopSidebarMode');
    const styles = stylesheet;

    return (
        <View style={styles.container} testID="desktop-sidebar-session-navigation">
            <View accessibilityRole="tablist" style={styles.tabs}>
                <View pointerEvents="none" style={styles.tabTrack} />
                {(['projects', 'lists'] as const).map((value) => {
                    const selected = mode === value;
                    return (
                        <Pressable
                            aria-selected={selected}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            key={value}
                            onPress={() => setMode(value)}
                            style={styles.tab}
                            testID={`desktop-sidebar-tab-${value}`}
                        >
                            {({ pressed }) => (
                                <View style={[styles.tabVisual, selected && styles.tabSelected, pressed && styles.tabPressed]} testID={`desktop-sidebar-tab-${value}-visual`}>
                                    <Text style={[styles.tabText, selected && styles.tabTextSelected]}>
                                        {value === 'projects' ? t('sidebar.projectsTab') : t('sidebar.listsTab')}
                                    </Text>
                                </View>
                            )}
                        </Pressable>
                    );
                })}
            </View>
            {mode === 'projects' ? <MainView variant="sidebar" /> : <SidebarListsView />}
        </View>
    );
});

type SidebarVirtualRow =
    | { key: string; type: 'section'; section: 'lists' | 'tags' }
    | { key: string; type: 'list'; list: SidebarList }
    | { key: string; type: 'unassigned' }
    | { key: string; type: 'new-session'; list: SidebarList }
    | { key: string; type: 'session'; session: SessionRowData; nested: boolean }
    | { key: string; type: 'empty'; label: string; nested: boolean }
    | { key: string; type: 'filtered-header'; tagName: string }
    | { key: string; type: 'tags' };

type SidebarWebDragEvent = {
    clientY?: number;
    currentTarget?: EventTarget | null;
    dataTransfer?: DataTransfer | null;
    preventDefault?: () => void;
    relatedTarget?: EventTarget | null;
};

const SIDEBAR_SESSION_DRAG_TYPE = 'application/x-paws-sidebar-session';
const SIDEBAR_LIST_DRAG_TYPE = 'application/x-paws-sidebar-list';

function WebDropTarget({ active, children, draggableId, onDragEnd, onDragLeave, onDragOver, onDragStart, onDrop, style, targetId, testID }: {
    active: boolean;
    children: React.ReactNode;
    draggableId?: string;
    onDragEnd?: () => void;
    onDragLeave?: (targetId: string, event: SidebarWebDragEvent) => void;
    onDragOver: (targetId: string, event: SidebarWebDragEvent) => void;
    onDragStart?: (sourceId: string, event: SidebarWebDragEvent) => void;
    onDrop: (targetId: string, event: SidebarWebDragEvent) => void;
    style?: React.ComponentProps<typeof View>['style'];
    targetId: string;
    testID: string;
}) {
    const ref = React.useRef<View>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = ref.current as unknown as HTMLElement | null;
        if (!element) return;
        const handleDragStart = (event: DragEvent) => {
            if (draggableId) onDragStart?.(draggableId, event);
        };
        const handleDragLeave = (event: DragEvent) => {
            const nextTarget = event.relatedTarget;
            const ownerWindow = element.ownerDocument.defaultView;
            if (nextTarget && ownerWindow && nextTarget instanceof ownerWindow.Node && element.contains(nextTarget)) return;
            onDragLeave?.(targetId, event);
        };
        const handleDragOver = (event: DragEvent) => onDragOver(targetId, event);
        const handleDrop = (event: DragEvent) => onDrop(targetId, event);
        if (draggableId) {
            element.draggable = true;
            element.addEventListener('dragstart', handleDragStart);
            if (onDragEnd) element.addEventListener('dragend', onDragEnd);
        }
        element.addEventListener('dragleave', handleDragLeave);
        element.addEventListener('dragover', handleDragOver);
        element.addEventListener('drop', handleDrop);
        return () => {
            element.draggable = false;
            element.removeEventListener('dragstart', handleDragStart);
            if (onDragEnd) element.removeEventListener('dragend', onDragEnd);
            element.removeEventListener('dragleave', handleDragLeave);
            element.removeEventListener('dragover', handleDragOver);
            element.removeEventListener('drop', handleDrop);
        };
    }, [draggableId, onDragEnd, onDragLeave, onDragOver, onDragStart, onDrop, targetId]);

    return <View ref={ref} style={[style, active && stylesheet.listDropTarget]} testID={testID}>{children}</View>;
}

function SidebarListsView() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const listColors = getListColors(theme.colors);
    const pathname = usePathname();
    const data = useVisibleSessionListViewData();
    const organization = useLocalSettingMutable('sidebarOrganization')[0];
    const updateOrganization = useLocalSettingUpdater('sidebarOrganization');
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
    const [selectedTagId, setSelectedTagId] = React.useState<string | null>(null);
    const [editorVisible, setEditorVisible] = React.useState(false);
    const [editingList, setEditingList] = React.useState<SidebarList | null>(null);
    const [organizingSession, setOrganizingSession] = React.useState<SessionRowData | null>(null);
    const [draggedSessionId, setDraggedSessionId] = React.useState<string | null>(null);
    const [draggedListId, setDraggedListId] = React.useState<string | null>(null);
    const [dragOverListId, setDragOverListId] = React.useState<string | null>(null);
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
    const sessionIndex = React.useMemo(
        () => buildSidebarSessionIndex(sessions, organization.sessions),
        [organization.sessions, sessions],
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
    const openSession = React.useCallback((session: SessionRowData) => navigateToSession(session.id), [navigateToSession]);
    const openOrganizer = React.useCallback((session: SessionRowData) => setOrganizingSession(session), []);
    const startSessionDrag = React.useCallback((sessionId: string, event: SidebarWebDragEvent) => {
        if (Platform.OS !== 'web') return;
        event.dataTransfer?.setData(SIDEBAR_SESSION_DRAG_TYPE, sessionId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        setDraggedSessionId(sessionId);
    }, []);
    const startListDrag = React.useCallback((listId: string, event: SidebarWebDragEvent) => {
        if (Platform.OS !== 'web') return;
        event.dataTransfer?.setData(SIDEBAR_LIST_DRAG_TYPE, listId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        setDraggedListId(listId);
    }, []);
    const finishSidebarDrag = React.useCallback(() => {
        setDraggedSessionId(null);
        setDraggedListId(null);
        setDragOverListId(null);
    }, []);
    const dragOverList = React.useCallback((listId: string, event: SidebarWebDragEvent) => {
        if (Platform.OS !== 'web') return;
        if (draggedListId && (listId === 'unassigned' || listId === draggedListId)) return;
        if (!draggedListId && !draggedSessionId) return;
        event.preventDefault?.();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setDragOverListId(listId);
    }, [draggedListId, draggedSessionId]);
    const leaveList = React.useCallback((listId: string) => {
        setDragOverListId((current) => current === listId ? null : current);
    }, []);
    const dropOntoList = React.useCallback((listId: string, event: SidebarWebDragEvent) => {
        if (Platform.OS !== 'web') return;
        event.preventDefault?.();
        const sourceListId = event.dataTransfer?.getData(SIDEBAR_LIST_DRAG_TYPE) || draggedListId;
        if (sourceListId) {
            if (listId !== 'unassigned' && listId !== sourceListId) {
                const element = event.currentTarget as HTMLElement | null;
                const bounds = element?.getBoundingClientRect();
                const position = bounds && typeof event.clientY === 'number' && event.clientY >= bounds.top + bounds.height / 2
                    ? 'after'
                    : 'before';
                updateOrganization((current) => reorderSidebarList(current, sourceListId, listId, position));
            }
            finishSidebarDrag();
            return;
        }
        const sessionId = event.dataTransfer?.getData(SIDEBAR_SESSION_DRAG_TYPE) || draggedSessionId;
        if (!sessionId) return;
        const nextListId = listId === 'unassigned' ? null : listId;
        updateOrganization((current) => moveSidebarSessionToList(current, sessionId, nextListId));
        setExpanded((current) => new Set(current).add(listId));
        finishSidebarDrag();
    }, [draggedListId, draggedSessionId, finishSidebarDrag, updateOrganization]);
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
    }, [expanded, organization.lists, organization.tags, selectedTagId, sessionIndex]);

    const renderRow = React.useCallback(({ item }: { item: SidebarVirtualRow }) => {
        if (item.type === 'section') {
            const isLists = item.section === 'lists';
            return (
                <View style={[styles.sectionHeader, !isLists && styles.tagSection]}>
                    <Text style={styles.sectionTitle}>{isLists ? t('sidebarLists.lists') : t('sidebarLists.tags')}</Text>
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
                </View>
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
                    active={dragOverListId === list.id}
                    draggableId={list.id}
                    onDragEnd={finishSidebarDrag}
                    onDragLeave={leaveList}
                    onDragOver={dragOverList}
                    onDragStart={startListDrag}
                    onDrop={dropOntoList}
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
                    active={dragOverListId === 'unassigned'}
                    onDragLeave={leaveList}
                    onDragOver={dragOverList}
                    onDrop={dropOntoList}
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
            const sessionTags = (organization.sessions[item.session.id]?.tagIds ?? [])
                .map((tagId) => organization.tags.find((tag) => tag.id === tagId))
                .filter((tag) => !!tag);
            return <OrganizedSessionRow dragging={draggedSessionId === item.session.id} nested={item.nested} onDragEnd={finishSidebarDrag} onDragStart={startSessionDrag} onOpen={openSession} onOrganize={openOrganizer} selected={selectedSessionId === item.session.id} session={item.session} tags={sessionTags} />;
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
    }, [addTag, createSession, deleteList, dragOverList, dragOverListId, draggedListId, draggedSessionId, dropOntoList, expanded, finishSidebarDrag, leaveList, listColors, openCreate, openEdit, openOrganizer, openSession, organization.lists.length, organization.sessions, organization.tags, selectedSessionId, selectedTagId, sessionIndex, startListDrag, startSessionDrag, styles, theme.colors]);

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

const OrganizedSessionRow = React.memo(function OrganizedSessionRow({ dragging, nested, onDragEnd, onDragStart, onOpen, onOrganize, selected, session, tags }: { dragging: boolean; nested: boolean; onDragEnd: () => void; onDragStart: (sessionId: string, event: SidebarWebDragEvent) => void; onOpen: (session: SessionRowData) => void; onOrganize: (session: SessionRowData) => void; selected: boolean; session: SessionRowData; tags: SidebarTag[] }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const ref = React.useRef<View>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = ref.current as unknown as HTMLElement | null;
        if (!element) return;
        element.draggable = true;
        const handleDragStart = (event: DragEvent) => onDragStart(session.id, event);
        element.addEventListener('dragstart', handleDragStart);
        element.addEventListener('dragend', onDragEnd);
        return () => {
            element.draggable = false;
            element.removeEventListener('dragstart', handleDragStart);
            element.removeEventListener('dragend', onDragEnd);
        };
    }, [onDragEnd, onDragStart, session.id]);

    return (
        <View
            ref={ref}
            style={[styles.sessionRow, nested && styles.sessionRowNested, selected && styles.sessionRowSelected, dragging && styles.sessionRowDragging]}
            testID={`sidebar-drag-session-${session.id}`}
        >
            <Pressable aria-selected={selected} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => onOpen(session)} style={({ pressed }) => [styles.sessionMain, pressed && styles.sessionRowPressed]} testID={`organized-session-${session.id}`}>
                <Text numberOfLines={1} style={styles.sessionTitle}>{session.name}</Text>
                <Text numberOfLines={1} style={styles.sessionMeta}>{session.subtitle}</Text>
                {tags.length > 0 ? (
                    <View style={styles.sessionTags} testID={`organized-session-tags-${session.id}`}>
                        {tags.slice(0, 2).map((tag) => <View key={tag.id} style={styles.sessionTag} testID={`organized-session-tag-${tag.id}`}><Text numberOfLines={1} style={styles.sessionTagText}>#{tag.name}</Text></View>)}
                        {tags.length > 2 ? <Text style={styles.sessionTagMore}>+{tags.length - 2}</Text> : null}
                    </View>
                ) : null}
            </Pressable>
            <Pressable accessibilityLabel={t('sidebarLists.organizeSession')} onPress={() => onOrganize(session)} style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]} testID={`organize-session-${session.id}`}>
                <Feather color={theme.colors.textSecondary} name="tag" size={14} />
            </Pressable>
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
    }, [list, visible]);

    const save = () => {
        if (!canSave) return;
        const common = {
            id: list?.id ?? createSidebarOrganizationId('list'),
            name: name.trim(),
            color,
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
                {list ? <Pressable onPress={() => void deleteList()} style={[styles.button, styles.destructiveButton]} testID="sidebar-delete-list"><Text style={styles.destructiveButtonText}>{t('common.delete')}</Text></Pressable> : null}
                <Pressable onPress={onClose} style={[styles.button, styles.secondaryButton]} testID="sidebar-create-list-cancel"><Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text></Pressable>
                <Pressable disabled={!canSave} onPress={save} style={[styles.button, styles.primaryButton, !canSave && styles.buttonDisabled]} testID={list ? 'sidebar-edit-list-submit' : 'sidebar-create-list-submit'}><Text style={styles.primaryButtonText}>{list ? t('common.save') : t('common.create')}</Text></Pressable>
            </View>
        </DesktopDialogFrame>
    );
}

function Choice({ disabled = false, label, onPress, selected, testID }: { disabled?: boolean; label: string; onPress: () => void; selected: boolean; testID?: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return <Pressable aria-checked={selected} accessibilityLabel={label} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]} testID={testID}><Feather color={selected ? theme.colors.accent : theme.colors.textSecondary} name={selected ? 'check-circle' : 'circle'} size={14} /><Text style={styles.choiceText}>{label}</Text></Pressable>;
}
