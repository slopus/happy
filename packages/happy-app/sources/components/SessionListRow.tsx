import React from 'react';
import { View, Pressable, Platform, Animated } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { SessionRowData, useSessionGitStatus } from '@/sync/storage';
import { type SessionState } from '@/utils/sessionUtils';
import { getRepoPath, getWorktreeName, isWorktreePath } from '@/utils/worktreePath';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useRouter } from 'expo-router';
import { useSessionActionAlert, useSessionArchiveActions } from '@/hooks/useSessionQuickActions';
import { sessionSetPinned } from '@/sync/ops';
import { t } from '@/text';
import { StatusDot } from './StatusDot';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { sessionRowLayout } from './sessionRowLayout';

const SWIPE_ACTION_WIDTH = 84;

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

/**
 * Second line of a row: which project the session runs in, and the worktree
 * when it is not the primary one — "happy · feature-x". The live state is
 * carried by the dot, so this line stays a stable identity rather than
 * flipping between "online" and "last seen …".
 */
function sessionProjectLabel(session: SessionRowData, worktreeName: string | null): string {
    // The path may point inside a worktree; the project is the repository, so
    // its name comes from the repo root — otherwise a worktree session reads
    // "calm-meadow · calm-meadow".
    const project = session.projectName
        || (session.path ? getRepoPath(session.path) : '').split(/[/\\]/).filter(Boolean).pop()
        || session.subtitle
        || '';
    if (!project) return worktreeName ?? '';
    return worktreeName ? `${project} · ${worktreeName}` : project;
}

/**
 * Name of the git worktree the session runs in, or null in the primary tree.
 * Rig reports it as workspace metadata; Happy CLI sessions only carry the path,
 * so it has to be read back out of the worktree naming convention.
 */
function sessionWorktreeName(session: SessionRowData): string | null {
    if (session.workspaceName) return session.workspaceName;
    if (session.path && isWorktreePath(session.path)) return getWorktreeName(session.path);
    return null;
}

/**
 * The one session row used everywhere in the sessions list — flat date groups
 * and project groups alike. Keeping it single is the point: two near-copies is
 * how the two lists drifted into different paddings, type sizes and second
 * lines in the first place.
 */
