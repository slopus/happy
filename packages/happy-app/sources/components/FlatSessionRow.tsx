import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { sessionKill } from '@/sync/ops';
import { type SessionState, formatLastSeen, vibingMessages } from '@/utils/sessionUtils';
import type { FlatSessionRowData } from '@/utils/flatSessionList';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import type { Theme } from '@/theme';
import { t } from '@/text';
import { RigGitLineChanges } from './RigGitLineChanges';

// Roughly three quarters of the row, the proportion a chat list uses: the row
// is 10 + 61 + 10, so 60 leaves an even 10 either side of the avatar.
const AVATAR_SIZE = 60;
const ROW_PADDING_LEFT = 16;
const AVATAR_GAP = 12;

/** The project / worktree line, and a branch mark matched to its cap height. */
const LOCATION_FONT_SIZE = 15;
const LOCATION_ICON_SIZE = LOCATION_FONT_SIZE - 1;

/**
 * The single colour the flat list paints, rows and page alike, so nothing reads
 * as a card sitting on a backdrop: plain white in light, the page's own black in
 * dark. `surface` is deliberately not used — in dark it is a lifted graphite
 * meant to contrast against exactly the backdrop this variant removes.
 */
export function flatListBackgroundColor(theme: Theme): string {
    return theme.dark ? theme.colors.groupped.background : '#FFFFFF';
}

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
    input_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

/**
 * One session in the flat home list: avatar, title, the project and worktree it
 * runs in, and its status. The row spans the full width on the page background
 * with a hairline under it, so the list reads as one continuous column rather
 * than a stack of project cards.
 */
