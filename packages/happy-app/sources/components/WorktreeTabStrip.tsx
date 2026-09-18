import * as React from 'react';
import { LayoutChangeEvent, Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage, useSessionListViewData, type SessionRowData } from '@/sync/storage';
import {
    openPendingChat,
    usePendingChat,
    usePendingChatsBeside,
    type PendingChat,
} from '@/sync/pendingChats';
import { handOverPendingChat, retirePendingChat } from '@/sync/pendingChatHandover';
import { findProjectWorktree, locateProjectWorkspace } from '@/utils/projectHomeList';
import { neighbouringTabId, resolveWorktreeTabs } from '@/utils/worktreeTabs';
import { newSessionLikeSession } from '@/utils/newSessionCheckout';
import { useStartSessionFromDraft } from '@/hooks/useStartSessionFromDraft';
import { useIsTablet } from '@/utils/responsive';
import { isRunningOnMac } from '@/utils/platform';
import { trackSessionSwitched } from '@/track';
import { layout } from './layout';
import { MobileGlassSurface } from './MobileGlass';
import { ProviderIcon } from './ProviderIcon';
import { SessionActionsNativeMenu, type SessionActionsNativeMenuHandle } from './SessionActionsNativeMenu';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { ShimmerText } from './ShimmerText';
import { StatusDot } from './StatusDot';

/**
 * The strip is a control in its own right, like the ones in the header above
 * it: same capsule, same material, same 16pt inset from the screen edge. It
 * floats clear of the header rather than butting against it.
 */
const PILL_HEIGHT = 40;
const PILL_RADIUS = PILL_HEIGHT / 2;
const GAP_ABOVE = 10;
const GAP_BELOW = 6;

/** What the strip costs the layout, margins included. */
export const WORKTREE_TAB_STRIP_HEIGHT = PILL_HEIGHT + GAP_ABOVE + GAP_BELOW;

/**
 * Starts run one at a time, but `+` is never the thing that waits.
 *
 * `useStartSessionFromDraft` takes one attempt at a time and declines the rest
 * outright, which used to be papered over by disabling the button for the
 * second or so a start takes — a spinner on the one control whose whole point
 * is to answer instantly. Pressing it twice now opens two tabs on the two
 * presses and puts the second start behind the first, so the queue is felt as
 * a tab that finishes arriving a moment later rather than as a button that
 * would not depress.
 *
 * Module state on purpose: the chain has to outlive the strip that queued it,
 * which unmounts as soon as the user leaves the checkout.
 */
let startQueue: Promise<unknown> = Promise.resolve();

function enqueueStart(job: () => Promise<unknown>): void {
    // Settled either way: a start that failed has already reported itself, and
    // it must not take the starts queued behind it down with it.
    startQueue = startQueue.then(job, job);
}

/**
 * The chats of one checkout as tabs, under the session screen's header.
 *
 * Grouped by project, the home list stops at checkouts; this is where the
 * chats inside one are reached. Switching a tab swaps the route's session in
 * place rather than pushing a screen, so back still returns to the list.
 *
 * Holding a tab opens the platform's own context menu on the session, archive
 * among them.
 */
