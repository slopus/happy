import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert, useSessionArchiveActions } from '@/hooks/useSessionQuickActions';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import type { ProjectGroupData } from '@/sync/projectGroups';
import { useLocalSettingMutable, type SessionRowData } from '@/sync/storage';
import { formatLastSeen, type SessionState } from '@/utils/sessionUtils';
import { shouldShowWorktreeDivider } from '@/utils/projectWorkspaceLayout';
import { t } from '@/text';

const STATUS_CONFIG: Record<SessionState, { dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

interface ProjectSectionProps {
    project: ProjectGroupData;
    /** Rendered next to the project name; pass null when every project shares one machine. */
    machineName?: string | null;
    selectedSessionId?: string;
    /** Sandbox override — production rows navigate to the session. */
    onPressSession?: (sessionId: string) => void;
}

/**
 * One project as a plain section header plus a single flat card of sessions.
 *
 * Worktrees do not nest: a session that lives in a non-primary tree carries its
 * branch as a trailing label instead, so the list never goes deeper than
 * project → session. Collapsing is per project and remembered locally; a
 * collapsed header keeps the session count and an attention dot so nothing
 * urgent hides behind the chevron.
 */
export const ProjectSection = React.memo(({ project, machineName, selectedSessionId, onPressSession }: ProjectSectionProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const sessions = React.useMemo(
        () => project.workspaces.flatMap((workspace) => workspace.sessions),
        [project.workspaces],
    );
    const [isHovered, setIsHovered] = React.useState(false);
    const [collapsedProjects, setCollapsedProjects] = useLocalSettingMutable('collapsedProjects');
    const collapsed = !!collapsedProjects[project.id];

    const toggleCollapsed = React.useCallback(() => {
        setCollapsedProjects({ ...collapsedProjects, [project.id]: !collapsed });
    }, [collapsed, collapsedProjects, project.id, setCollapsedProjects]);

    // Collapsing hides the rows, so whatever was asking for attention inside has
    // to survive on the header — otherwise a permission prompt disappears behind
    // a chevron.
    const attentionColor = React.useMemo(() => {
        if (sessions.some((session) => session.state === 'permission_required')) return '#FF9500';
        if (sessions.some((session) => session.hasUnread)) return '#007AFF';
        return null;
    }, [sessions]);

    const handleCreate = React.useCallback(() => {
        const first = sessions[0];
        if (!first) return;
        // Written, never read here, so the store is touched imperatively rather
        // than subscribed to — a section has no reason to re-render on drafts.
        const draft = useNewSessionDraft.getState();
        if (first.machineId) draft.setMachineId(first.machineId);
        if (first.path) draft.setPath(first.path);
        draft.setSessionType('simple');
        draft.setWorktreeKey(null);

        // Web has no home dock; there the full page is still the composer.
        if (Platform.OS === 'web') {
            router.navigate('/new');
            return;
        }
        draft.requestComposerFocus();
    }, [router, sessions]);

    return (
        <View style={styles.section}>
            <View
                style={styles.header}
                // @ts-ignore - Web only events
                onMouseEnter={() => setIsHovered(true)}
                // @ts-ignore - Web only events
                onMouseLeave={() => setIsHovered(false)}
            >
                <Pressable
                    style={styles.headerToggle}
                    onPress={toggleCollapsed}
                    accessibilityRole="button"
                    accessibilityLabel={project.name}
                    accessibilityState={{ expanded: !collapsed }}
                >
                    <Ionicons
                        name={collapsed ? 'chevron-forward' : 'chevron-down'}
                        size={12}
                        color={theme.colors.textSecondary}
                        style={styles.chevron}
                    />
                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {project.name}
                    </Text>
                    {machineName ? (
                        <Text style={styles.headerMachine} numberOfLines={1}>
                            {machineName}
                        </Text>
                    ) : null}
                    <View style={styles.headerSpacer} />
                    {collapsed && (
                        <>
                            {attentionColor && <StatusDot color={attentionColor} isPulsing={false} />}
                            <Text style={styles.headerCount}>{sessions.length}</Text>
                        </>
                    )}
                </Pressable>
                <Pressable
                    onPress={handleCreate}
                    accessibilityRole="button"
                    accessibilityLabel={`New session in ${project.name}`}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={[styles.addButton, { opacity: Platform.OS !== 'web' || isHovered ? 1 : 0 }]}
                >
                    <Ionicons name="add-outline" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {!collapsed && (
                <View style={styles.card}>
                    {project.workspaces.map((workspace, workspaceIndex) => (
                        <React.Fragment key={workspace.id || 'primary'}>
                            {/* A named workspace needs its label even when it is
                                first after filtering out the primary workspace. */}
                            {shouldShowWorktreeDivider(workspace.name) && (
                                <View style={styles.worktreeDivider}>
                                    <Ionicons
                                        name="git-branch-outline"
                                        size={11}
                                        color={theme.colors.textSecondary}
                                    />
                                    <Text style={styles.worktreeDividerText} numberOfLines={1}>
                                        {workspace.name}
                                    </Text>
                                    <View style={styles.worktreeDividerLine} />
                                </View>
                            )}
                            {workspace.sessions.map((session, index) => (
                                <ProjectSessionRow
                                    key={session.id}
                                    session={session}
                                    selected={session.id === selectedSessionId}
                                    showBorder={workspace.name === null
                                        ? !(workspaceIndex === 0 && index === 0)
                                        : index > 0}
                                    onPressSession={onPressSession}
                                />
                            ))}
                        </React.Fragment>
                    ))}
                </View>
            )}
        </View>
    );
});

const ProjectSessionRow = React.memo(({ session, selected, showBorder, onPressSession }: {
    session: SessionRowData;
    selected?: boolean;
    showBorder?: boolean;
    onPressSession?: (sessionId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web' && !onPressSession;
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const status = STATUS_CONFIG[session.state];
    const connected = status.isConnected;

    // Swipe files the session away (stopping it first if it is still running),
    // or brings it back when the row is being shown on the archive screen.
    const { archiveSession, archivingSession: archiving, unarchiveSession } = useSessionArchiveActions(session.id);

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        if (session.archived) {
            unarchiveSession();
        } else {
            archiveSession();
        }
    }, [archiveSession, session.archived, unarchiveSession]);

    const handlePress = React.useCallback(() => {
        if (onPressSession) {
            onPressSession(session.id);
            return;
        }
        navigateToSession(session.id);
    }, [navigateToSession, onPressSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    // One glyph carries the whole state: unread and attention-worthy sessions get
    // a dot, a waiting session with a draft gets the pencil, idle rows stay empty
    // so the eye only lands on rows that want something.
    const indicator = session.hasUnread
        ? <StatusDot color="#007AFF" isPulsing={false} />
        : session.hasDraft && session.state === 'waiting'
            ? <Ionicons name="create-outline" size={13} color={theme.colors.textSecondary} />
            : session.state === 'thinking' || session.state === 'permission_required'
                ? <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                : connected
                    ? <StatusDot color={theme.colors.textSecondary} isPulsing={false} />
                    : <StatusDot color={theme.colors.textSecondary} hollow />;

    const trailing = connected ? null : formatLastSeen(session.activeAt ?? Date.now(), false);

    const content = (
        <Pressable
            style={[
                styles.row,
                showBorder && styles.rowBorder,
                selected && styles.rowSelected,
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={styles.indicatorSlot}>{indicator}</View>
            <Text
                style={[styles.rowTitle, connected ? styles.rowTitleConnected : styles.rowTitleDisconnected]}
                numberOfLines={1}
            >
                {session.name}
            </Text>
            <SessionShortcutHintBadge sessionId={session.id} style={styles.shortcutBadge} />
            {trailing ? (
                <Text style={styles.rowTrailing} numberOfLines={1}>
                    {trailing}
                </Text>
            ) : null}
        </Pressable>
    );

    if (!swipeEnabled) {
        return (
            <>
                {content}
                {Platform.OS === 'web' && (
                    <SessionActionsPopover
                        anchor={actionsAnchor}
                        onClose={() => setActionsAnchor(null)}
                        sessionId={session.id}
                        visible={!!actionsAnchor}
                    />
                )}
            </>
        );
    }

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={() => (
                // Icon only: a 44pt row has no room for the label, which used to
                // wrap to two lines and get its second line clipped.
                <Pressable
                    style={styles.swipeAction}
                    onPress={handleArchive}
                    disabled={archiving}
                    accessibilityRole="button"
                    accessibilityLabel={session.archived ? t('archive.restore') : t('sessionInfo.archiveSession')}
                >
                    <Ionicons name={session.archived ? 'arrow-undo-outline' : 'archive-outline'} size={20} color="#FFFFFF" />
                </Pressable>
            )}
            overshootRight={false}
            enabled={!archiving}
        >
            {content}
        </Swipeable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        marginBottom: 4,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 14,
        paddingBottom: 6,
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    headerToggle: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    headerTitle: {
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    headerMachine: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        opacity: 0.7,
        ...Typography.default(),
    },
    headerSpacer: {
        flex: 1,
        minWidth: 8,
    },
    // Nudged up to sit on the text baseline rather than the line box.
    chevron: {
        marginTop: 1,
        marginRight: -1,
    },
    headerCount: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    addButton: {
        padding: 2,
    },
    card: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ web: 14, default: 16 }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    row: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        gap: 8,
        backgroundColor: 'transparent',
    },
    rowBorder: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    indicatorSlot: {
        width: 14,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        ...Typography.default('regular'),
    },
    rowTitleConnected: {
        color: theme.colors.text,
    },
    rowTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    rowTrailing: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        maxWidth: 110,
        flexShrink: 0,
        ...Typography.default(),
    },
    worktreeDivider: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingLeft: 14,
        paddingRight: 14,
        paddingTop: 10,
        paddingBottom: 4,
    },
    worktreeDividerText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    worktreeDividerLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    shortcutBadge: {
        flexShrink: 0,
    },
    swipeAction: {
        width: 76,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
}));