export const FlatSessionRow = React.memo(({ row, selected, showBorder, archived }: {
    row: FlatSessionRowData;
    selected?: boolean;
    showBorder?: boolean;
    /** Retired work: the same row, faded back and drained of avatar colour. */
    archived?: boolean;
}) => {
    const { session, projectName, workspaceName } = row;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    // Greying out is about the machine, not the session's own socket. A session
    // idle since yesterday on a machine that is still up is ordinary work you
    // can pick back up, and drawing it as dead makes a healthy list look like a
    // graveyard. Only retired work, or work whose machine is actually gone,
    // fades.
    const faded = !!archived || session.machineOffline;

    // Archived work reads as retired whatever its connection says, so it never
    // pulses or shows a live colour. A request that is blocking on the user
    // outranks the ordinary unread-result badge; otherwise unread is blue and
    // steady, like an unread chat.
    const baseStatus = faded ? STATUS_CONFIG.disconnected : STATUS_CONFIG[session.state];
    const needsUserAction = session.state === 'permission_required' || session.state === 'input_required';
    const status = session.hasUnread && !faded && !needsUserAction
        ? { ...baseStatus, color: '#007AFF', dotColor: '#007AFF', isPulsing: false }
        : baseStatus;

    const vibingMessage = React.useMemo(() => (
        vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…'
    ), [session.state]);

    // The same `lastActivityAt` the flat list sorts on, so the stamps run in
    // the order the rows do.
    const timestamp = React.useMemo(
        () => formatSessionListTimestamp(session.lastActivityAt),
        [session.lastActivityAt],
    );

    const lastSeenText = session.activeAt
        ? t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) })
        : t('status.offline');

    // A session that is merely connected and idle has nothing worth saying: the
    // row already gives its name and where it runs, and "online" on every line
    // just repeats itself down the list. Only a state worth acting on — working,
    // waiting on you, or on a machine that is gone — earns the third line. A
    // session whose own socket dropped while its machine stayed up says nothing,
    // exactly like an idle one.
    const statusText = faded
        ? lastSeenText
        : session.state === 'input_required'
            ? t('status.inputRequired')
            : session.state === 'permission_required'
                ? t('status.permissionRequired')
                : session.hasUnread
                    ? t('status.unread')
                    : session.state === 'thinking'
                        ? vibingMessage
                        : null;

    const statusLine = [statusText, session.activitySummary].filter(Boolean).join(' · ');

    const [archiving, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
    });

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        performArchive();
    }, [performArchive]);

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

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    const content = (
        <Pressable
            style={[styles.row, selected && styles.rowSelected]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={[styles.avatar, faded && styles.avatarFaded]}>
                <Avatar
                    id={session.avatarId}
                    size={AVATAR_SIZE}
                    monochrome={faded}
                    flavor={session.flavor}
                    clientId={session.clientId}
                    badgeLocation="sessionList"
                />
            </View>

            <View style={[styles.content, faded && styles.contentFaded]}>
                <View style={styles.titleRow}>
                    <Text
                        style={[
                            styles.title,
                            faded ? styles.titleDisconnected : styles.titleConnected,
                        ]}
                        numberOfLines={1}
                    >
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge sessionId={session.id} style={styles.shortcutBadge} />
                    <Text style={styles.timestamp} numberOfLines={1}>
                        {timestamp}
                    </Text>
                </View>

                {/*
                  * The branch mark does the separating: the same icon the
                  * worktree picker uses, so the name after it reads as a
                  * worktree rather than as more path. Nested in the Text so it
                  * sits on the line's baseline and truncates with it.
                  */}
                <Text style={styles.location} numberOfLines={1}>
                    {projectName}
                    {workspaceName ? (
                        <Text>
                            {'  '}
                            <Ionicons
                                name="git-branch-outline"
                                size={LOCATION_ICON_SIZE}
                                color={theme.colors.textSecondary}
                            />
                            {' '}
                        </Text>
                    ) : null}
                    {workspaceName ?? ''}
                </Text>

                {/*
                  * Always occupied, even when an idle session has nothing to
                  * say: every row is the same height, so the list keeps an even
                  * rhythm instead of shrinking around whichever sessions happen
                  * to be quiet.
                  */}
                <View style={styles.statusRow}>
                    {statusLine !== '' && (
                        <>
                            <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                            <Text style={[styles.statusText, { color: status.color }]} numberOfLines={1}>
                                {statusLine}
                            </Text>
                        </>
                    )}
                    {/*
                      * The right end of the status line, where an unsent draft
                      * sits directly ahead of the line counts. On the avatar it
                      * only collided with the artwork, and this is where the
                      * eye already goes for what the session has to report.
                      */}
                    <View style={styles.statusMeta}>
                        {session.hasDraft && (
                            <Ionicons
                                name="create-outline"
                                size={13}
                                color={theme.colors.textSecondary}
                            />
                        )}
                        {session.gitChangedFiles !== null && (
                            <RigGitLineChanges
                                changedFiles={session.gitChangedFiles}
                                countsExact={session.gitCountsExact}
                                deletions={session.gitDeletions ?? 0}
                                insertions={session.gitInsertions ?? 0}
                            />
                        )}
                    </View>
                </View>
            </View>

            {showBorder && <View style={styles.divider} />}
        </Pressable>
    );

    if (!swipeEnabled) {
        return (
            <>
                {content}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            </>
        );
    }

    const renderRightActions = () => (
        <Pressable style={styles.swipeAction} onPress={handleArchive} disabled={archiving}>
            <Ionicons name="archive-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText} numberOfLines={2}>
                {t('sessionInfo.archiveSession')}
            </Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            overshootRight={false}
            enabled={!archiving}
        >
            {content}
        </Swipeable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        // Centred, not top-aligned: the avatar sits in the middle of the three
        // text lines the way a chat list draws it, rather than hanging off the
        // title.
        alignItems: 'center',
        paddingLeft: ROW_PADDING_LEFT,
        paddingRight: 16,
        paddingVertical: 10,
        backgroundColor: flatListBackgroundColor(theme),
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    avatar: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        marginRight: AVATAR_GAP,
    },
    // Faded rows keep the exact geometry of live ones and differ only by being
    // pulled back, so the list stays one column rather than two designs.
    avatarFaded: {
        opacity: 0.5,
    },
    contentFaded: {
        opacity: 0.6,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    title: {
        flex: 1,
        fontSize: 17,
        lineHeight: 22,
        ...Typography.default('semiBold'),
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
    // Never squeezed: the title gives way first, the way a chat list keeps the
    // time legible and truncates the name instead.
    timestamp: {
        flexShrink: 0,
        marginLeft: 8,
        fontSize: 13,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    location: {
        fontSize: LOCATION_FONT_SIZE,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 1,
        // Holds the line open when a quiet session has no status to show.
        minHeight: 18,
    },
    // Pushed to the right edge on its own, so the draft mark still lands there
    // on a quiet row that prints no status text to push it.
    statusMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 'auto',
    },
    statusText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('regular'),
    },
    // Sits on the row itself rather than the text column, so centring the
    // avatar cannot drag it up off the row's bottom edge. Starts where the text
    // does and runs to the screen edge, the way a chat list separates rows
    // without cutting under the avatar.
    divider: {
        position: 'absolute',
        left: ROW_PADDING_LEFT + AVATAR_SIZE + AVATAR_GAP,
        right: 0,
        bottom: 0,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));