export const WorktreeTabStrip = React.memo(({ sessionId }: { sessionId: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const isTablet = useIsTablet();
    const glassEnabled = !isTablet && Platform.OS === 'ios' && !isRunningOnMac();
    const data = useSessionListViewData();
    // A chat that has not started yet stands in for itself in the route, and
    // belongs to the checkout of the chat it was opened beside. One chat is one
    // chip throughout: `resolveWorktreeTabs` settles which of the stand-in and
    // the arriving session is drawn while both briefly exist.
    const pending = usePendingChat(sessionId);
    const anchorId = pending?.anchorSessionId ?? sessionId;
    const worktree = React.useMemo(() => findProjectWorktree(data, anchorId), [data, anchorId]);
    const tabIds = React.useMemo(() => worktree?.tabs.map((tab) => tab.id) ?? [], [worktree]);
    const pendingChats = usePendingChatsBeside(tabIds);
    const resolved = React.useMemo(() => resolveWorktreeTabs({
        tabs: worktree?.tabs ?? [],
        pending: pendingChats,
    }), [pendingChats, worktree]);
    // The selection follows whichever chip stands for the open chat: the
    // stand-in while the chat is unnamed, its session from the moment it is not.
    const selectedId = pending?.sessionId ?? sessionId;
    const { startSession } = useStartSessionFromDraft();

    const scrollRef = React.useRef<ScrollView>(null);
    const tabOffsets = React.useRef<Record<string, number>>({});
    const [stripWidth, setStripWidth] = React.useState(0);
    const stripWidthRef = React.useRef(0);
    /**
     * A tab the strip has been asked to show but cannot place yet.
     *
     * A tab that has just been opened is selected a frame before it is measured,
     * so the scroll has nowhere to go and used to be dropped — which is why a
     * new chat could land off the right-hand edge of a full strip. The request
     * is held instead, and `handleTabLayout` completes it the moment the tab
     * reports where it is.
     */
    const awaitingScroll = React.useRef<string | null>(null);

    const select = React.useCallback((id: string) => {
        if (id === sessionId) return;
        const session = storage.getState().sessions[id];
        if (session) trackSessionSwitched(session);
        router.setParams({ id });
    }, [router, sessionId]);

    /**
     * Archiving the tab you are reading would leave the screen parked on a
     * retired chat, so its neighbour takes over — the tab to its left, the way
     * closing a tab works anywhere else.
     *
     * This happens on the press, before the machine is asked anything. An
     * archive is several store updates long — the chat leaves the list, the
     * checkout it was looked up through comes back empty, the strip has nothing
     * to draw — and a screen still standing on that chat plays every one of them
     * out: the strip collapses, the chat is replaced by "session deleted", and
     * the whole lot returns a moment later on the neighbour. Moving first means
     * none of it is ever on screen.
     *
     * The neighbour comes in with the call rather than being looked up here:
     * the caller settles it while the tab is still among its siblings, which
     * after the archive it no longer is. It is only checked for still being
     * there, through the store rather than through this callback's render.
     */
    const handleArchiving = React.useCallback((archivedId: string, neighbourId: string | null) => {
        if (archivedId !== selectedId) return;
        if (neighbourId && locateProjectWorkspace(storage.getState().sessionListViewData, neighbourId)) {
            router.setParams({ id: neighbourId });
            return;
        }
        // Nothing left in the checkout to show.
        router.back();
    }, [router, selectedId]);

    /**
     * A sibling chat, started where this one runs and configured like it. The
     * composer screen is not opened on the way: there is nothing left to ask,
     * and it would be a detour out of the checkout the strip is standing in.
     *
     * The tab and its screen are the user's on the press, not when the machine
     * gets around to answering. The start runs underneath and the chat takes
     * its real identity when it lands; a start that fails has already said so
     * itself, and only has to retire the tab it was standing in for.
     */
    const newTab = React.useCallback(() => {
        const sessions = storage.getState().sessions;
        const open = sessions[selectedId] ?? sessions[anchorId];
        if (!open) return;
        const chat = openPendingChat(open.id, tabIds);
        select(chat.id);
        enqueueStart(() => startSession({
            ...newSessionLikeSession(open),
            openSession: (startedId) => handOverPendingChat(chat.id, startedId),
        }).then(
            (started) => { if (!started) retirePendingChat(chat.id); },
            // A start that blew up rather than declining is still a start that
            // is not coming, and the tab must not be left waiting for it.
            () => retirePendingChat(chat.id),
        ));
    }, [anchorId, select, selectedId, startSession, tabIds]);

    const scrollToTab = React.useCallback((id: string) => {
        const x = tabOffsets.current[id];
        const width = stripWidthRef.current;
        if (x === undefined || width === 0) {
            awaitingScroll.current = id;
            return;
        }
        awaitingScroll.current = null;
        scrollRef.current?.scrollTo({ x: Math.max(0, x - width / 3), animated: true });
    }, []);

    const handleTabLayout = React.useCallback((id: string, x: number) => {
        tabOffsets.current[id] = x;
        if (awaitingScroll.current === id) scrollToTab(id);
    }, [scrollToTab]);

    const handleStripLayout = React.useCallback((event: LayoutChangeEvent) => {
        stripWidthRef.current = event.nativeEvent.layout.width;
        setStripWidth(event.nativeEvent.layout.width);
    }, []);

    // Keep the open tab in view, including after a switch from the far end and
    // for a tab that did not exist a frame ago.
    React.useEffect(() => {
        scrollToTab(selectedId);
    }, [scrollToTab, selectedId, stripWidth]);

    if (!worktree) return null;

    return (
        <View style={styles.wrapper} pointerEvents="box-none">
            <View style={styles.row} pointerEvents="box-none">
                <MobileGlassSurface
                    enabled={glassEnabled}
                    nativeEffect
                    material="static"
                    intensity={76}
                    style={[styles.pill, !glassEnabled && styles.pillSolid]}
                >
                    <ScrollView
                        ref={scrollRef}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.tabs}
                        onLayout={handleStripLayout}
                        style={styles.scroll}
                    >
                        {resolved.tabs.map((tab) => (
                            <WorktreeTab
                                key={tab.id}
                                session={tab}
                                selected={tab.id === selectedId}
                                // Settled while this tab still exists, because
                                // after the archive it has no neighbours left.
                                neighbourId={neighbouringTabId(resolved.tabs, tab.id)}
                                onSelect={select}
                                onArchiving={handleArchiving}
                                onLayoutX={handleTabLayout}
                            />
                        ))}
                        {resolved.pending.map((chat) => (
                            <PendingTab
                                key={chat.id}
                                chat={chat}
                                selected={chat.id === selectedId}
                                onSelect={select}
                                onLayoutX={handleTabLayout}
                            />
                        ))}
                    </ScrollView>
                    <View style={styles.divider} />
                    <Pressable
                        onPress={newTab}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('sidebar.newSession')}
                        style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
                    >
                        {/* Always the plus. The tab that appears on the press is
                            what reports it; how far along its start is belongs
                            to that tab, which says so with its own shimmer. */}
                        <Ionicons name="add" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                </MobileGlassSurface>
            </View>
        </View>
    );
});