export const SessionListRow = React.memo(({ session, selected, showDivider }: {
    session: SessionRowData;
    selected?: boolean;
    showDivider?: boolean;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const gitStatus = useSessionGitStatus(session.id);
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';

    const baseStatus = STATUS_CONFIG[session.state];
    // Override to solid blue when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, color: '#007AFF', dotColor: '#007AFF', isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;

    const linesAdded = gitStatus?.unstagedLinesAdded ?? 0;
    const linesRemoved = gitStatus?.unstagedLinesRemoved ?? 0;

    // Only the worktree earns a place here. The primary checkout's branch is
    // not what tells two sessions apart — every session in a project shares it
    // — so a row outside a worktree names just its project.
    const worktreeName = sessionWorktreeName(session);

    // Swipe files the session away (stopping it first if it is still running),
    // or brings it back when the row is being shown on the archive screen.
    const { archiveSession, archivingSession, unarchiveSession } = useSessionArchiveActions(session.id);

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        if (session.archived) {
            unarchiveSession();
        } else {
            archiveSession();
        }
    }, [archiveSession, session.archived, unarchiveSession]);

    const handleOpenDetails = React.useCallback(() => {
        swipeableRef.current?.close();
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const handleTogglePin = React.useCallback(() => {
        swipeableRef.current?.close();
        sessionSetPinned(session.id, !session.pinned);
    }, [session.id, session.pinned]);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    // Long press opens the JS action sheet rather than a native menu wrapper:
    // a Compose/SwiftUI host per row never reports its size back to the RN
    // layout tree, which collapsed rows to zero height and broke the
    // virtualized list's scroll offsets.
    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    // Idle rows split on the connection: a session that is still up and simply
    // has nothing to say keeps a filled dot, one that is gone goes hollow, so
    // "here but quiet" and "not running" stop looking identical.
    let indicator: React.ReactNode = status.isConnected
        ? <StatusDot color={theme.colors.textSecondary} isPulsing={false} />
        : <StatusDot color={theme.colors.textSecondary} hollow />;
    if (session.hasUnread) {
        indicator = <StatusDot color={status.dotColor} isPulsing={false} />;
    } else if (session.state === 'waiting' && session.hasDraft) {
        indicator = <Ionicons name="create-outline" size={14} color={theme.colors.textSecondary} />;
    } else if (session.state === 'permission_required' || session.state === 'thinking') {
        indicator = <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />;
    }

    const row = (
        <Pressable
            style={[styles.row, selected && styles.rowSelected]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={styles.content}>
                {/* The dot sits inside the title row so it centres on the
                    title's line, not on the two-line block as a whole. */}
                <View style={styles.titleRow}>
                    <View style={styles.indicatorSlot}>
                        {indicator}
                    </View>
                    <Text
                        style={[styles.title, status.isConnected ? styles.titleConnected : styles.titleDisconnected]}
                        numberOfLines={1}
                    >
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge sessionId={session.id} style={styles.shortcutBadge} />
                </View>

                <View style={styles.subtitleRow}>
                    <Text style={styles.subtitle} numberOfLines={1}>
                        {sessionProjectLabel(session, worktreeName)}
                    </Text>
                    {linesAdded > 0 && (
                        <Text style={styles.addedText}>+{linesAdded}</Text>
                    )}
                    {linesRemoved > 0 && (
                        <Text style={styles.removedText}>-{linesRemoved}</Text>
                    )}
                </View>
            </View>
        </Pressable>
    );

    // The divider is a sibling of the row rather than a border on it, so it can
    // start at the text column instead of running the full width of the screen.
    const divider = showDivider ? <View style={styles.divider} /> : null;

    if (!swipeEnabled) {
        return (
            <>
                {row}
                {divider}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            </>
        );
    }

    // Ordered least to most destructive, so the finger has to travel furthest
    // for the one action that ends the session. Each button slides in from the
    // screen edge to its slot — the row uncovers a moving stack rather than a
    // preassembled block, so the farther a button sits from the edge, the
    // farther it travels.
    const renderRightActions = (progress: Animated.AnimatedInterpolation<number>) => {
        const actions = [
            {
                key: 'details',
                icon: 'information-circle-outline' as const,
                label: t('profile.details'),
                onPress: handleOpenDetails,
                style: styles.swipeActionDetails,
                color: theme.colors.text,
            },
            {
                key: 'pin',
                icon: session.pinned ? ('pin' as const) : ('pin-outline' as const),
                label: session.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
                onPress: handleTogglePin,
                style: styles.swipeActionPin,
                color: '#FFFFFF',
            },
            {
                key: 'archive',
                icon: session.archived ? ('arrow-undo-outline' as const) : ('archive-outline' as const),
                label: session.archived ? t('archive.restore') : t('common.archive'),
                onPress: handleArchive,
                disabled: archivingSession,
                style: styles.swipeActionArchive,
                color: '#FFFFFF',
            },
        ];
        return (
            <View style={styles.swipeActions}>
                {actions.map((action, index) => (
                    <Animated.View
                        key={action.key}
                        style={{
                            height: '100%',
                            transform: [{
                                translateX: progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [SWIPE_ACTION_WIDTH * (actions.length - index), 0],
                                }),
                            }],
                        }}
                    >
                        <Pressable style={[styles.swipeAction, action.style]} onPress={action.onPress} disabled={action.disabled}>
                            <Ionicons name={action.icon} size={20} color={action.color} />
                            <Text style={[styles.swipeActionText, { color: action.color }]} numberOfLines={2}>
                                {action.label}
                            </Text>
                        </Pressable>
                    </Animated.View>
                ))}
            </View>
        );
    };

    return (
        <>
            <Swipeable
                ref={swipeableRef}
                renderRightActions={renderRightActions}
                overshootRight={false}
                enabled={!archivingSession}
            >
                {row}
            </Swipeable>
            {divider}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        minHeight: sessionRowLayout.minHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: sessionRowLayout.gutter,
        paddingVertical: 10,
        backgroundColor: 'transparent',
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    divider: {
        marginLeft: sessionRowLayout.textInset,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    title: {
        fontSize: 16,
        lineHeight: 21,
        flex: 1,
        ...Typography.default(),
    },
    titleConnected: {
        color: theme.colors.text,
    },
    titleDisconnected: {
        color: theme.colors.textSecondary,
    },
    shortcutBadge: {
        flexShrink: 0,
        marginLeft: 8,
    },
    indicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: sessionRowLayout.indicatorSize,
        height: sessionRowLayout.indicatorSize,
        marginRight: sessionRowLayout.indicatorGap,
    },
    subtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginLeft: sessionRowLayout.subtitleIndent,
        marginTop: 2,
    },
    subtitle: {
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    addedText: {
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.gitAddedText,
        flexShrink: 0,
        ...Typography.default(),
    },
    removedText: {
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.gitRemovedText,
        flexShrink: 0,
        ...Typography.default(),
    },
    swipeActions: {
        flexDirection: 'row',
        height: '100%',
    },
    swipeAction: {
        width: SWIPE_ACTION_WIDTH,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    swipeActionDetails: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    swipeActionPin: {
        backgroundColor: '#007AFF',
    },
    swipeActionArchive: {
        backgroundColor: theme.colors.deleteAction,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));
