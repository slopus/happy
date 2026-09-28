import * as React from 'react';
import { useSession, useSessionMessages, useSetting } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, AppState, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useCallback } from 'react';
import { FlashList, FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { AgentWorkGroupHeader } from './AgentWorkGroupHeader';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { AgentWorkGroupItem, DisplayItem, TextItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveControlMode } from '@/sync/controlHandoff';
import { usesControlledSessionUi } from '@/sync/rig';
import { buildAgentTurnCopyTextByMessageId } from '@/utils/agentTurnCopy';
import { perfSince, useCommitPerf } from '@/utils/perfLog';
import { handleInvertedChatWheel } from '@/utils/invertedChatWheel';
import { DiffSyntaxCell, SyntaxViewport, SYNTAX_VIEWABILITY } from './diff/syntax/viewport';
import { RoundButton } from './RoundButton';
import { t } from '@/text';

const SCROLL_THRESHOLD = 300;
const DOCK_DETAILS_SHOW_OFFSET = 16;
const DOCK_DETAILS_HIDE_OFFSET = 48;
/**
 * The list is inverted: item 0 is the newest message and scroll offset 0 is
 * the bottom of the screen. Everything below follows from that one choice, so
 * it is worth being explicit about why.
 *
 * A chat has exactly one fixed reference point — the newest message, sitting
 * just above the composer. A normal list puts the scroll origin at the *other*
 * end, on the oldest message, which is the one point in a conversation that
 * never stops moving as history loads in. Every viewport resize and every
 * content change then needs a correction to bring the newest message back into
 * view, and each correction is computed from an estimate.
 *
 * The keyboard is where that becomes unfixable rather than merely fragile.
 * Shrinking the viewport by the keyboard's height leaves a normal list several
 * hundred points short of the end, and FlashList's stick-to-bottom threshold
 * is a fraction of the *shrunken* viewport — so it measures the reader as far
 * from the bottom and declines to follow. Widening the threshold enough to fire
 * would also drag a reader out of history every time a message arrived, because
 * FlashList has a single threshold for "the viewport resized" and "content was
 * added". Those two need opposite answers.
 *
 * Inverted needs no answer at all: offset 0 is the newest message *and* the
 * edge the keyboard moves, so the viewport shrinking changes nothing about
 * where the list is anchored. Older pages load at the far end, off-screen,
 * where they cannot shift anything. The only case left needing a rule is a new
 * message arriving, which inserts at offset 0 — handled below.
 *
 * Measured on device, raising the keyboard: a non-inverted list ends 582pt off
 * the newest message and stays there; inverted does not move at all.
 */
const MAINTAIN_VISIBLE_CONTENT_POSITION = {
    /**
     * How close to the newest message the reader must be, in points, to be
     * carried along when one arrives.
     *
     * The unit matters and is easy to get wrong: unlike
     * `autoscrollToBottomThreshold`, this is not implemented by FlashList. It
     * is forwarded to React Native's native maintainVisibleContentPosition,
     * which takes points — a fraction here is indistinguishable from off.
     *
     * Generous, because the reader is either at the newest message or
     * deliberately back in history, and the points in between are mostly the
     * bottom row growing as it streams.
     */
    autoscrollToTopThreshold: 200,
} as const;
/**
 * How much history the list renders on open, and how much more it renders each
 * time the reader approaches the oldest rendered message.
 *
 * Sync keeps loading older pages into the store in the background long after
 * the session opens (see prefetchOlderMessagesInBackground), and the store
 * holds far more than a reader will ever scroll through. The window keeps
 * those pages out of the list until they are asked for, so mounting a session
 * lays out tens of rows rather than hundreds.
 *
 * Inverting the list removed the correctness reason for this — history now
 * lands at the far end, past the viewport, where it cannot shift what the
 * reader is looking at. What is left is the cost reason, which is enough.
 */
const INITIAL_WINDOW = 60;
const WINDOW_PAGE = 60;
/**
 * History is rendered ahead of the reader once they are within this many
 * viewports of the oldest rendered message.
 */
const START_REACHED_VIEWPORTS = 1;
/** Stop automatic paging after this many pages that reach no further back (see oldestBoundary). */
const MAX_INVISIBLE_OLDER_PAGES = 5;
// Visual gap between the button's bottom edge and the composer card's top
// edge. scrollButtonInset is measured to the card itself, so this is exact.
const SCROLL_BUTTON_COMPOSER_GAP = 16;
// Fallback for non-floating layouts (tablet/web/landscape), where the list
// already ends at the input's top edge.
const SCROLL_BUTTON_DOCK_GAP = 4;

/**
 * One row of the chat. The list is flat on purpose: an expanded work group is
 * not a container that renders its children — its members are inserted here as
 * ordinary items after the header. Expansion is therefore a plain data change
 * that extends the list downward, gets virtualized like everything else, and
 * needs no scroll compensation.
 */
type ListItem =
    | TextItem
    | { type: 'work-header'; id: string; group: AgentWorkGroupItem; placement: 'leading' | 'trailing' };

const EMPTY_MESSAGES: Message[] = [];
/** Shared so "no toggles" is always the same object identity. */
const EMPTY_GROUP_TOGGLES = {
    expanded: new Set<string>() as ReadonlySet<string>,
    /** Suppresses the pending-permission auto-open in isGroupExpanded. */
    closed: new Set<string>() as ReadonlySet<string>,
} as const;
const EMPTY_WATCHED_TURN_IDS = new Set<string>() as ReadonlySet<string>;

function stringSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) {
        if (!b.has(value)) return false;
    }
    return true;
}