/**
 * A chat the user has opened but no machine has confirmed yet. It reads as a
 * tab because it behaves like one — it can be left and come back to — and the
 * shimmer is what says it is not finished arriving. It is replaced by the real
 * tab, in place, the moment the session exists.
 */
const PendingTab = React.memo(({ chat, selected, onSelect, onLayoutX }: {
    chat: PendingChat;
    selected: boolean;
    onSelect: (id: string) => void;
    onLayoutX: (id: string, x: number) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = t('session.newChat');

    return (
        <View onLayout={(event: LayoutChangeEvent) => onLayoutX(chat.id, event.nativeEvent.layout.x)}>
            <Pressable
                onPress={() => onSelect(chat.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected, busy: true }}
                accessibilityLabel={label}
                style={({ pressed }) => [
                    styles.tab,
                    selected && styles.tabSelected,
                    pressed && !selected && styles.tabPressed,
                ]}
            >
                <Ionicons name="add-circle-outline" size={14} color={theme.colors.textSecondary} />
                <View style={styles.tabLabel}>
                    <ShimmerText
                        text={label}
                        style={[styles.tabText, selected && styles.tabTextSelected]}
                        baseColor={theme.colors.textSecondary}
                        highlightColor={theme.colors.header.tint}
                    />
                </View>
            </Pressable>
        </View>
    );
});

/**
 * One chat. The open one is a filled chip rather than an underline: inside a
 * capsule an underline would run into the rounded edge.
 *
 * Holding it opens the session's actions in the platform's own menu — UIMenu on
 * iOS, a Compose dropdown on Android — and right-click opens the web popover.
 */
const WorktreeTab = React.memo(({ session, selected, neighbourId, onSelect, onArchiving, onLayoutX }: {
    session: SessionRowData;
    selected: boolean;
    /** Who takes over if this tab is archived while it is the open one. */
    neighbourId: string | null;
    onSelect: (id: string) => void;
    /** On the press rather than on the answer, so the screen leaves first. */
    onArchiving: (id: string, neighbourId: string | null) => void;
    onLayoutX: (id: string, x: number) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const working = session.state === 'thinking';
    const blocked = session.state === 'permission_required' || session.state === 'input_required';
    const color = selected ? theme.colors.header.tint : theme.colors.textSecondary;

    const menuRef = React.useRef<SessionActionsNativeMenuHandle>(null);
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const handleBeforeArchive = React.useCallback(() => {
        onArchiving(session.id, neighbourId);
    }, [neighbourId, onArchiving, session.id]);

    // iOS raises its context menu from the press itself; Android and the web
    // ignore this, so the same gesture can be wired everywhere.
    const openMenu = React.useCallback(() => menuRef.current?.open(), []);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent?.clientX ?? event.nativeEvent?.pageX ?? 0,
            y: event.nativeEvent?.clientY ?? event.nativeEvent?.pageY ?? 0,
        });
    }, []);

    const webMenuProps = Platform.OS === 'web'
        ? { onContextMenu: handleContextMenu } as any
        : undefined;

    return (
        // The native menu hosts the tab inside a platform view of its own, so
        // the offset the strip scrolls by has to be measured out here, on the
        // React Native box that still sits in the ScrollView's coordinates.
        <View onLayout={(event: LayoutChangeEvent) => onLayoutX(session.id, event.nativeEvent.layout.x)}>
            <SessionActionsNativeMenu
                onBeforeArchive={handleBeforeArchive}
                ref={menuRef}
                sessionId={session.id}
            >
                <Pressable
                    onPress={() => onSelect(session.id)}
                    onLongPress={openMenu}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    accessibilityLabel={session.name}
                    style={({ pressed }) => [
                        styles.tab,
                        selected && styles.tabSelected,
                        pressed && !selected && styles.tabPressed,
                    ]}
                    {...webMenuProps}
                >
                    <ProviderIcon kind={session.providerKind} size={14} />
                    <View style={styles.tabLabel}>
                        {working ? (
                            <ShimmerText
                                text={session.name}
                                style={[styles.tabText, selected && styles.tabTextSelected]}
                                baseColor={theme.colors.textSecondary}
                                highlightColor={theme.colors.header.tint}
                            />
                        ) : (
                            <Text
                                numberOfLines={1}
                                style={[styles.tabText, selected && styles.tabTextSelected, { color }]}
                            >
                                {session.name}
                            </Text>
                        )}
                    </View>
                    {blocked ? (
                        <StatusDot color="#FF9500" isPulsing size={7} />
                    ) : session.hasUnread && !selected ? (
                        <View style={styles.unread} />
                    ) : null}
                </Pressable>
            </SessionActionsNativeMenu>
            {Platform.OS === 'web' && (
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onBeforeArchive={handleBeforeArchive}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            )}
        </View>
    );
}, (before, after) => (
    before.selected === after.selected
    // Compared, not assumed: a tab that skipped a render would hand the archive
    // a neighbour that has since moved or gone.
    && before.neighbourId === after.neighbourId
    && before.onSelect === after.onSelect
    && before.onArchiving === after.onArchiving
    && before.onLayoutX === after.onLayoutX
    && before.session.id === after.session.id
    && before.session.name === after.session.name
    && before.session.state === after.session.state
    && before.session.hasUnread === after.session.hasUnread
    && before.session.providerKind === after.session.providerKind
));

