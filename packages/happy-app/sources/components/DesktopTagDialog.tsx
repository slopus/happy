import * as React from 'react';
import {
    Modal as RNModal,
    Pressable,
    ScrollView,
    View,
    useWindowDimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import type { SessionRowData } from '@/sync/storage';
import type {
    SidebarListColor,
    SidebarTag,
    SidebarTagSessionGroup,
} from '@/sync/sidebarOrganization';
import { t } from '@/text';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { DesktopDialogFrame } from './DesktopDialogFrame';

export type DesktopTagActionsAnchor = {
    tagId: string;
    x: number;
    y: number;
};

type DesktopTagDetailActionsAnchor = {
    x: number;
    y: number;
};

export function DesktopTagActionsPopover({ anchor, onClose, onDelete, tag }: {
    anchor: DesktopTagActionsAnchor | null;
    onClose: () => void;
    onDelete: (tag: SidebarTag) => void;
    tag: SidebarTag | null;
}) {
    const { height, width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const deleteButtonRef = React.useRef<any>(null);
    if (!anchor || !tag) return null;

    const left = Math.max(12, Math.min(width - 196, anchor.x - 172));
    const top = Math.max(12, Math.min(height - 64, anchor.y + 8));
    return (
        <RNModal
            accessibilityLabel={`${t('sidebarLists.tagActions')} ${tag.name}`}
            animationType="none"
            onRequestClose={onClose}
            onShow={() => deleteButtonRef.current?.focus?.()}
            transparent
            visible
        >
            <View style={styles.popoverRoot}>
                <View
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                    onResponderRelease={onClose}
                    onStartShouldSetResponder={() => true}
                    style={styles.popoverBackdrop}
                    testID="tag-actions-backdrop"
                />
                <View style={[styles.popover, { left, top }]} testID={`tag-actions-popover-${tag.id}`}>
                    <Pressable
                        accessibilityLabel={`${t('sidebarLists.deleteTag')} ${tag.name}`}
                        accessibilityRole="button"
                        onPress={() => onDelete(tag)}
                        ref={deleteButtonRef}
                        style={({ pressed }) => [styles.popoverAction, pressed && styles.popoverActionPressed]}
                        testID={`sidebar-delete-tag-${tag.id}`}
                    >
                        <Feather color={theme.colors.deleteAction} name="trash-2" size={15} />
                        <Text style={styles.popoverDeleteText}>{t('sidebarLists.deleteTag')}</Text>
                    </Pressable>
                </View>
            </View>
        </RNModal>
    );
}

function DesktopTagDetailActionsPopover({ anchor, hideArchived, onClose, onDelete, onToggleArchived, tag }: {
    anchor: DesktopTagDetailActionsAnchor | null;
    hideArchived: boolean;
    onClose: () => void;
    onDelete: (tag: SidebarTag) => void;
    onToggleArchived: () => void;
    tag: SidebarTag;
}) {
    const { height, width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const toggleButtonRef = React.useRef<any>(null);
    if (!anchor) return null;

    const left = Math.max(12, Math.min(width - 228, anchor.x - 204));
    const top = Math.max(12, Math.min(height - 116, anchor.y + 8));
    const archivedAction = hideArchived ? t('sidebarLists.showArchived') : t('sidebarLists.hideArchived');
    return (
        <RNModal
            accessibilityLabel={`${t('sidebarLists.tagActions')} ${tag.name}`}
            animationType="none"
            onRequestClose={onClose}
            onShow={() => toggleButtonRef.current?.focus?.()}
            transparent
            visible
        >
            <View style={styles.popoverRoot}>
                <View
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                    onResponderRelease={onClose}
                    onStartShouldSetResponder={() => true}
                    style={styles.popoverBackdrop}
                    testID="tag-detail-actions-backdrop"
                />
                <View style={[styles.popover, styles.detailPopover, { left, top }]} testID={`tag-detail-actions-popover-${tag.id}`}>
                    <Pressable
                        accessibilityLabel={archivedAction}
                        accessibilityRole="button"
                        onPress={onToggleArchived}
                        ref={toggleButtonRef}
                        style={({ pressed }) => [styles.popoverAction, pressed && styles.popoverActionPressed]}
                        testID="tag-detail-toggle-archived-visibility"
                    >
                        <Feather color={theme.colors.text} name={hideArchived ? 'eye' : 'eye-off'} size={16} />
                        <Text style={styles.popoverActionText}>{archivedAction}</Text>
                    </Pressable>
                    <View style={styles.popoverDivider} />
                    <Pressable
                        accessibilityLabel={`${t('sidebarLists.deleteTag')} ${tag.name}`}
                        accessibilityRole="button"
                        onPress={() => onDelete(tag)}
                        style={({ pressed }) => [styles.popoverAction, pressed && styles.popoverActionPressed]}
                        testID={`tag-detail-delete-${tag.id}`}
                    >
                        <Feather color={theme.colors.deleteAction} name="trash-2" size={15} />
                        <Text style={styles.popoverDeleteText}>{t('sidebarLists.deleteTag')}</Text>
                    </Pressable>
                </View>
            </View>
        </RNModal>
    );
}

export function DesktopTagDetailDialog({ groups, hideArchived, listColors, onClose, onDelete, onHideArchivedChange, selectedSessionId, sessionCount, tag }: {
    groups: SidebarTagSessionGroup<SessionRowData>[];
    hideArchived: boolean;
    listColors: Record<SidebarListColor, string>;
    onClose: () => void;
    onDelete: (tag: SidebarTag) => void;
    onHideArchivedChange: (hideArchived: boolean) => void;
    selectedSessionId: string | null;
    sessionCount: number;
    tag: SidebarTag | null;
}) {
    const { theme } = useUnistyles();
    const [collapsedGroupIds, setCollapsedGroupIds] = React.useState<Set<string>>(() => new Set());
    const [actionsAnchor, setActionsAnchor] = React.useState<DesktopTagDetailActionsAnchor | null>(null);

    React.useEffect(() => {
        setCollapsedGroupIds(new Set());
        setActionsAnchor(null);
    }, [tag?.id]);

    if (!tag) return null;
    const loadedSessionCount = groups.reduce((total, group) => total + group.sessions.length, 0);
    const listCount = groups.filter((group) => group.kind !== 'archived').length;
    const visibleGroups = hideArchived ? groups.filter((group) => group.kind !== 'archived') : groups;
    const hasHiddenArchived = hideArchived && groups.some((group) => group.kind === 'archived');
    const hasUnloadedAssociations = sessionCount > 0 && loadedSessionCount === 0;
    const isPartiallyLoaded = loadedSessionCount > 0 && loadedSessionCount < sessionCount;
    const toggleGroup = (groupId: string) => {
        setCollapsedGroupIds((current) => {
            const next = new Set(current);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    };

    return (
        <DesktopDialogFrame
            headerActions={(
                <Pressable
                    accessibilityLabel={`${t('sidebarLists.tagActions')} ${tag.name}`}
                    accessibilityRole="button"
                    onPress={(event: any) => {
                        const nativeEvent = event?.nativeEvent ?? {};
                        const triggerBounds = typeof event?.currentTarget?.getBoundingClientRect === 'function'
                            ? event.currentTarget.getBoundingClientRect()
                            : null;
                        setActionsAnchor({
                            x: triggerBounds?.right ?? nativeEvent.pageX ?? nativeEvent.clientX ?? 0,
                            y: triggerBounds?.bottom ?? nativeEvent.pageY ?? nativeEvent.clientY ?? 0,
                        });
                    }}
                    style={({ pressed }) => [styles.headerAction, pressed && styles.popoverActionPressed]}
                    testID={`tag-detail-menu-${tag.id}`}
                >
                    <Feather color={theme.colors.textSecondary} name="more-horizontal" size={18} />
                </Pressable>
            )}
            maxWidth={720}
            onClose={onClose}
            testID={`tag-detail-dialog-${tag.id}`}
            title={`#${tag.name}`}
            visible
        >
            <View style={styles.detailToolbar}>
                <View style={styles.detailMetaGroup}>
                    <Feather color={theme.colors.textSecondary} name="folder" size={14} />
                    <Text style={styles.detailMeta}>{t('sidebarLists.groupedByList')}</Text>
                    <Text style={styles.detailMetaDivider}>·</Text>
                    <Text style={styles.detailMeta} testID={`tag-detail-meta-${tag.id}`}>
                        {t('sidebarLists.tagDetailsMeta', { sessionCount, listCount })}
                    </Text>
                </View>
            </View>
            <ScrollView contentContainerStyle={styles.detailContent} style={styles.detailScroll}>
                {isPartiallyLoaded ? (
                    <Text style={styles.loadNotice} testID="tag-detail-partially-loaded">
                        {t('sidebarLists.tagSessionsPartiallyLoaded', { loadedCount: loadedSessionCount, sessionCount })}
                    </Text>
                ) : null}
                {visibleGroups.length === 0 ? (
                    <Text
                        style={styles.empty}
                        testID={hasHiddenArchived
                            ? 'tag-detail-archived-hidden'
                            : hasUnloadedAssociations
                                ? 'tag-detail-sessions-not-loaded'
                                : undefined}
                    >
                        {t(hasHiddenArchived
                            ? 'sidebarLists.archivedSessionsHidden'
                            : hasUnloadedAssociations
                                ? 'sidebarLists.tagSessionsNotLoaded'
                                : 'sidebarLists.noTaggedSessions')}
                    </Text>
                ) : null}
                {visibleGroups.map((group) => {
                    const expanded = !collapsedGroupIds.has(group.id);
                    const label = group.kind === 'archived'
                        ? t('sidebarLists.archived')
                        : group.list?.name ?? t('sidebarLists.unassigned');
                    const color = group.list ? listColors[group.list.color] : theme.colors.textSecondary;
                    return (
                        <View key={group.id} style={styles.group} testID={`tag-detail-group-${group.id}`}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ expanded }}
                                onPress={() => toggleGroup(group.id)}
                                style={({ pressed }) => [styles.groupHeader, pressed && styles.groupHeaderPressed]}
                                testID={`tag-detail-toggle-${group.id}`}
                            >
                                <Feather color={theme.colors.textSecondary} name={expanded ? 'chevron-down' : 'chevron-right'} size={15} />
                                <Feather color={color} name={group.kind === 'archived' ? 'archive' : group.list?.kind === 'agent' ? 'cpu' : group.list ? 'folder' : 'inbox'} size={15} />
                                <Text numberOfLines={1} style={styles.groupTitle}>{label}</Text>
                                <Text style={styles.groupCount}>{group.sessions.length}</Text>
                            </Pressable>
                            {expanded ? group.sessions.map((session) => (
                                <View key={session.id} style={styles.session} testID={`tag-detail-session-${session.id}`}>
                                    <CompactSessionRow
                                        selected={selectedSessionId === session.id}
                                        session={session}
                                        showLocation
                                    />
                                </View>
                            )) : null}
                        </View>
                    );
                })}
            </ScrollView>
            <DesktopTagDetailActionsPopover
                anchor={actionsAnchor}
                hideArchived={hideArchived}
                onClose={() => setActionsAnchor(null)}
                onDelete={(selectedTag) => {
                    setActionsAnchor(null);
                    onDelete(selectedTag);
                }}
                onToggleArchived={() => {
                    setActionsAnchor(null);
                    onHideArchivedChange(!hideArchived);
                }}
                tag={tag}
            />
        </DesktopDialogFrame>
    );
}

const styles = StyleSheet.create((theme) => ({
    popoverRoot: { flex: 1 },
    popoverBackdrop: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    popover: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        minWidth: 184,
        overflow: 'hidden',
        position: 'absolute',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
    },
    detailPopover: { minWidth: 216 },
    popoverAction: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44, paddingHorizontal: 14 },
    popoverActionPressed: { backgroundColor: theme.colors.surfacePressed },
    popoverDivider: { backgroundColor: theme.colors.divider, height: StyleSheet.hairlineWidth },
    popoverActionText: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    popoverDeleteText: { color: theme.colors.deleteAction, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    detailToolbar: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        minHeight: 46,
        paddingHorizontal: 16,
    },
    detailMetaGroup: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, minWidth: 0 },
    detailMeta: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    detailMetaDivider: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    headerAction: { alignItems: 'center', borderRadius: 7, height: 32, justifyContent: 'center', width: 32 },
    detailScroll: { maxHeight: 620 },
    detailContent: { paddingBottom: 12, paddingTop: 8 },
    loadNotice: { color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 18, paddingVertical: 8, ...Typography.default() },
    empty: { color: theme.colors.textSecondary, fontSize: 13, paddingHorizontal: 18, paddingVertical: 24, ...Typography.default() },
    group: { borderBottomColor: theme.colors.divider, borderBottomWidth: StyleSheet.hairlineWidth },
    groupHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 16 },
    groupHeaderPressed: { backgroundColor: theme.colors.surfacePressed },
    groupTitle: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    groupCount: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    session: { marginHorizontal: 8 },
}));