/**
 * How many messages the list renders for a requested window size.
 *
 * Messages arrive newest-first, so a window is a prefix of the array and its
 * end lands on the oldest rendered message. Cutting at a turn boundary (the
 * user message that opened the turn) keeps a turn's collapsed work group whole
 * once the store holds all of it. The store's own tail is rendered as is: a
 * turn whose older rows are still on the server folds from the rows present,
 * and its group keeps its identity when the rest arrives (see
 * collectAgentWorkGroups).
 */
function windowEndForTurn(messages: Message[], desiredEnd: number): number {
    let end = Math.min(desiredEnd, messages.length);
    while (end > 0 && end < messages.length) {
        const message = messages[end - 1];
        if (message.kind === 'user-text' && !message.pending && message.sendError === undefined) break;
        end++;
    }
    return end;
}

/**
 * Identity of the far end of the list, for judging whether a page of history
 * took the reader any further back.
 *
 * Usually that is just the oldest row. The exception is a collapsed work group:
 * it is keyed by the message its run completes at (see collectAgentWorkGroups),
 * so it keeps its id while the older part of its turn is still arriving. A page
 * that lands there adds no row, yet it does reach further back — and one turn of
 * agent work can span many pages before the prompt that opened it arrives. The
 * group's oldest member is therefore part of its identity. Expanding a group, or
 * live rows arriving at the newest end, still leaves this unchanged.
 */
function oldestBoundary(items: readonly ListItem[]): string | null {
    const oldest = items[items.length - 1];
    if (!oldest) return null;
    if (oldest.type === 'work-header') return `${oldest.id}:${oldest.group.messages[0]?.id ?? ''}`;
    return oldest.id;
}

export const ChatList = React.memo((props: {
    session: Session;
    active?: boolean;
    topContentInset?: number;
    bottomContentInset?: number;
    /** Distance from the screen bottom to the composer. Independent of status-chrome fade. */
    scrollButtonInset?: number;
    headerOverlayHeight?: number;
    onHeaderBackdropVisibilityChange?: (visible: boolean) => void;
    onBottomDockVisibilityChange?: (visible: boolean) => void;
}) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            active={props.active ?? true}
            messages={messages}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
            topContentInset={props.topContentInset}
            bottomContentInset={props.bottomContentInset}
            scrollButtonInset={props.scrollButtonInset}
            headerOverlayHeight={props.headerOverlayHeight}
            onHeaderBackdropVisibilityChange={props.onHeaderBackdropVisibilityChange}
            onBottomDockVisibilityChange={props.onBottomDockVisibilityChange}
        />
    )
});

/**
 * Renders past the oldest message: the older-history spinner, Retry after a
 * failed page, or Load more after the invisible-page budget, directly above the
 * oldest message, with a spacer beyond it keeping it clear of the header bar.
 *
 * This is the list's *footer* because the list is inverted — the far end of
 * the data is the top of the screen. FlashList counter-flips the footer as a
 * whole, as it does each cell, so inside this component layout reads
 * top-to-bottom like any other view: the spacer comes first and sits under the
 * header bar, and the status slot comes last, against the oldest message. The
 * other way round, the slot ends up at the very top of the content, which on a
 * phone is behind the header and the status bar — Load more and Retry would be
 * the only way forward and could be neither seen nor tapped.
 *
 * The status slot is always mounted at a fixed height. It sits beyond every
 * row, so a height change here moves the whole conversation.
 */