const stylesheet = StyleSheet.create((theme) => ({
    // Mirrors the header's own box, so the capsule's edges land exactly under
    // the back button on the left and the right-hand control on the right.
    wrapper: {
        width: '100%',
        alignItems: 'center',
        marginTop: GAP_ABOVE,
        marginBottom: GAP_BELOW,
    },
    row: {
        width: '100%',
        maxWidth: layout.headerMaxWidth,
        paddingHorizontal: 16,
    },
    // Same material, rim and shadow the header controls carry.
    pill: {
        height: PILL_HEIGHT,
        borderRadius: PILL_RADIUS,
        flexDirection: 'row',
        alignItems: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ ios: 1, default: 0 }),
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.18)' : '#FFFFFF',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    // Off glass the capsule still needs a surface of its own to sit on.
    pillSolid: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    scroll: {
        flex: 1,
    },
    tabs: {
        alignItems: 'center',
        paddingHorizontal: 4,
        gap: 2,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: PILL_HEIGHT - 8,
        paddingHorizontal: 10,
        borderRadius: (PILL_HEIGHT - 8) / 2,
        maxWidth: 200,
    },
    // Translucent on purpose: an opaque chip would punch a hole in the glass
    // the capsule is made of. Same rim language as the header controls.
    tabSelected: {
        backgroundColor: theme.dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.07)',
    },
    tabPressed: {
        opacity: 0.55,
    },
    tabLabel: {
        flexShrink: 1,
        minWidth: 0,
    },
    tabText: {
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    tabTextSelected: {
        ...Typography.default('semiBold'),
    },
    unread: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: '#007AFF',
    },
    divider: {
        width: StyleSheet.hairlineWidth,
        height: 20,
        backgroundColor: theme.colors.divider,
    },
    addButton: {
        width: 40,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addButtonPressed: {
        opacity: 0.55,
    },
}));
