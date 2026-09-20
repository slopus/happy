import * as React from 'react';
import {
    FlatList,
    LayoutAnimation,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    StyleProp,
    UIManager,
    View,
    ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Animated, {
    Easing,
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    storage,
    useAllMachines,
    useLocalSetting,
    useSessionGitStatus,
    useSettingMutable,
    type SessionRowData,
} from '@/sync/storage';
import { useHasArchivedSessions, useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import {
    buildProjectHomeRows,
    workspaceOrigin,
    type ProjectHomeEntry,
    type ProjectHomeRow,
    type ProjectWorktree,
    type WorktreeToggle,
} from '@/utils/projectHomeList';
import { useSessionPressHandlers } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { resolveFlatSessionRowPresentation } from '@/utils/flatSessionRowPresentation';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import { compactCount, visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';
import { requestHomeDockFocus } from './homeDockFocus';
import { hapticsLight } from './haptics';
import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';
import { ShimmerText } from './ShimmerText';
import { HomeListHeader } from './HomeListHeader';
import { layout } from './layout';

// Every row starts with the same avatar and name columns. Disclosure controls
// live at the trailing edge so rows without worktrees do not reserve space for
// a control they never draw.
const ROW_PADDING_X = 16;
/** The avatar's column, and the one the worktree tree line runs down. */
const AVATAR_SIZE = 28;
const AVATAR_GAP = 12;
const PROJECT_ROW_HEIGHT = 52;
const WORKTREE_ROW_HEIGHT = 48;
const BOT_ROW_HEIGHT = 48;
// The tree and the machine rule were a hairline in the divider grey, which on a
// light screen all but vanished. Twice the hairline, in the grey the machine
// name beside them already uses.
const TREE_LINE_WIDTH = StyleSheet.hairlineWidth * 2;

// Android draws nothing for LayoutAnimation until it is asked to. The call is
// gone on the New Architecture, where layout animations are always available.
if (Platform.OS === 'android') {
    UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

/**
 * Showing or hiding a project's workspaces, animated.
 *
 * The rows used to appear and disappear between one frame and the next, which
 * reads as the list jumping rather than as the project opening. Sliding what is
 * below them and fading the new rows in over that says which rows are new and
 * where they came from.
 */
const WORKSPACE_DISCLOSURE = {
    duration: 220,
    create: { type: 'easeInEaseOut', property: 'opacity' },
    update: { type: 'easeInEaseOut' },
    delete: { type: 'easeInEaseOut', property: 'opacity' },
} as const;

export interface ProjectHomeListLayout {
    topContentInset?: number;
    scrollIndicatorTopInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/**
 * The home screen grouped by project: one card per project, going by the
 * project's name, with that project's worktrees nested under it on a tree line
 * dropped from its avatar.
 *
 * The project's own checkout is the card itself rather than a row of its own,
 * so the main chat is always one tap away — the chevron folds the worktrees
 * away and never the card. Chats are not rows here at all; a checkout opens its
 * most recent chat and the rest sit beside it as tabs on the session screen.
 *
 * The archive trails the projects as a flat, date-grouped tail. Retired chats
 * stay out of the project cards, but the divider below them can reveal or hide
 * the same archive that the flat home list shows.
 */
export const ProjectHomeList = React.memo((props: ProjectHomeListLayout) => {
    const data = useVisibleSessionListViewData();
    const machines = useAllMachines();
    const expanded = useLocalSetting('expandedProjects');
    const hasArchivedSessions = useHasArchivedSessions();
    // Stored under its original `hideInactiveSessions` key — synced settings
    // have no rename migration — but it hides archived sessions only.
    const [archiveHidden, setArchiveHidden] = useSettingMutable('hideInactiveSessions');

    const rows = React.useMemo(() => buildProjectHomeRows({
        data: data ?? [],
        machines,
        unknownMachineText: t('status.unknown'),
        expanded,
        labels: { bots: t('sidebar.bots'), projects: t('sidebar.projects') },
        hasArchivedSessions,
        archiveHidden,
    }), [archiveHidden, expanded, data, hasArchivedSessions, machines]);

    const toggleArchive = React.useCallback(() => {
        setArchiveHidden(!archiveHidden);
    }, [archiveHidden, setArchiveHidden]);

    // Reads the record it is about to change from the store rather than closing
    // over it: the callback then never changes identity, and showing a
    // project's workspaces does not re-render every row in the list to hand
    // them a new one.
    const toggle = React.useCallback((projectId: string) => {
        if (Platform.OS !== 'web') hapticsLight();
        // The press finishes first. Rebuilding the list is every row in the
        // account's worth of work, and doing it in the tick the finger came up
        // in holds the release — the highlight, and the frame the disclosure
        // animates from — behind it. A frame later costs nothing that is felt
        // and buys a clean one to start on.
        requestAnimationFrame(() => {
            const current = storage.getState().localSettings.expandedProjects;
            // Immediately before the change it animates, which is the only
            // place LayoutAnimation can be armed from.
            if (Platform.OS !== 'web') LayoutAnimation.configureNext(WORKSPACE_DISCLOSURE);
            storage.getState().applyLocalSettings({
                expandedProjects: { ...current, [projectId]: !current[projectId] },
            });
        });
    }, []);

    return <ProjectHomeListView rows={rows} onToggle={toggle} onToggleArchive={toggleArchive} {...props} />;
});

/**
 * The same screen driven by rows handed to it, so a preview or a test can
 * exercise the real list without a store behind it.
 */
export const ProjectHomeListView = React.memo(({
    rows,
    onToggle,
    onToggleArchive,
    topContentInset = 0,
    scrollIndicatorTopInset = 0,
    bottomContentInset = 128,
    onScroll,
}: ProjectHomeListLayout & {
    rows: ProjectHomeRow[];
    onToggle: (projectId: string) => void;
    onToggleArchive?: () => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    const keyExtractor = React.useCallback((row: ProjectHomeRow) => {
        switch (row.type) {
            case 'section': return `section-${row.id}`;
            case 'machine': return `machine-${row.machineId ?? 'unknown'}`;
            case 'bot': return `bot-${row.session.id}`;
            case 'project': return `project-${row.project.id}`;
            case 'worktree': return `worktree-${row.worktree.id}`;
            case 'worktreeToggle': return `worktree-toggle-${row.toggle.projectId}`;
            case 'archiveToggle': return 'archive-toggle';
            case 'archiveHeader': return `archive-header-${row.title}`;
            case 'archived': return `archived-${row.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item }: { item: ProjectHomeRow }) => {
        switch (item.type) {
            case 'section':
                return (
                    <View style={styles.section}>
                        <Text style={styles.sectionText}>{item.label}</Text>
                    </View>
                );
            case 'machine':
                return (
                    <View style={styles.machineHeader}>
                        <Ionicons name="desktop-outline" size={12} color={theme.colors.textSecondary} />
                        <Text style={styles.machineHeaderText} numberOfLines={1}>
                            {item.machineName}
                        </Text>
                        <View style={styles.machineHeaderLine} />
                    </View>
                );
            case 'bot':
                return <BotRow session={item.session} />;
            case 'project':
                return <ProjectRow project={item.project} />;
            case 'worktree':
                return <WorktreeRow worktree={item.worktree} last={item.last} />;
            case 'worktreeToggle':
                return <WorktreeToggleRow toggle={item.toggle} onToggle={onToggle} />;
            case 'archiveToggle':
                return (
                    <Pressable
                        onPress={onToggleArchive}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !item.hidden }}
                        style={({ pressed }) => [styles.archiveToggle, pressed && styles.pressed]}
                    >
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );
            case 'archiveHeader':
                return (
                    <View style={styles.section}>
                        <Text style={styles.sectionText}>{item.title}</Text>
                    </View>
                );
            case 'archived':
                return <ChatRow session={item.session} archived />;
        }
    }, [onToggle, onToggleArchive, styles, theme]);

    const ListHeader = React.useCallback(() => (
        <HomeListHeader
            style={topContentInset > 0 ? styles.updateBanner : undefined}
            headerStyle={topContentInset > 0 ? styles.updateBannerHeader : undefined}
        />
    ), [styles, topContentInset]);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={rows}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    ListHeaderComponent={ListHeader}
                    contentContainerStyle={{
                        paddingTop: topContentInset,
                        paddingBottom: safeArea.bottom + bottomContentInset,
                        maxWidth: layout.maxWidth,
                    }}
                    automaticallyAdjustsScrollIndicatorInsets={scrollIndicatorTopInset === 0}
                    scrollIndicatorInsets={scrollIndicatorTopInset > 0 ? { top: scrollIndicatorTopInset } : undefined}
                    windowSize={5}
                    maxToRenderPerBatch={12}
                    initialNumToRender={16}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                />
            </View>
        </View>
    );
});

const HIGHLIGHT_IN = {
    duration: 70,
    easing: Easing.out(Easing.quad),
    reduceMotion: ReduceMotion.System,
};
const HIGHLIGHT_OUT = {
    duration: 240,
    easing: Easing.out(Easing.quad),
    reduceMotion: ReduceMotion.System,
};

type RowPressableProps = Omit<React.ComponentProps<typeof Pressable>, 'children' | 'style'> & {
    children: React.ReactNode;
    style: StyleProp<ViewStyle>;
};

/**
 * A row, with its press highlight faded rather than flipped.
 *
 * `({ pressed }) => [row, pressed && highlight]` paints the background on the
 * press and takes it away on the release, and a tap is short: what is actually
 * seen is a grey rectangle blinking on and off. It is worst on the row that
 * shows a project's workspaces, where the release rebuilds the list in the same
 * tick, so the frame that takes the grey away can arrive late and the blink
 * turns into a stutter.
 *
 * So the highlight is a layer of its own, animated: up at once, gone over a
 * quarter of a second, the way a table cell behaves everywhere else. It runs on
 * the UI thread, so a busy render cannot leave it stranded on screen.
 */
const RowPressable = ({ children, style, onPressIn, onPressOut, ...rest }: RowPressableProps) => {
    const { theme } = useUnistyles();
    const held = useSharedValue(0);
    const highlight = useAnimatedStyle(() => ({ opacity: held.value }));

    const handlePressIn = React.useCallback((event: Parameters<NonNullable<typeof onPressIn>>[0]) => {
        held.value = withTiming(1, HIGHLIGHT_IN);
        onPressIn?.(event);
    }, [held, onPressIn]);

    const handlePressOut = React.useCallback((event: Parameters<NonNullable<typeof onPressOut>>[0]) => {
        held.value = withTiming(0, HIGHLIGHT_OUT);
        onPressOut?.(event);
    }, [held, onPressOut]);

    return (
        <Pressable {...rest} onPressIn={handlePressIn} onPressOut={handlePressOut} style={style}>
            <Animated.View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: theme.colors.surfacePressed },
                    highlight,
                ]}
            />
            {children}
        </Pressable>
    );
};

/**
 * A row's name. ShimmerText wraps its text in a shrink-wrapped, top-aligned
 * view, so the flex that makes the name claim the middle of the row has to live
 * out here — on the box around it — or the trailing column wraps under it.
 */
const RowName = React.memo(({ text, working, style }: {
    text: string;
    working: boolean;
    style: object;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.nameLane}>
            {working ? (
                <ShimmerText
                    text={text}
                    style={style}
                    baseColor={theme.colors.textSecondary}
                    highlightColor={theme.colors.text}
                />
            ) : (
                <Text style={style} numberOfLines={1}>{text}</Text>
            )}
        </View>
    );
});

/**
 * The line changes a checkout carries. Happy Agent publishes the whole
 * checkout's comparison with its merge base; a working-tree-only count from the
 * daemon stands in until it has.
 */
function useGitChanges(session: SessionRowData | null) {
    const gitStatus = useSessionGitStatus(session?.id ?? '');
    return React.useMemo(() => {
        if (!session) return null;
        if (session.gitChangedFiles !== null) {
            return visibleRigGitLineChanges({
                changedFiles: session.gitChangedFiles,
                countsExact: session.gitCountsExact,
                deletions: session.gitDeletions ?? 0,
                insertions: session.gitInsertions ?? 0,
            });
        }
        if (gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesRemoved > 0)) {
            return { approximate: false, insertions: gitStatus.linesAdded, deletions: gitStatus.linesRemoved };
        }
        return null;
    }, [session, gitStatus]);
}

const GitChanges = React.memo(({ changes }: {
    changes: { approximate: boolean; insertions: number; deletions: number } | null;
}) => {
    const styles = stylesheet;
    if (!changes || (changes.insertions <= 0 && changes.deletions <= 0)) return null;
    return (
        <View style={styles.changes}>
            {changes.approximate && <Text style={styles.approximate}>≈</Text>}
            {changes.insertions > 0 && (
                <Text style={styles.added}>+{compactCount(changes.insertions)}</Text>
            )}
            {changes.deletions > 0 && (
                <Text style={styles.removed}>-{compactCount(changes.deletions)}</Text>
            )}
        </View>
    );
});

/**
 * A project's card. It goes by the project's name alone and opens the project's
 * own checkout.
 *
 * The only control at its trailing edge is the `+` that creates a workspace.
 * The card used to carry a disclosure chevron beside it, which put two small
 * round controls side by side — one adding a row under the card, one hiding
 * every row under it. Deciding how much of the list to show now belongs to a
 * row at the bottom of the worktrees, where what it governs is in plain sight.
 */
const ProjectRow = React.memo(({ project }: {
    project: ProjectHomeEntry;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const session = project.session;
    const pressHandlers = useSessionPressHandlers(session?.id ?? '');
    const changes = useGitChanges(session);
    const showsTree = project.worktreeCount > 0;
    // A project whose own checkout has no chat still has worktrees that name
    // its machine, and — for Happy Agent — the project itself, so the card can
    // grow another workspace without a chat of its own to ask from.
    const origin = session ?? project.avatarSession;
    const place = origin ? workspaceOrigin(origin) : null;

    // Start the composer in this project's "Create New" workspace choice.
    // Selecting a machine and place first matters because those setters clear
    // the more specific checkout selection beneath them.
    const createWorkspace = React.useCallback(() => {
        if (!place) return;
        const draft = useNewSessionDraft.getState();
        draft.setMachineId(place.machineId);
        if (place.projectId) {
            // Happy Agent's projects are catalog identities: a worktree's
            // directory says nothing about where its project lives.
            draft.setAgentType('rig');
            draft.setProjectId(place.projectId);
        } else {
            draft.setPath(place.path);
        }
        draft.setSessionType('worktree');
        draft.setWorktreeKey(null);

        if (!requestHomeDockFocus()) router.navigate('/new');
    }, [router, place?.machineId, place?.projectId, place?.path]);

    const canCreateWorkspace = !!place;

    const showProjectActions = React.useCallback(() => {
        if (!canCreateWorkspace) return;
        Modal.alert(project.name, undefined, [
            { text: 'Create workspace', onPress: createWorkspace },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [canCreateWorkspace, createWorkspace, project.name]);

    const menuHandlers = Platform.OS === 'web' && canCreateWorkspace
        ? {
            onContextMenu: (event: { preventDefault: () => void; stopPropagation?: () => void }) => {
                event.preventDefault?.();
                event.stopPropagation?.();
                showProjectActions();
            },
        } as any
        : canCreateWorkspace
            ? { onLongPress: showProjectActions }
            : {};

    return (
        <RowPressable
            {...(session ? pressHandlers : {})}
            {...menuHandlers}
            accessibilityRole="button"
            accessibilityLabel={project.name}
            style={styles.projectRow}
        >
            <View style={styles.avatarLane}>
                {project.avatarSession && (
                    <Avatar
                        id={project.avatarSession.avatarId}
                        size={AVATAR_SIZE}
                        flavor={null}
                        imageUrl={project.avatarSession.projectAvatarUri}
                        thumbhash={project.avatarSession.projectAvatarThumbhash}
                    />
                )}
                {/* Drops the tree line from the avatar to the first worktree. */}
                {showsTree && <View style={styles.projectTreeStem} />}
            </View>
            <RowName text={project.name} working={project.working} style={styles.projectNameText} />
            <View style={styles.trailing}>
                {project.blocked ? (
                    <StatusDot color="#FF9500" isPulsing size={7} />
                ) : project.unread ? (
                    <View style={styles.unreadDot} />
                ) : null}
                <GitChanges changes={changes} />
                {canCreateWorkspace && (
                    <Pressable
                        onPress={(event) => {
                            event.stopPropagation();
                            createWorkspace();
                        }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Create workspace in ${project.name}`}
                        style={({ pressed }) => [styles.projectAdd, pressed && styles.pressed]}
                    >
                        <Ionicons name="add" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>
        </RowPressable>
    );
}, (before, after) => sameEntry(before.project, after.project));

/**
 * One worktree, hanging off its project's tree line. Opens the chat worked on
 * most recently; the others wait in tabs beside it.
 */
const WorktreeRow = React.memo(({ worktree, last }: {
    worktree: ProjectWorktree;
    last: boolean;
}) => {
    const styles = stylesheet;
    const session = worktree.session;
    const pressHandlers = useSessionPressHandlers(session.id);
    const changes = useGitChanges(session);
    const title = worktree.workspaceName ?? worktree.projectName;

    return (
        <RowPressable
            {...pressHandlers}
            accessibilityRole="button"
            accessibilityLabel={title}
            style={styles.worktreeRow}
        >
            <View style={styles.avatarLane}>
                <View style={[styles.treeTrunk, last && styles.treeTrunkLast]} />
                <View style={styles.treeElbow} />
            </View>
            <RowName text={title} working={worktree.working} style={styles.worktreeNameText} />
            <View style={styles.trailing}>
                {worktree.blocked ? (
                    <StatusDot color="#FF9500" isPulsing size={7} />
                ) : worktree.unread ? (
                    <View style={styles.unreadDot} />
                ) : null}
                <GitChanges changes={changes} />
            </View>
        </RowPressable>
    );
}, (before, after) => before.last === after.last && sameWorktree(before.worktree, after.worktree));

/**
 * The row that ends a project's worktrees and decides how many of them there
 * are on screen.
 *
 * It sits on the tree line, in the worktrees' own column, so it reads as the
 * last of the things it governs rather than as a control belonging to the card
 * — which is the confusion the chevron at the card's trailing edge created,
 * sharing that edge with the `+` that creates a workspace.
 *
 * While it is holding worktrees back it also speaks for them: a checkout
 * stopped on a question is the reason to open this, and it would otherwise be
 * hidden behind a count.
 */
const WorktreeToggleRow = React.memo(({ toggle, onToggle }: {
    toggle: WorktreeToggle;
    onToggle: (projectId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = toggle.expanded
        ? t('sidebar.showFewerWorkspaces')
        : t('sidebar.showAllWorkspaces', { count: toggle.worktreeCount });

    return (
        <RowPressable
            onPress={() => onToggle(toggle.projectId)}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ expanded: toggle.expanded }}
            style={styles.worktreeRow}
        >
            <View style={styles.avatarLane}>
                {/* Closes the tree line: this is the last row under the card. */}
                <View style={[styles.treeTrunk, styles.treeTrunkLast]} />
                <View style={styles.treeElbow} />
            </View>
            <View style={styles.nameLane}>
                <View style={styles.toggleLabel}>
                    <Ionicons
                        name={toggle.expanded ? 'chevron-up' : 'chevron-down'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                    <Text style={styles.toggleText} numberOfLines={1}>{label}</Text>
                </View>
            </View>
            <View style={styles.trailing}>
                {toggle.blocked ? (
                    <StatusDot color="#FF9500" isPulsing size={7} />
                ) : toggle.unread ? (
                    <View style={styles.unreadDot} />
                ) : null}
            </View>
        </RowPressable>
    );
}, (before, after) => (
    before.onToggle === after.onToggle
    && before.toggle.projectId === after.toggle.projectId
    && before.toggle.worktreeCount === after.toggle.worktreeCount
    && before.toggle.expanded === after.toggle.expanded
    && before.toggle.unread === after.toggle.unread
    && before.toggle.blocked === after.toggle.blocked
));

/**
 * Every row is rebuilt whenever any session in the account changes — an agent
 * streaming a reply rebuilds this list many times a second. Comparing what the
 * row actually draws keeps that from re-rendering the whole column.
 */
function sameWorktree(before: ProjectWorktree, after: ProjectWorktree): boolean {
    return before.id === after.id
        && before.workspaceName === after.workspaceName
        && before.projectName === after.projectName
        && before.unread === after.unread
        && before.working === after.working
        && before.blocked === after.blocked
        && before.live === after.live
        && sameDrawnSession(before.session, after.session);
}

function sameEntry(before: ProjectHomeEntry, after: ProjectHomeEntry): boolean {
    return before.id === after.id
        && before.name === after.name
        && before.worktreeCount === after.worktreeCount
        && before.unread === after.unread
        && before.working === after.working
        && before.blocked === after.blocked
        && before.live === after.live
        && before.session?.id === after.session?.id
        // Also where a card without its own chat creates workspaces from.
        && before.avatarSession?.id === after.avatarSession?.id
        && before.avatarSession?.avatarId === after.avatarSession?.avatarId
        && before.avatarSession?.projectAvatarUri === after.avatarSession?.projectAvatarUri
        && before.avatarSession?.projectAvatarThumbhash === after.avatarSession?.projectAvatarThumbhash
        && (!before.session || !after.session || sameDrawnSession(before.session, after.session));
}

function sameDrawnSession(a: SessionRowData, b: SessionRowData): boolean {
    return a.id === b.id
        && a.name === b.name
        && a.machineId === b.machineId
        && a.path === b.path
        && a.projectId === b.projectId
        && a.gitBranch === b.gitBranch
        && a.gitChangedFiles === b.gitChangedFiles
        && a.gitInsertions === b.gitInsertions
        && a.gitDeletions === b.gitDeletions
        && a.gitCountsExact === b.gitCountsExact;
}

/** A bot is a single standing chat, so its row opens it directly. */
const BotRow = React.memo(({ session }: { session: SessionRowData }) => (
    <ChatRow session={session} bot />
));

/**
 * One chat as a row of its own: a bot, which is a single standing chat, or a
 * retired chat in the archive, which belongs to no checkout any more. Both
 * open the chat directly. The archive is drawn faded, the way the flat layout
 * fades it.
 */
const ChatRow = React.memo(({ session, bot = false, archived = false }: {
    session: SessionRowData;
    bot?: boolean;
    archived?: boolean;
}) => {
    const styles = stylesheet;
    const pressHandlers = useSessionPressHandlers(session.id);
    const presentation = resolveFlatSessionRowPresentation({
        state: session.state,
        hasUnread: session.hasUnread,
        faded: archived || session.machineOffline,
    });
    const timestamp = React.useMemo(
        () => formatSessionListTimestamp(session.lastActivityAt),
        [session.lastActivityAt],
    );

    return (
        <RowPressable
            {...pressHandlers}
            accessibilityRole="button"
            accessibilityLabel={session.name}
            style={[styles.botRow, archived && styles.archivedRow]}
        >
            <View style={styles.avatarLane}>
                {/*
                  * The chat's own picture, which already falls back to its
                  * project's artwork where there is one. Reading that artwork
                  * directly left every bot blank: a bot belongs to no project,
                  * and the face painted onto it is the only picture it has.
                  */}
                <Avatar
                    id={session.avatarId}
                    size={AVATAR_SIZE}
                    flavor={null}
                    bot={bot}
                    imageUrl={session.avatarUri}
                    thumbhash={session.avatarThumbhash}
                />
            </View>
            <RowName
                text={session.name}
                working={presentation.shimmerTitle}
                style={styles.projectNameText}
            />
            <View style={styles.trailing}>
                {presentation.topRight.type === 'dot' ? (
                    <StatusDot color={presentation.topRight.color} size={10} />
                ) : (
                    <Text style={styles.timestamp} numberOfLines={1}>{timestamp}</Text>
                )}
            </View>
        </RowPressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    // The banner group already insets its card by the row padding, so adding
    // it again here left the card narrower than the rows beneath it.
    updateBanner: {
        paddingBottom: 16,
    },
    updateBannerHeader: {
        paddingTop: 4,
    },
    pressed: {
        opacity: 0.55,
    },

    section: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: ROW_PADDING_X,
        paddingRight: 12,
        paddingTop: 18,
        paddingBottom: 6,
    },
    sectionText: {
        flex: 1,
        fontSize: 11,
        lineHeight: 14,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },
    machineHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: ROW_PADDING_X,
        // The machine heads the list now, so this is the first row under the
        // header rather than a divider between two groups of projects. Clearing
        // the header is the top inset's job, and every screen mounting this
        // list has to supply one; the row itself keeps a divider's own air.
        paddingTop: 14,
        paddingBottom: 2,
    },
    machineHeaderText: {
        maxWidth: '60%',
        fontSize: 11,
        // Given a line box of its own so the name and the icon beside it are
        // measured the same way on both platforms.
        lineHeight: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    machineHeaderLine: {
        flex: 1,
        height: TREE_LINE_WIDTH,
        backgroundColor: theme.colors.textSecondary,
    },

    // ---- the two leading columns every row shares ----
    avatarLane: {
        width: AVATAR_SIZE,
        marginRight: AVATAR_GAP,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
    },
    projectAdd: {
        width: 28,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    nameLane: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        marginLeft: 8,
    },

    projectRow: {
        flexDirection: 'row',
        alignItems: 'center',
        height: PROJECT_ROW_HEIGHT,
        paddingHorizontal: ROW_PADDING_X,
        marginTop: 8,
    },
    projectNameText: {
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
        ...Typography.default('regular'),
    },
    // Runs from the avatar down to the row's edge, where the first worktree
    // picks the line up.
    projectTreeStem: {
        position: 'absolute',
        top: (PROJECT_ROW_HEIGHT + AVATAR_SIZE) / 2,
        bottom: 0,
        width: TREE_LINE_WIDTH,
        backgroundColor: theme.colors.textSecondary,
    },
    worktreeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        height: WORKTREE_ROW_HEIGHT,
        paddingHorizontal: ROW_PADDING_X,
    },
    worktreeNameText: {
        fontSize: 16,
        lineHeight: 21,
        color: theme.colors.text,
        ...Typography.default('regular'),
    },
    // Quieter than a worktree's name: this row is about the list, not about
    // any checkout in it.
    toggleLabel: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    toggleText: {
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    // The vertical run of the tree. The last worktree stops it at its own elbow
    // so the branch visibly ends.
    treeTrunk: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: TREE_LINE_WIDTH,
        backgroundColor: theme.colors.textSecondary,
    },
    treeTrunkLast: {
        bottom: WORKTREE_ROW_HEIGHT / 2,
    },
    treeElbow: {
        position: 'absolute',
        left: AVATAR_SIZE / 2,
        right: 0,
        height: TREE_LINE_WIDTH,
        backgroundColor: theme.colors.textSecondary,
    },

    botRow: {
        flexDirection: 'row',
        alignItems: 'center',
        height: BOT_ROW_HEIGHT,
        paddingHorizontal: ROW_PADDING_X,
    },
    archivedRow: {
        opacity: 0.6,
    },
    // The divider that opens the archive, drawn as the flat layout draws it.
    archiveToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 12,
    },
    archiveToggleLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    archiveToggleText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    timestamp: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },

    unreadDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: '#007AFF',
    },
    changes: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
    },
    approximate: {
        fontSize: 11,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    added: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.gitAddedText,
        ...Typography.default('semiBold'),
    },
    removed: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.gitRemovedText,
        ...Typography.default('semiBold'),
    },
}));