const OlderEnd = React.memo((props: { status: 'idle' | 'loading' | 'error' | 'load-more'; onAction: () => void; topContentInset?: number }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            <View style={{ height: props.topContentInset ?? headerHeight + safeArea.top + 32 }} />
            <View style={{ height: 32, alignItems: 'center', justifyContent: 'center' }}>
                {props.status === 'loading' && <ActivityIndicator size="small" />}
                {props.status === 'error' && <RoundButton size="small" display="inverted" title={t('common.retry')} onPress={props.onAction} />}
                {props.status === 'load-more' && <RoundButton size="small" display="inverted" title={t('common.loadMore')} onPress={props.onAction} />}
            </View>
        </View>
    );
});

/** Renders just past the newest message, so the list's header when inverted. */
const NewerEnd = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={usesControlledSessionUi(session.metadata) && (session.agentState?.controlledByUser || false)} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    active: boolean,
    messages: Message[],
    hasMoreOlder: boolean,
    isLoadingOlder: boolean,
    topContentInset?: number,
    bottomContentInset?: number,
    scrollButtonInset?: number,
    headerOverlayHeight?: number,
    onHeaderBackdropVisibilityChange?: (visible: boolean) => void,
    onBottomDockVisibilityChange?: (visible: boolean) => void,
}) => {
    const { theme } = useUnistyles();
    const listRef = React.useRef<FlashListRef<ListItem>>(null);
    const syntaxViewport = React.useMemo(() => new SyntaxViewport(), [props.sessionId]);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [handoffListRevision, setHandoffListRevision] = React.useState(0);
    // Tracks whether the scroll-button is currently shown, so we only call
    // setShowScrollButton when the threshold is actually crossed instead of
    // on every scroll frame (60Hz). Without this guard, the entire list
    // parent re-renders on every wheel tick.
    const showScrollButtonRef = React.useRef(false);
    const headerBackdropVisibleRef = React.useRef(false);
    const bottomDockVisibleRef = React.useRef(true);
    const scrollMetricsRef = React.useRef({
        offsetY: 0,
        contentHeight: 0,
        viewportHeight: 0,
    });
    // Oldest message the list renders. Everything newer than it is rendered;
    // everything older sits in the store until the reader nears it.
    const [oldestRenderedId, setOldestRenderedId] = React.useState<string | null>(null);
    // A failed page or an invisible-tail budget stop automatic paging. The
    // block clears on Retry or Load more (not on background/live messages).
    const [olderBlocked, setOlderBlocked] = React.useState<'error' | 'limit' | null>(null);
    // Perf reporting only; history paging keys off measured layout instead.
    const listReadyRef = React.useRef(false);
    const session = useSession(props.sessionId);
    const controlMode = resolveControlMode(usesControlledSessionUi(session?.metadata) ? session?.agentState?.controlledByUser : false);
    const previousControlModeRef = React.useRef(controlMode);

    React.useEffect(() => {
        if (previousControlModeRef.current === controlMode) {
            return;
        }
        previousControlModeRef.current = controlMode;
        if (Platform.OS !== 'web') {
            return;
        }
        if (showScrollButtonRef.current) {
            showScrollButtonRef.current = false;
            setShowScrollButton(false);
        }
        setHandoffListRevision((revision) => revision + 1);
    }, [controlMode]);

    // Collapse agent work between a user prompt and the final answer. While
    // the turn is streaming everything renders flat; expansion re-inserts the
    // same flat messages below the header. A turn the reader watched live keeps
    // its work visible when it finishes, while a completed turn first seen on
    // open keeps the historic collapsed-by-default behavior.
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    const [appState, setAppState] = React.useState(AppState.currentState);
    const sessionInForeground = props.active && appState !== 'background';
    const currentTurnComplete = session?.thinking !== true
        && !hasPendingPermission;
    const groupingOptions = React.useMemo(
        () => ({ collapseCurrentTurn: currentTurnComplete }),
        [currentTurnComplete],
    );

    // Messages arrive newest-first, so the window is a prefix of the array and
    // background pages (which append older messages to the tail) fall outside
    // it. The previous array is returned whenever the window's contents are
    // unchanged: without that, every background page would hand the list a new
    // array and re-render every mounted row for content that did not move.
    const messages = props.messages;
    const windowRef = React.useRef<Message[]>(EMPTY_MESSAGES);
    const windowedMessages = React.useMemo(() => {
        if (messages.length === 0) return EMPTY_MESSAGES;
        let desiredEnd = INITIAL_WINDOW;
        if (oldestRenderedId !== null) {
            const index = messages.findIndex((msg) => msg.id === oldestRenderedId);
            if (index >= 0) desiredEnd = index + 1;
        }
        const next = messages.slice(0, windowEndForTurn(messages, desiredEnd));
        const prev = windowRef.current;
        if (prev.length === next.length && prev.every((msg, i) => msg === next[i])) {
            return prev;
        }
        windowRef.current = next;
        return next;
    }, [messages, oldestRenderedId]);

    // Pin the window's oldest message once history is available, so a new
    // message extends the window rather than pushing the oldest rendered one
    // out of it — which would shorten the conversation from under the reader.
    React.useEffect(() => {
        if (oldestRenderedId !== null || windowedMessages.length === 0) return;
        setOldestRenderedId(windowedMessages[windowedMessages.length - 1].id);
    }, [windowedMessages, oldestRenderedId]);

    React.useEffect(() => {
        listReadyRef.current = false;
        requestedWindowEndRef.current = 0;
        setOldestRenderedId(null);
        setOlderBlocked(null);
    }, [props.sessionId]);

    const displayItems = useGroupedMessages(windowedMessages, groupToolCalls, groupingOptions);
    const agentCopyTextByMessageId = React.useMemo(
        () => buildAgentTurnCopyTextByMessageId(windowedMessages, { currentTurnComplete }),
        [currentTurnComplete, windowedMessages],
    );

    const currentTurnUserMessageId = React.useMemo(() => {
        for (const message of windowedMessages) {
            if (message.kind === 'user-text' && !message.pending && message.sendError === undefined) return message.id;
        }
        return null;
    }, [windowedMessages]);
    const displayedUserMessageIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const message of windowedMessages) {
            if (message.kind === 'user-text') ids.add(message.id);
        }
        return ids;
    }, [windowedMessages]);

    // Which groups the reader has opened and which they have deliberately
    // closed. Watched prompt IDs are local view state: they are added while a
    // turn is visibly in progress, so completed history never auto-opens, and
    // survive later prompts because the prompt identity is stable.
    const [groupToggles, setGroupToggles] = React.useState(EMPTY_GROUP_TOGGLES);
    const [watchedTurns, setWatchedTurns] = React.useState(() => ({
        sessionId: props.sessionId,
        ids: EMPTY_WATCHED_TURN_IDS,
    }));
    const sessionChanged = watchedTurns.sessionId !== props.sessionId;
    const nextWatchedTurnIds = new Set<string>();
    if (!sessionChanged && sessionInForeground) {
        for (const id of watchedTurns.ids) {
            if (displayedUserMessageIds.has(id)) nextWatchedTurnIds.add(id);
        }
        if (!currentTurnComplete && currentTurnUserMessageId !== null) {
            nextWatchedTurnIds.add(currentTurnUserMessageId);
        }
    }
    if (sessionChanged || !stringSetsEqual(watchedTurns.ids, nextWatchedTurnIds)) {
        // A session switch resets before considering the new session's rows;
        // this prevents stale messages from being recorded under the new ID.
        setWatchedTurns({
            sessionId: props.sessionId,
            ids: nextWatchedTurnIds.size === 0 ? EMPTY_WATCHED_TURN_IDS : nextWatchedTurnIds,
        });
        if (sessionChanged && groupToggles !== EMPTY_GROUP_TOGGLES) {
            setGroupToggles(EMPTY_GROUP_TOGGLES);
        }
    }

    // A watched turn and a pending/running group open themselves unless the
    // reader explicitly closed them.
    const isGroupExpanded = useCallback((group: AgentWorkGroupItem) => (
        groupToggles.expanded.has(group.id)
        || (group.turnUserMessageId !== null
            && sessionInForeground
            && watchedTurns.sessionId === props.sessionId
            && watchedTurns.ids.has(group.turnUserMessageId)
            && !groupToggles.closed.has(group.id))
        || ((group.hasPendingPermission || group.hasRunning) && !groupToggles.closed.has(group.id))
    ), [groupToggles, props.sessionId, sessionInForeground, watchedTurns]);

    // Ref so the AppState handler reads fresh items without re-subscribing
    const displayItemsRef = React.useRef(displayItems);
    displayItemsRef.current = displayItems;

    // Backgrounding closes any group whose work has finished, so returning to
    // a long-idle session does not land on a wall of expanded tool calls.
    // `inactive` is transient on iOS and must not fold a session being viewed.
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            setAppState(state);
            if (state !== 'background') return;
            setWatchedTurns((prev) => prev.ids.size === 0
                ? prev
                : { sessionId: prev.sessionId, ids: EMPTY_WATCHED_TURN_IDS });
            setGroupToggles((prev) => {
                const stillRunning = new Set<string>();
                for (const item of displayItemsRef.current) {
                    if (item.type === 'agent-work-group' && item.hasRunning && prev.expanded.has(item.id)) {
                        stillRunning.add(item.id);
                    }
                }
                if (stillRunning.size === prev.expanded.size && prev.closed.size === 0) return prev;
                return { expanded: stillRunning, closed: new Set<string>() };
            });
        });
        return () => sub.remove();
    }, []);

    const handleToggleGroup = useCallback((group: AgentWorkGroupItem) => {
        // Rows are inserted at indices past the reader's position, which in an
        // inverted list is above them on screen, so the content they are
        // looking at does not move and the expansion grows upward from the header.
        setGroupToggles((prev) => {
            const watched = group.turnUserMessageId !== null
                && sessionInForeground
                && watchedTurns.sessionId === props.sessionId
                && watchedTurns.ids.has(group.turnUserMessageId);
            const wasExpanded = prev.expanded.has(group.id)
                || (watched || group.hasPendingPermission || group.hasRunning)
                    && !prev.closed.has(group.id);
            const expanded = new Set(prev.expanded);
            const closed = new Set(prev.closed);
            if (wasExpanded) {
                expanded.delete(group.id);
                closed.add(group.id);
            } else {
                expanded.add(group.id);
                closed.delete(group.id);
            }
            return { expanded, closed };
        });
    }, [props.sessionId, sessionInForeground, watchedTurns]);

    // Expanded groups contribute their members as ordinary list items right
    // after the header, so the list itself virtualizes them and an expansion
    // simply extends the list downward.
    //
    // Built in reading order and reversed once at the end, because the list is
    // inverted: index 0 has to be the newest item. Reversing also puts each
    // work-header at a higher index than its own messages, which is what makes
    // the header render above the content it expands.
    //
    // An expanded group gets a second header below its messages. The list is
    // inserting content above the reader's fixed point, so the tapped row rides
    // off the top of the screen; the trailing copy lands on the pixels that row
    // just vacated, so the way back out is under the reader's thumb. It has to
    // be pushed after the messages to sit below them in reading order.
    const listItems = React.useMemo<ListItem[]>(() => {
        const out: ListItem[] = [];
        for (const item of displayItems) {
            if (item.type === 'agent-work-group') {
                out.push({ type: 'work-header', id: item.id, group: item, placement: 'leading' });
                if (isGroupExpanded(item)) {
                    for (const msg of item.messages) {
                        out.push({ type: 'message', id: msg.id, message: msg });
                    }
                    out.push({ type: 'work-header', id: `${item.id}:collapse`, group: item, placement: 'trailing' });
                }
            } else {
                out.push(item);
            }
        }
        out.reverse();
        return out;
    }, [displayItems, isGroupExpanded]);
    const listItemsRef = React.useRef(listItems);
    listItemsRef.current = listItems;
    useCommitPerf(`ChatList ${props.sessionId}`, `items=${listItems.length} window=${windowedMessages.length}/${messages.length}`, 30, props.sessionId);
    React.useLayoutEffect(() => {
        perfSince(`session-open:${props.sessionId}`, `ChatList ${props.sessionId} mounted items=${listItemsRef.current.length}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.sessionId]);

    // A preloaded list may lay out before the tap completes. Measure readiness
    // from the real navigation request, including reuse of that prepared list.
    const readyReportedRef = React.useRef(false);
    const reportReady = useCallback(() => {
        if (!props.active || !listReadyRef.current || readyReportedRef.current) return;
        readyReportedRef.current = true;
        perfSince(`session-open:${props.sessionId}`, `ChatList ${props.sessionId} focused and laid out items=${listItemsRef.current.length}`);
    }, [props.sessionId, props.active]);
    React.useLayoutEffect(() => {
        if (!props.active) readyReportedRef.current = false;
        reportReady();
    }, [props.active, reportReady]);

    const keyExtractor = useCallback((item: ListItem) => item.id, []);
    // FlashList sizes rows it has not measured from a rolling average of the
    // last few measured rows *of the same type*, so the types have to separate
    // rows that differ in height. One "message" bucket averaged a one-line
    // status together with a full diff and estimated both badly.
    const getItemType = useCallback((item: ListItem) => {
        if (item.type === 'work-header') return 'work-header';
        const message = item.message;
        return message.kind === 'tool-call' ? `tool:${message.tool.name}` : message.kind;
    }, []);

    const updateHeaderBackdropVisibility = useCallback(() => {
        if (!props.onHeaderBackdropVisibilityChange || !props.headerOverlayHeight) {
            return;
        }
        const { offsetY, contentHeight, viewportHeight } = scrollMetricsRef.current;
        const topSpacerHeight = props.topContentInset ?? 0;
        // The backdrop appears once real content (anything past the spacer
        // above the oldest message) is scrolled under the header overlay. The
        // spacer lives at the far end of an inverted list, so the distance
        // that matters is the one to that end, not the scroll offset.
        const distanceFromOldest = Math.max(0, contentHeight - viewportHeight - offsetY);
        const nextVisible = viewportHeight > 0
            && distanceFromOldest + props.headerOverlayHeight > topSpacerHeight;
        if (nextVisible === headerBackdropVisibleRef.current) {
            return;
        }
        headerBackdropVisibleRef.current = nextVisible;
        props.onHeaderBackdropVisibilityChange(nextVisible);
    }, [props.headerOverlayHeight, props.onHeaderBackdropVisibilityChange, props.topContentInset]);

    const setBottomDockVisibility = useCallback((visible: boolean) => {
        if (!props.onBottomDockVisibilityChange) {
            return;
        }
        if (visible === bottomDockVisibleRef.current) {
            return;
        }
        bottomDockVisibleRef.current = visible;
        props.onBottomDockVisibilityChange(visible);
    }, [props.onBottomDockVisibilityChange]);

    const updateBottomDockVisibility = useCallback((distanceFromNewest: number) => {
        // Hysteresis avoids toggling while the list is resting or bouncing
        // very near the newest message.
        const nextVisible = bottomDockVisibleRef.current
            ? distanceFromNewest <= DOCK_DETAILS_HIDE_OFFSET
            : distanceFromNewest <= DOCK_DETAILS_SHOW_OFFSET;
        setBottomDockVisibility(nextVisible);
    }, [setBottomDockVisibility]);

    React.useEffect(() => {
        setBottomDockVisibility(true);
    }, [props.sessionId, setBottomDockVisibility]);

    React.useEffect(() => () => {
        if (headerBackdropVisibleRef.current) {
            props.onHeaderBackdropVisibilityChange?.(false);
        }
        setBottomDockVisibility(true);
    }, [props.onHeaderBackdropVisibilityChange, setBottomDockVisibility]);

    const renderItem = useCallback(({ item, target }: ListRenderItemInfo<ListItem>) => {
        // The inner `key` opts out of FlashList's cell recycling for the row
        // content: rows carry local state (expanded diffs, collapsed output)
        // that must never leak into a different message via a recycled cell.
        if (item.type === 'work-header') {
            // Keyed and toggled by the group, not the row: the two rows of one
            // expanded group have different ids but drive the same state.
            return (
                <AgentWorkGroupHeader
                    key={item.id}
                    group={item.group}
                    expanded={isGroupExpanded(item.group)}
                    placement={item.placement}
                    onToggle={() => handleToggleGroup(item.group)}
                />
            );
        }
        return (
            <DiffSyntaxCell key={item.message.id} viewport={syntaxViewport} itemKey={item.id} enabled={target !== 'Measurement'}>
                <MessageView
                    message={item.message}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    copyText={agentCopyTextByMessageId.get(item.message.id)}
                />
            </DiffSyntaxCell>
        );
    }, [agentCopyTextByMessageId, props.metadata, props.sessionId, syntaxViewport, isGroupExpanded, handleToggleGroup]);

    // The list is inverted, so offset 0 is the newest message and growing
    // offsets walk back through history.
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const distanceFromNewest = Math.max(0, contentOffset.y);
        scrollMetricsRef.current.offsetY = distanceFromNewest;
        if (contentSize.height > 0) {
            scrollMetricsRef.current.contentHeight = contentSize.height;
        }
        if (layoutMeasurement.height > 0) {
            scrollMetricsRef.current.viewportHeight = layoutMeasurement.height;
        }
        fillOlderRef.current();
        updateHeaderBackdropVisibility();
        updateBottomDockVisibility(distanceFromNewest);
        const next = distanceFromNewest > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
    }, [updateBottomDockVisibility, updateHeaderBackdropVisibility]);

    const handleContentSizeChange = useCallback((_width: number, height: number) => {
        scrollMetricsRef.current.contentHeight = height;
        fillOlderRef.current();
        updateHeaderBackdropVisibility();
    }, [updateHeaderBackdropVisibility]);

    // Nothing here places the list on open. Offset 0 is both where a scroll
    // view rests by default and where the newest message is, so an inverted
    // list opens on the newest message with no scroll at all — which is the
    // whole reason the opening sequence stopped needing timers and a reveal
    // gate to hide it.
    const handleLoad = useCallback(() => {
        listReadyRef.current = true;
        reportReady();
    }, [reportReady]);

    // Offset 0 is the newest message, so returning to it is a plain scroll to
    // the origin rather than a measurement of where the content currently ends.
    const scrollToBottom = useCallback(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    // History fills in ahead of the reader. Whenever the oldest rendered
    // message is within a viewport of the screen — which includes a list too
    // short to fill it — the window grows from the store, and once the store
    // is spent one older page is fetched. Each step re-runs this on settling
    // (content size, scroll, or the page landing), so it walks back exactly
    // as far as the reader goes, stopping at exhaustion, error, or the budget.
    // History is inserted at the far end of an inverted list — beyond the
    // viewport, where it cannot shift anything the reader is looking at.
    //
    // Detection is ours, in handleScroll, not FlashList's onEndReached. That
    // callback is a latch: it fires once on entering the threshold zone and
    // re-arms only after observing the list outside it. A short window can
    // *rest* inside the zone, so the latch never re-arms and a reader scrolling
    // back through history is never heard from again.
    const sessionId = props.sessionId;
    const hasMoreOlder = props.hasMoreOlder;
    const isLoadingOlder = props.isLoadingOlder;
    const messagesRef = React.useRef(messages);
    messagesRef.current = messages;
    const paginationRef = React.useRef({ sessionId, hasMoreOlder, isLoadingOlder, olderBlocked, active: props.active });
    paginationRef.current = { sessionId, hasMoreOlder, isLoadingOlder, olderBlocked, active: props.active };
    // Window length a growth was last requested for. Scroll events keep
    // arriving inside the trigger zone while React renders the larger window,
    // and without this each one would ask for another page.
    const requestedWindowEndRef = React.useRef(0);
    // This list's own page (including a failed one until Retry); a successful
    // page bumps the counter so the effect re-checks with fresh props.
    const pendingOlderRef = React.useRef<Promise<boolean> | null>(null);
    // A settled page is assessed after its rows have had a chance to enter the
    // window. Compare the far end's identity (oldestBoundary), not the row
    // count: live rows and group expansion must not reset the budget, while a
    // page that extends the oldest collapsed turn must. null means an empty
    // list; undefined means no page is awaiting assessment.
    const olderPageRef = React.useRef<string | null | undefined>(undefined);
    const invisibleOlderPagesRef = React.useRef(0);
    const [olderSettled, setOlderSettled] = React.useState(0);
    React.useEffect(() => () => {
        pendingOlderRef.current = null;
        olderPageRef.current = undefined;
        invisibleOlderPagesRef.current = 0;
    }, [sessionId]);
    const fillOlder = useCallback(() => {
        // Measured layout only, not onLoad: FlashList never reports a first
        // layout for zero rows, and a window whose rows all group away is
        // exactly the case that must keep paging.
        const { contentHeight, viewportHeight, offsetY } = scrollMetricsRef.current;
        if (viewportHeight <= 0 || contentHeight <= 0) return;
        if (contentHeight - viewportHeight - offsetY >= viewportHeight * START_REACHED_VIEWPORTS) return;
        const all = messagesRef.current;
        const currentEnd = windowRef.current.length;
        if (all.length === 0 || currentEnd <= 0) return;
        // A growth already requested but not yet rendered.
        if (currentEnd < requestedWindowEndRef.current) return;
        const nextEnd = windowEndForTurn(all, currentEnd + WINDOW_PAGE);
        if (nextEnd > currentEnd) {
            requestedWindowEndRef.current = nextEnd;
            setOldestRenderedId(all[nextEnd - 1].id);
            return;
        }
        // Wait until any newly fetched rows have been admitted to the window
        // before deciding whether the page made visible progress.
        const pageBaseline = olderPageRef.current;
        if (pageBaseline !== undefined && pendingOlderRef.current === null) {
            olderPageRef.current = undefined;
            if (oldestBoundary(listItemsRef.current) !== pageBaseline) {
                invisibleOlderPagesRef.current = 0;
                setOlderBlocked(null);
            } else {
                invisibleOlderPagesRef.current += 1;
                if (invisibleOlderPagesRef.current >= MAX_INVISIBLE_OLDER_PAGES) {
                    setOlderBlocked('limit');
                    return;
                }
            }
        }
        // Everything the store holds is rendered; the rest is on the server.
        // The store's flag also covers background pages, but it drops before
        // this list's own request settles — a failed page would be retried by
        // that very transition — so the pending promise is tracked here too.
        const { hasMoreOlder: more, isLoadingOlder: loading, olderBlocked: blocked, active } = paginationRef.current;
        if (!active || !more || loading || blocked || pendingOlderRef.current
            || invisibleOlderPagesRef.current >= MAX_INVISIBLE_OLDER_PAGES) return;
        // Settlement re-checks through state, not directly: the promise can
        // settle before React has committed the store's new flags. Only a page
        // that moved the cursor re-checks; a no-op rests until the next
        // scroll or store change, so it cannot spin.
        const request = sync.loadOlderMessages(sessionId);
        pendingOlderRef.current = request;
        olderPageRef.current = oldestBoundary(listItemsRef.current);
        request.then(
            (advanced) => {
                if (pendingOlderRef.current !== request) return;
                pendingOlderRef.current = null;
                if (advanced) {
                    setOlderSettled((n) => n + 1);
                } else {
                    olderPageRef.current = undefined;
                }
            },
            () => {
                if (pendingOlderRef.current !== request) return;
                // Keep the request as a synchronous block until Retry: a web
                // scroll can arrive before the error state commits.
                olderPageRef.current = undefined;
                setOlderBlocked('error');
            },
        );
    }, [sessionId]);
    const fillOlderRef = React.useRef(fillOlder);
    fillOlderRef.current = fillOlder;
    // A page landing, or the window growing, is checked without waiting for a
    // scroll event: a reader parked at the oldest message is holding still.
    React.useEffect(() => {
        fillOlder();
    }, [fillOlder, messages, windowedMessages, props.isLoadingOlder, props.hasMoreOlder, props.active, olderBlocked, olderSettled]);
    const retryOlder = useCallback(() => {
        pendingOlderRef.current = null;
        setOlderBlocked(null);
    }, []);
    const loadMoreOlder = useCallback(() => {
        invisibleOlderPagesRef.current = 0;
        setOlderBlocked(null);
    }, []);
    const olderStatus = olderBlocked === 'error' && props.hasMoreOlder ? 'error'
        : olderBlocked === 'limit' && props.hasMoreOlder ? 'load-more'
        : props.isLoadingOlder && windowedMessages.length >= messages.length ? 'loading' : 'idle';

    // FlashList lacks React Native Web FlatList's inverted-wheel correction.
    // Keep the mobile coordinate system, correcting only web chat gestures.
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = listRef.current?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const handler = (e: WheelEvent) => handleInvertedChatWheel(node, e);
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, [handoffListRevision, props.sessionId]);

    return (
        <View style={{ flex: 1 }}>
            <FlashList
                key={`${props.sessionId}:${handoffListRevision}`}
                ref={listRef}
                data={listItems}
                // See MAINTAIN_VISIBLE_CONTENT_POSITION: item 0 is the newest
                // message and offset 0 is the bottom of the screen.
                inverted
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                // The measured dock inset lets the newest message scroll above
                // the floating composer instead of stopping underneath it.
                // paddingTop, not paddingBottom: the content container is
                // inside the inverted transform, so its top edge is the bottom
                // of the screen.
                contentContainerStyle={{ paddingTop: 8 + (props.bottomContentInset ?? 0) }}
                renderItem={renderItem}
                viewabilityConfig={SYNTAX_VIEWABILITY}
                onViewableItemsChanged={syntaxViewport.update}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onLayout={(event) => {
                    scrollMetricsRef.current.viewportHeight = event.nativeEvent.layout.height;
                    fillOlderRef.current();
                    updateHeaderBackdropVisibility();
                }}
                onContentSizeChange={handleContentSizeChange}
                // Swapped: the list's header sits at item 0, which an inverted
                // list draws at the bottom of the screen.
                ListHeaderComponent={<NewerEnd sessionId={props.sessionId} />}
                ListFooterComponent={(
                    <OlderEnd
                        // The store's flag also pulses on background pages the
                        // reader never sees; only a fetch this list waits on
                        // shows, and a failure shows only while it applies.
                        status={olderStatus}
                        onAction={olderStatus === 'load-more' ? loadMoreOlder : retryOlder}
                        topContentInset={props.topContentInset}
                    />
                )}
                onLoad={handleLoad}
            />
            {showScrollButton && (
                <View style={[
                    styles.scrollButtonContainer,
                    {
                        bottom: props.scrollButtonInset != null
                            ? SCROLL_BUTTON_COMPOSER_GAP + props.scrollButtonInset
                            : SCROLL_BUTTON_DOCK_GAP + (props.bottomContentInset ?? 0),
                    },
                ]}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                        ]}
                        onPress={scrollToBottom}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
        </View>
    )
});

const styles = StyleSheet.create((theme) => ({
    scrollButtonContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: SCROLL_BUTTON_DOCK_GAP,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        shadowOpacity: theme.colors.shadow.opacity * 0.5,
        elevation: 2,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.surface,
        opacity: 0.9,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.surface,
        opacity: 0.7,
    },
}));
