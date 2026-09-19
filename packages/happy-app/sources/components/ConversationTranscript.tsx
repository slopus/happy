import type { HistoryViewportReader } from '@/sync/historyWindowPolicy';
import * as React from 'react';
import { TranscriptReadOnlyContext } from './TranscriptReadOnlyContext';
import type { ScopedTranscriptItem as DisplayItem } from './continuationTranscript';
import { transcriptViewportRange } from './transcriptViewportRange';
import { reconcileTranscriptIdentities } from './transcriptWindowIdentity';
import {
    AppState,
    ActivityIndicator,
    FlatList,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    StyleProp,
    Text,
    View,
    ViewStyle,
    useWindowDimensions,
} from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { TranscriptList } from './TranscriptList';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Metadata } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import {
    type ToolGroupItem,
    useGroupedMessages,
    filterSupersededUserMessages,
} from '@/hooks/useGroupedMessages';
import { useUserMessageAnchors, type UserMessageAnchor } from '@/hooks/useUserMessageAnchors';
import { getAgentMessageForkTargets, type MessageForkTarget } from '@/utils/messageForkPoint';
import { BaseModal } from '@/modal/components/BaseModal';
import { t } from '@/text';
import { MessageView } from './MessageView';
import { AgentWorkGroupView, ToolGroupView } from './ToolGroupView';
import { AttachmentGalleryView } from './AttachmentGalleryView';
import { AnchorListSheet } from './AnchorListSheet';
import { BrowserProgressContext } from './BrowserProgressContext';
import { getBrowserStepRuns, hideLinkedBrowserSteps } from './rightPanel/browserStepRunsModel';
import { setGroupExpansion, groupIsExpanded, itemMessages, TranscriptReadingContext, TranscriptReadingMarker,
    TranscriptGroupExpansionContext, handleTranscriptWebWheel, useTranscriptReading, type TranscriptReadingAdapter } from './transcriptReading';

const SCROLL_THRESHOLD = 300;
const ANCHOR_PILL_LINGER_MS = 1600;

type ForkFromMessage = (
    messageId: string,
    rewindPointId: string | undefined,
    messageText: string,
    retainSelectedTurn?: boolean,
    messageCreatedAt?: number,
    excludeSelectedPrompt?: boolean,
) => void;

export type ConversationTranscriptProps = {
    metadata: Metadata | null;
    sessionId?: string;
    messages: Message[];
    scopedItems?: DisplayItem[];
    scopedViewport?: (items: DisplayItem[], direction: 'older' | 'newer') => ReturnType<HistoryViewportReader>;
    reading?: TranscriptReadingAdapter;
    groupToolCalls?: boolean;
    currentTurnActive?: boolean;
    followLatestRequest?: number;
    hasPendingPermission?: boolean;
    onLoadOlder?: (viewport?: HistoryViewportReader) => void;
    hasMoreOlder?: boolean;
    olderCursor?: number | null;
    boundaryScope?: string;
    isLoadingOlder?: boolean;
    onLoadNewer?: (viewport?: HistoryViewportReader) => void;
    hasMoreNewer?: boolean;
    newerCursor?: number | null;
    isLoadingNewer?: boolean;
    isAtLatest?: boolean;
    onJumpToLatest?: () => Promise<void>;
    olderError?: string | null;
    newerError?: string | null;
    visualTop?: React.ReactElement | null;
    visualBottom?: React.ReactElement | null;
    showMessageActions?: boolean;
    canEditLatestUserMessage?: boolean;
    onEditUserMessage?: (messageId: string, messageText: string) => Promise<void> | void;
    onForkFromMessage?: ForkFromMessage;
    forkingFromMessageId?: string | null;
    showAnchorNavigation?: boolean;
    showScrollToBottom?: boolean;
    inverted?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    itemContainerStyle?: StyleProp<ViewStyle>;
};

export const ConversationTranscript = React.memo((props: ConversationTranscriptProps) => {
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const flatListRef = React.useRef<FlatList>(null);
    const viewportRef = React.useRef<View>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const showScrollButtonRef = React.useRef(false);
    const [showAnchorPill, setShowAnchorPill] = React.useState(false);
    const [anchorSheetOpen, setAnchorSheetOpen] = React.useState(false);
    const [viewportHeight, setViewportHeight] = React.useState<number | null>(null);
    const [contentMeasurement, setContentMeasurement] = React.useState<{
        boundary: string;
        generation: object;
        height: number;
    } | null>(null);
    const contentMeasurementRef = React.useRef(contentMeasurement);
    const anchorPillVisibleRef = React.useRef(false);
    const anchorPillTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const indexRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const groupingOptions = React.useMemo(
        () => ({ currentTurnActive: props.currentTurnActive ?? false }),
        [props.currentTurnActive],
    );
    const browserProgress = React.useMemo(() => ({
        sessionId: props.sessionId,
        runs: props.sessionId ? getBrowserStepRuns(props.messages) : [],
    }), [props.sessionId, props.messages]);
    const transcriptMessages = React.useMemo(() => hideLinkedBrowserSteps(props.messages, browserProgress.runs),
        [props.messages, browserProgress.runs]);
    const defaultItems = useGroupedMessages(props.scopedItems ? [] : transcriptMessages, props.groupToolCalls ?? true, groupingOptions);
    const displayItems = props.scopedItems ?? defaultItems;
    const inverted = props.inverted ?? Platform.OS !== 'web';
    const invertedRef = React.useRef(inverted);
    invertedRef.current = inverted;
    const isAtLatest = props.isAtLatest ?? true;
    const [boundaries, setBoundaries] = React.useState({ older: false, newer: false });
    const attempted = React.useRef(new Set<string>());
    const jumpPending = React.useRef(false);
    const jumpRequest = React.useRef<object | null>(null);
    const userScrollStarted = React.useRef(false);
    const userScrollDirection = React.useRef<'older' | 'newer' | undefined>(undefined);
    const userScrollOffset = React.useRef<number | null>(null);
    const viewportRange = React.useRef<HistoryViewportReader>(() => undefined);
    const boundaryFill = React.useRef<{ direction: 'older' | 'newer'; key: string } | null>(null);
    const prepareBoundaryLoad = React.useRef<(isCurrent: () => boolean) => Promise<void> | void>(() => {});
    const boundaryAttemptKey = React.useCallback((direction: 'older' | 'newer') => {
        const renderedBoundary = direction === 'older' ? props.messages.at(-1)?.id : props.messages[0]?.id;
        const boundary = (direction === 'older' ? props.olderCursor : props.newerCursor)
            ?? (renderedBoundary ? props.reading?.wireId(renderedBoundary) ?? renderedBoundary : undefined);
        return JSON.stringify([props.sessionId, props.boundaryScope, direction, boundary]);
    }, [props.sessionId, props.boundaryScope, props.messages, props.reading, props.olderCursor, props.newerCursor]);
    const currentBoundaryAttemptKeys = React.useRef<string[]>([]);
    currentBoundaryAttemptKeys.current = [boundaryAttemptKey('older'), boundaryAttemptKey('newer')];
    const loadBoundary = React.useCallback((direction: 'older' | 'newer', retry = false, refill = false) => {
        const loading = direction === 'older' ? props.isLoadingOlder : props.isLoadingNewer;
        const more = direction === 'older' ? props.hasMoreOlder : props.hasMoreNewer;
        const error = direction === 'older' ? props.olderError : props.newerError;
        const load = direction === 'older' ? props.onLoadOlder : props.onLoadNewer;
        const key = boundaryAttemptKey(direction);
        if (Platform.OS === 'web' && !retry && ((!userScrollStarted.current && !refill)
            || (userScrollDirection.current === undefined && userScrollOffset.current !== null)
            || (userScrollDirection.current !== undefined && userScrollDirection.current !== direction))) return;
        if (!load || more === false || loading || (!retry && (error || attempted.current.has(key)))) return;
        attempted.current.add(key);
        const fill = { direction, key };
        boundaryFill.current = fill;
        if (attempted.current.size > 8) attempted.current.delete(attempted.current.values().next().value!);
        if (Platform.OS === 'web') userScrollStarted.current = false;
        const session = props.sessionId;
        const isCurrent = () => sessionRef.current === session && (!refill
            || (boundaryFill.current === fill && userScrollDirection.current === direction));
        const prepared = prepareBoundaryLoad.current(isCurrent);
        if (prepared) void prepared.then(() => { if (isCurrent()) load(retry && error === 'history-window-capacity' ? undefined : () => viewportRange.current()); });
        else load(retry && error === 'history-window-capacity' ? undefined : () => viewportRange.current());
    }, [boundaryAttemptKey, props.hasMoreOlder, props.hasMoreNewer, props.isLoadingOlder, props.isLoadingNewer,
        props.onLoadOlder, props.onLoadNewer, props.olderError, props.newerError]);
    const loadBoundaryRef = React.useRef(loadBoundary);
    loadBoundaryRef.current = loadBoundary;
    const previousIdentities = React.useRef<{ session: string | undefined; identities: ReturnType<typeof reconcileTranscriptIdentities>['identities'] }>({ session: undefined, identities: [] });
    const listItems = React.useMemo(() => {
        const result = reconcileTranscriptIdentities(inverted ? displayItems : [...displayItems].reverse(), props.reading,
            previousIdentities.current.session === props.sessionId ? previousIdentities.current.identities : []);
        previousIdentities.current = { session: props.sessionId, identities: result.identities };
        return result.keyed;
    }, [displayItems, inverted, props.reading, props.sessionId, props.scopedItems]);
    viewportRange.current = () => {
        if (Platform.OS !== 'web' || (!props.reading && !props.scopedViewport)) return undefined;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node?.querySelectorAll) return undefined;
        const rect = node.getBoundingClientRect();
        const keys = new Set([...node.querySelectorAll<HTMLElement>('[data-transcript-key]')].filter(row => {
            const bounds = row.getBoundingClientRect();
            return bounds.bottom > rect.top && bounds.top < rect.bottom;
        }).map(row => row.dataset.transcriptKey));
        const visibleItems = listItems.filter(item => keys.has(item.renderKey));
        if (props.scopedViewport) return props.scopedViewport(visibleItems, userScrollDirection.current ?? 'older');
        if (!props.reading) return undefined;
        const visibleMessages = visibleItems.flatMap(itemMessages);
        return transcriptViewportRange(filterSupersededUserMessages(props.messages), visibleMessages, props.reading.wireSeq,
            { oldestSeq: props.olderCursor, newestSeq: props.newerCursor });
    };
    const rowHeights = React.useRef(new Map<string, number>());
    const rowKeys = React.useRef(new Set<string>());
    rowKeys.current = new Set(listItems.map(item => item.renderKey));
    const [webHeaderHeight, setWebHeaderHeight] = React.useState(0);
    const listWidth = React.useRef<number | null>(null);
    const [heightRevision, setHeightRevision] = React.useState(0);
    React.useEffect(() => {
        // Keep bounded geometry metadata for reloaded rows, without retaining
        // message payloads or DOM. Returning to a visited page reuses its size.
        for (const key of rowHeights.current.keys()) {
            if (rowHeights.current.size <= 1000) break;
            if (!rowKeys.current.has(key)) rowHeights.current.delete(key);
        }
    }, [listItems]);
    React.useEffect(() => {
        rowHeights.current.clear();
        extent.current = { session: props.sessionId, keys: [], leading: 0, trailing: 0 };
        measurementDebt.current.clear();
        setHeightRevision(value => value + 1);
    }, [fontScale]);
    const measurementDebt = React.useRef(new Map<string, { edge: 'leading' | 'trailing'; estimate: number }>());
    const extent = React.useRef({ session: props.sessionId, keys: [] as string[], leading: 0, trailing: 0 });
    const spacers = React.useMemo(() => {
        const keys = listItems.map(item => item.renderKey);
        const previous = extent.current;
        // Initial list-width layout can invalidate measurements after child
        // onLayout has fired. Read surviving DOM geometry before this commit
        // removes those cells, rather than substituting a 160px estimate.
        const scrollNode = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (Platform.OS === 'web' && previous.keys.length && scrollNode?.querySelectorAll) {
            for (const row of scrollNode.querySelectorAll<HTMLElement>('[data-transcript-key]')) {
                const key = row.dataset.transcriptKey;
                const height = row.getBoundingClientRect().height;
                if (key && previous.keys.includes(key) && height > 0) rowHeights.current.set(key, height);
            }
        }
        const common = new Set(keys.filter(key => previous.keys.includes(key)));
        let leading = 0; let trailing = 0;
        if (Platform.OS === 'web' && !inverted && previous.session === props.sessionId && common.size && !jumpPending.current) {
            const firstOld = previous.keys.findIndex(key => common.has(key));
            const firstNew = keys.findIndex(key => common.has(key));
            const lastOld = previous.keys.findLastIndex(key => common.has(key));
            const lastNew = keys.findLastIndex(key => common.has(key));
            const height = (rows: string[]) => rows.reduce((sum, key) => sum + (rowHeights.current.get(key) ?? 160), 0);
            const before = keys.slice(0, firstNew);
            const after = keys.slice(lastNew + 1);
            leading = previous.leading + height(previous.keys.slice(0, firstOld)) - height(before);
            trailing = previous.trailing + height(previous.keys.slice(lastOld + 1)) - height(after);
            for (const [edge, added] of [['leading', before], ['trailing', after]] as const) {
                if (previous[edge] > 0) for (const key of added) {
                    measurementDebt.current.set(key, { edge, estimate: rowHeights.current.get(key) ?? 160 });
                }
            }
        }
        if (props.hasMoreOlder === false) leading = 0;
        if (props.hasMoreNewer === false) trailing = 0;
        for (const [key, debt] of measurementDebt.current) {
            if (!keys.includes(key) || (debt.edge === 'leading' ? props.hasMoreOlder === false : props.hasMoreNewer === false)) {
                measurementDebt.current.delete(key);
            }
        }
        // Keep signed balances while several restored rows are still being
        // measured. Clamping each individual correction loses overshoot and
        // can manufacture blank space when a later row measures smaller.
        if (![...measurementDebt.current.values()].some(debt => debt.edge === 'leading')) leading = Math.max(0, leading);
        if (![...measurementDebt.current.values()].some(debt => debt.edge === 'trailing')) trailing = Math.max(0, trailing);
        extent.current = { session: props.sessionId, keys, leading, trailing };
        return { leading: Math.max(0, leading), trailing: Math.max(0, trailing) };
    }, [listItems, inverted, props.sessionId, props.hasMoreOlder, props.hasMoreNewer, heightRevision]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || inverted) return;
        const fill = boundaryFill.current;
        if (!fill) return;
        const direction = fill.direction;
        const loading = direction === 'older' ? props.isLoadingOlder : props.isLoadingNewer;
        const more = direction === 'older' ? props.hasMoreOlder : props.hasMoreNewer;
        const error = direction === 'older' ? props.olderError : props.newerError;
        if (error || more === false || userScrollDirection.current !== direction) {
            boundaryFill.current = null;
            return;
        }
        if (loading || boundaryAttemptKey(direction) === fill.key) return;
        // One raw page can fold to only a few pixels. After a user-requested
        // page advances, refill known evicted content in that same direction
        // before its spacer enters the viewport. Never rearm an unchanged
        // cursor, reverse direction, or bypass a capacity/error boundary.
        const frame = requestAnimationFrame(() => {
            if (boundaryFill.current !== fill || userScrollDirection.current !== direction) return;
            const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
            const spacer = Math.max(0, extent.current[direction === 'older' ? 'leading' : 'trailing']);
            const distance = node ? direction === 'older' ? node.scrollTop - spacer
                : node.scrollHeight - node.clientHeight - node.scrollTop - spacer : Infinity;
            if (spacer > 0 && distance <= 2 * (node?.clientHeight ?? 0)) loadBoundaryRef.current(direction, false, true);
            else boundaryFill.current = null;
        });
        return () => cancelAnimationFrame(frame);
    }, [listItems, inverted, boundaryAttemptKey, heightRevision, props.isLoadingOlder, props.isLoadingNewer,
        props.hasMoreOlder, props.hasMoreNewer, props.olderError, props.newerError]);
    const webRowLayouts = React.useMemo(() => {
        let offset = webHeaderHeight + spacers.leading;
        return listItems.map((item, index) => {
            const length = rowHeights.current.get(item.renderKey) ?? 160;
            const frame = { index, offset, length };
            offset += length;
            return frame;
        });
    }, [listItems, heightRevision, webHeaderHeight, spacers.leading]);
    const getWebItemLayout = React.useCallback((_data: unknown, index: number) => webRowLayouts[index], [webRowLayouts]);
    const latestVisibleUserMessageId = React.useMemo(() => {
        for (const item of displayItems) {
            if (item.type === 'message' && item.message.kind === 'user-text') return item.message.id;
        }
        return null;
    }, [displayItems]);
    const anchors = useUserMessageAnchors(displayItems);
    const anchorsRef = React.useRef(anchors);
    anchorsRef.current = anchors;
    const hasAnchorNavigation = anchors.length > 0 || props.hasMoreOlder === true;

    const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item) && !item.hasPendingPermission) initial.add(item.id);
        }
        return initial;
    });
    const manuallyCollapsedRef = React.useRef<Set<string>>(new Set());
    const [manuallyCollapsedKeys, setManuallyCollapsedKeys] = React.useState<string[]>([]);
    const isManuallyCollapsed = React.useCallback((item: DisplayItem) => props.reading
        ? groupIsExpanded(item, manuallyCollapsedKeys, props.reading.wireId)
        : manuallyCollapsedRef.current.has(item.id), [manuallyCollapsedKeys, props.reading]);
    const recordManualCollapse = React.useCallback((item: DisplayItem, collapsed: boolean) => {
        if (collapsed) manuallyCollapsedRef.current.add(item.id); else manuallyCollapsedRef.current.delete(item.id);
        if (props.reading) setManuallyCollapsedKeys(previous => setGroupExpansion(previous, item, collapsed, props.reading!.wireId));
    }, [props.reading]);
    const [expandedKeys, setExpandedKeys] = React.useState<string[]>([]);
    const reading = useTranscriptReading({ adapter: props.reading, items: listItems, inverted, isAtLatest,
        followLatestOnLayout: Boolean(props.sessionId) || props.inverted !== false,
        synchronousAnchoring: Platform.OS === 'web' && !inverted,
        listRef: flatListRef, viewportRef, expanded: expandedKeys, restoreExpanded: setExpandedKeys });
    prepareBoundaryLoad.current = isCurrent => {
        if (Platform.OS !== 'web' || !props.reading || !viewportRef.current) return;
        return reading.capture().then(() => { if (isCurrent()) reading.pin(); });
    };
    const contentGeneration = React.useMemo(() => ({}), [collapsedGroups, expandedKeys, manuallyCollapsedKeys, props.currentTurnActive,
        props.groupToolCalls, props.messages]);
    const cancelReadingRestoreRef = React.useRef(reading.cancelRestore);
    cancelReadingRestoreRef.current = reading.cancelRestore;
    const claimScroll = React.useCallback(() => {
        userScrollStarted.current = true;
        userScrollDirection.current = undefined;
        userScrollOffset.current = null;
        cancelReadingRestoreRef.current();
    }, []);
    const seenCollapsibleGroupsRef = React.useRef<Set<string>>(new Set(
        displayItems.filter(isCollapsibleDisplayItem).map((item) => item.id),
    ));
    React.useEffect(() => {
        if (!props.reading) return;
        setExpandedKeys(previous => displayItems.reduce((keys, item) => groupIsExpanded(item, keys, props.reading!.wireId)
            ? setGroupExpansion(keys, item, true, props.reading!.wireId) : keys, previous));
        setManuallyCollapsedKeys(previous => displayItems.reduce((keys, item) => groupIsExpanded(item, keys, props.reading!.wireId)
            ? setGroupExpansion(keys, item, true, props.reading!.wireId) : keys, previous));
    }, [displayItems, props.reading]);

    React.useEffect(() => {
        setCollapsedGroups((previous) => {
            let changed = false;
            const next = new Set(previous);
            for (const item of displayItems) {
                if (!isCollapsibleDisplayItem(item)) continue;
                if (props.reading && groupIsExpanded(item, expandedKeys, props.reading.wireId)) {
                    if (next.delete(item.id)) changed = true;
                    seenCollapsibleGroupsRef.current.add(item.id);
                    continue;
                }
                const isNew = !seenCollapsibleGroupsRef.current.has(item.id);
                if (isNew) seenCollapsibleGroupsRef.current.add(item.id);
                if (isAtLatest && item.hasPendingPermission && next.has(item.id) && !isManuallyCollapsed(item)) {
                    next.delete(item.id);
                    changed = true;
                } else if (isNew && !item.hasPendingPermission) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : previous;
        });
    }, [displayItems, expandedKeys, props.reading, isAtLatest, isManuallyCollapsed]);

    const displayItemsRef = React.useRef(displayItems);
    displayItemsRef.current = displayItems;
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active' || props.reading) return;
            setCollapsedGroups((previous) => {
                const next = new Set(previous);
                for (const item of displayItemsRef.current) {
                    if (isCollapsibleDisplayItem(item) && !item.hasRunning) next.add(item.id);
                }
                return next;
            });
        });
        return () => subscription.remove();
    }, [props.reading]);

    const latestUserMessageId = React.useMemo(() => {
        for (const message of props.messages) {
            if (message.kind === 'user-text') return message.id;
        }
        return null;
    }, [props.messages]);
    const previousUserMessageIdRef = React.useRef(latestUserMessageId);
    React.useEffect(() => {
        if (!latestUserMessageId || latestUserMessageId === previousUserMessageIdRef.current) return;
        previousUserMessageIdRef.current = latestUserMessageId;
        if (!isAtLatest || props.reading) return;
        manuallyCollapsedRef.current.clear();
        setCollapsedGroups((previous) => {
            const next = new Set(previous);
            for (const item of displayItemsRef.current) {
                if (isCollapsibleDisplayItem(item)) next.add(item.id);
            }
            return next;
        });
    }, [latestUserMessageId, isAtLatest, props.reading]);

    // A newly paged group must be collapsed in its first commit. Waiting for
    // the discovery effect briefly mounts full tool output and moves the anchor.
    const isGroupExpanded = React.useCallback((item: DisplayItem) => {
        if (!isCollapsibleDisplayItem(item)) return false;
        const pending = isAtLatest && item.hasPendingPermission && !isManuallyCollapsed(item);
        return pending || (props.reading
            ? groupIsExpanded(item, expandedKeys, props.reading.wireId)
            : seenCollapsibleGroupsRef.current.has(item.id) && !collapsedGroups.has(item.id));
    }, [collapsedGroups, expandedKeys, props.reading, isAtLatest, isManuallyCollapsed]);
    const handleToggleGroup = React.useCallback((groupId: string) => {
        const item = displayItemsRef.current.find(item => item.id === groupId);
        if (!item) return;
        const expanded = isGroupExpanded(item);
        reading.pin();
        if (props.reading) {
            setExpandedKeys(previous => setGroupExpansion(previous, item, !expanded, props.reading!.wireId));
        }
        recordManualCollapse(item, expanded);
        setCollapsedGroups((previous) => {
            const next = new Set(previous);
            if (expanded) next.add(groupId); else next.delete(groupId);
            return next;
        });
    }, [isGroupExpanded, props.reading, reading, recordManualCollapse]);
    const nestedExpansion = props.reading ? {
        isExpanded: (item: DisplayItem) => groupIsExpanded(item, expandedKeys, props.reading!.wireId)
            || (isAtLatest && isCollapsibleDisplayItem(item) && item.hasPendingPermission && !isManuallyCollapsed(item)),
        toggle: (item: DisplayItem) => {
            reading.pin();
            const expanded = groupIsExpanded(item, expandedKeys, props.reading!.wireId)
                || (isAtLatest && isCollapsibleDisplayItem(item) && item.hasPendingPermission && !isManuallyCollapsed(item));
            recordManualCollapse(item, expanded);
            setExpandedKeys(previous => setGroupExpansion(previous, item, !expanded, props.reading!.wireId));
        },
        observe: (item: DisplayItem) => setExpandedKeys(previous => setGroupExpansion(previous, item, true, props.reading!.wireId)),
    } : null;
    const agentForkTargets = React.useMemo<Map<string, MessageForkTarget>>(
        () => getAgentMessageForkTargets(props.messages, {
            flavor: props.metadata?.flavor === 'codex' ? 'codex' : 'claude',
            allowMissingRewindPoint: props.metadata?.flavor === 'codex',
        }),
        [props.messages, props.metadata?.flavor],
    );
    const renderItemContent = React.useCallback(({ item }: { item: DisplayItem }) => {
        const sourceId = item.source?.sessionId ?? props.sessionId;
        const sourceMetadata = item.source ? item.source.metadata : props.metadata;
        const readOnly = item.source?.readOnly ?? false;
        if (item.continuationBoundary) return <View testID="session-continuation-boundary" style={{ padding: 20, marginVertical: 12, borderTopWidth: 1, borderColor: theme.colors.divider }}>
            <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{t('session.continueBoundary')}</Text>
            {(readOnly || item.continuationWaiting) && <Text style={{ color: theme.colors.textSecondary, marginTop: 6 }}>{t(readOnly ? 'session.continueOld' : 'session.continueWaiting')}</Text>}
        </View>;
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={sourceMetadata}
                    sessionId={sourceId}
                    expanded={isGroupExpanded(item)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        if (item.type === 'image-group') {
            return (
                <AttachmentGalleryView
                    messages={item.messages}
                    sessionId={sourceId}
                    presentation={item.presentation}
                    pendingCount={item.pendingCount}
                    pendingStartedAt={item.pendingStartedAt}
                />
            );
        }
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={sourceMetadata}
                    sessionId={sourceId}
                    expanded={isGroupExpanded(item)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        return (
            <MessageView
                message={item.message}
                metadata={sourceMetadata}
                sessionId={sourceId}
                onForkFromMessage={readOnly ? undefined : props.onForkFromMessage}
                forkingFromMessageId={props.forkingFromMessageId}
                agentForkTarget={item.message.kind === 'agent-text' ? agentForkTargets.get(item.message.id) : undefined}
                showAgentMessageActions={!readOnly && props.showMessageActions}
                showUserMessageActions={!readOnly && props.showMessageActions}
                canEditUserMessage={Boolean(
                    !readOnly && props.canEditLatestUserMessage
                    && item.message.kind === 'user-text'
                    && item.message.id === latestVisibleUserMessageId
                    && !props.hasPendingPermission
                )}
                onEditUserMessage={readOnly ? undefined : props.onEditUserMessage}
            />
        );
    }, [
        agentForkTargets,
        isGroupExpanded,
        handleToggleGroup,
        latestVisibleUserMessageId,
        props.canEditLatestUserMessage,
        props.hasPendingPermission,
        props.metadata,
        props.onEditUserMessage,
        props.onForkFromMessage,
        props.forkingFromMessageId,
        props.sessionId,
        props.showMessageActions,
        theme,
    ]);
    const renderItem = React.useCallback(({ item }: { item: DisplayItem & { renderKey: string } }) => {
        const content = <TranscriptReadingMarker messageId={itemMessages(item)[0]?.id ?? item.id}>
            {item.source ? <TranscriptReadOnlyContext.Provider value={item.source.readOnly}><BrowserProgressContext.Provider value={{ sessionId: item.source.sessionId, runs: item.source.browserRuns ?? [] }}>{renderItemContent({ item })}</BrowserProgressContext.Provider></TranscriptReadOnlyContext.Provider> : renderItemContent({ item })}
        </TranscriptReadingMarker>;
        if (Platform.OS !== 'web') {
            return props.itemContainerStyle ? <View style={props.itemContainerStyle}>{content}</View> : content;
        }
        // react-native-web supports dataSet; native View's declarations omit it.
        return <View style={props.itemContainerStyle} {...{ dataSet: { transcriptKey: item.renderKey } }} onLayout={event => {
            const height = event.nativeEvent.layout.height;
            if (rowKeys.current.has(item.renderKey) && height > 0) {
                const debt = measurementDebt.current.get(item.renderKey);
                const changed = rowHeights.current.get(item.renderKey) !== height;
                if (debt) {
                    extent.current[debt.edge] += debt.estimate - height;
                    measurementDebt.current.delete(item.renderKey);
                }
                if (changed) rowHeights.current.set(item.renderKey, height);
                if (changed || debt) setHeightRevision(value => value + 1);
            }
        }}>{content}</View>;
    }, [props.itemContainerStyle, renderItemContent]);

    const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        // Scrollbar presses have no direction until their first scroll. Wheel,
        // keys and touch already carry intent; anchor corrections must not
        // overwrite it or trigger the opposite overlapping preload boundary.
        if (Platform.OS === 'web' && userScrollStarted.current && userScrollDirection.current === undefined
            && userScrollOffset.current !== null && contentOffset.y !== userScrollOffset.current) {
            const towardEnd = contentOffset.y > userScrollOffset.current;
            userScrollDirection.current = towardEnd !== inverted ? 'newer' : 'older';
        }
        const distanceFromBottom = inverted
            ? contentOffset.y
            : Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y - Math.max(0, extent.current.trailing));
        reading.scroll(contentOffset.y, distanceFromBottom);
        const distanceFromTop = inverted ? Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y) : Math.max(0, contentOffset.y - Math.max(0, extent.current.leading));
        setBoundaries(previous => previous.older === (distanceFromTop <= 24) && previous.newer === (distanceFromBottom <= 24)
            ? previous : { older: distanceFromTop <= 24, newer: distanceFromBottom <= 24 });
        if (!isAtLatest && distanceFromBottom <= 2 * layoutMeasurement.height) loadBoundary('newer');
        if ((Platform.OS !== 'web' || userScrollStarted.current) && props.hasMoreOlder
            && ((!inverted && distanceFromTop <= 2 * layoutMeasurement.height) || distanceFromTop <= 24)) loadBoundary('older');
        const next = distanceFromBottom > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
        if (props.showAnchorNavigation !== false && hasAnchorNavigation) {
            if (!anchorPillVisibleRef.current) {
                anchorPillVisibleRef.current = true;
                setShowAnchorPill(true);
            }
            if (anchorPillTimerRef.current) clearTimeout(anchorPillTimerRef.current);
            anchorPillTimerRef.current = setTimeout(() => {
                anchorPillVisibleRef.current = false;
                setShowAnchorPill(false);
            }, ANCHOR_PILL_LINGER_MS);
        }
    }, [hasAnchorNavigation, inverted, isAtLatest, loadBoundary, reading, props.hasMoreOlder, props.showAnchorNavigation]);

    React.useEffect(() => () => {
        if (anchorPillTimerRef.current) clearTimeout(anchorPillTimerRef.current);
        if (indexRetryTimerRef.current) clearTimeout(indexRetryTimerRef.current);
    }, []);

    const scrollLatest = React.useCallback(() => {
        boundaryFill.current = null;
        if (Platform.OS === 'web') userScrollStarted.current = false;
        reading.jumpLatest();
        if (inverted) flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        else flatListRef.current?.scrollToEnd({ animated: true });
    }, [inverted, reading]);
    const sessionRef = React.useRef(props.sessionId); sessionRef.current = props.sessionId;
    const scrollToBottom = React.useCallback(async () => {
        if (isAtLatest) { scrollLatest(); return; }
        if (!props.onJumpToLatest || jumpRequest.current) return;
        const session = props.sessionId;
        const request = {}; jumpRequest.current = request;
        boundaryFill.current = null;
        jumpPending.current = true;
        try { await props.onJumpToLatest(); }
        catch { if (sessionRef.current === session) jumpPending.current = false; }
        finally { if (jumpRequest.current === request) jumpRequest.current = null; }
    }, [isAtLatest, scrollLatest, props.onJumpToLatest, props.sessionId]);
    const followLatestRequestRef = React.useRef(props.followLatestRequest ?? 0);
    React.useEffect(() => {
        const request = props.followLatestRequest ?? 0;
        if (request === followLatestRequestRef.current) return;
        followLatestRequestRef.current = request;
        if (Platform.OS === 'web') void scrollToBottom();
    }, [props.followLatestRequest, scrollToBottom]);
    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        const boundary = boundaryAttemptKey('older');
        const previous = contentMeasurementRef.current;
        const measurement = { boundary, generation: contentGeneration, height };
        contentMeasurementRef.current = measurement;
        if (Platform.OS !== 'web' && viewportHeight !== null && height < viewportHeight
            && previous?.boundary === boundary && height < previous.height) {
            attempted.current.delete(boundary);
        }
        setContentMeasurement(measurement);
        if (jumpPending.current && isAtLatest) { jumpPending.current = false; scrollLatest(); }
        else void reading.layout();
    }, [boundaryAttemptKey, contentGeneration, isAtLatest, scrollLatest, reading, viewportHeight]);
    React.useEffect(() => {
        if (Platform.OS === 'web' || contentMeasurement === null || contentMeasurement.generation === contentGeneration
            || contentMeasurement.boundary !== boundaryAttemptKey('older')) return;
        const measured = contentMeasurement;
        // Native reports a changed content height during layout. If two actual
        // render frames pass without a new report, the previous height is still
        // current and can safely follow the newly committed generation.
        let secondFrame: number | null = null;
        const firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => {
                setContentMeasurement(current => current === measured
                    ? { ...measured, generation: contentGeneration }
                    : current);
            });
        });
        return () => {
            cancelAnimationFrame(firstFrame);
            if (secondFrame !== null) cancelAnimationFrame(secondFrame);
        };
    }, [boundaryAttemptKey, contentGeneration, contentMeasurement]);
    React.useEffect(() => {
        if (Platform.OS === 'web' || viewportHeight === null || contentMeasurement === null
            || contentMeasurement.boundary !== boundaryAttemptKey('older')
            || contentMeasurement.generation !== contentGeneration || contentMeasurement.height >= viewportHeight) return;
        loadBoundary('older');
    }, [boundaryAttemptKey, contentGeneration, contentMeasurement, loadBoundary, viewportHeight]);
    React.useEffect(() => {
        if (props.newerError) jumpPending.current = false;
        else if (jumpPending.current && isAtLatest) { jumpPending.current = false; scrollLatest(); }
    }, [isAtLatest, props.newerError, scrollLatest]);
    const scrollToAnchor = React.useCallback((anchor: UserMessageAnchor) => {
        // History loads and incoming messages can shift indexes while the
        // sheet is open. Resolve the stable id against the current transcript.
        const current = anchorsRef.current.find((candidate) => candidate.id === anchor.id);
        if (!current) return;
        boundaryFill.current = null;
        if (Platform.OS === 'web') userScrollStarted.current = false;
        cancelReadingRestoreRef.current('older');
        const index = inverted ? current.displayIndex : displayItemsRef.current.length - 1 - current.displayIndex;
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    }, [inverted]);
    const handleScrollToIndexFailed = React.useCallback((info: { index: number; averageItemLength: number }) => {
        flatListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        if (indexRetryTimerRef.current) clearTimeout(indexRetryTimerRef.current);
        const session = sessionRef.current;
        indexRetryTimerRef.current = setTimeout(() => {
            if (sessionRef.current !== session) return;
            flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
        }, 120);
    }, []);
    const openAnchorSheet = React.useCallback(() => setAnchorSheetOpen(true), []);
    const closeAnchorSheet = React.useCallback(() => setAnchorSheetOpen(false), []);

    React.useEffect(() => {
        setAnchorSheetOpen(false);
        if (indexRetryTimerRef.current) clearTimeout(indexRetryTimerRef.current);
        jumpPending.current = false;
        jumpRequest.current = null;
        attempted.current.clear();
        boundaryFill.current = null;
        userScrollStarted.current = false;
        userScrollDirection.current = undefined;
        userScrollOffset.current = null;
        setBoundaries({ older: false, newer: false });
    }, [props.sessionId]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const claim = (delta?: number) => {
            const direction = delta === undefined ? undefined : delta < 0 ? 'older' : 'newer';
            if (boundaryFill.current?.direction !== direction) boundaryFill.current = null;
            for (const key of currentBoundaryAttemptKeys.current) attempted.current.delete(key);
            userScrollStarted.current = true;
            userScrollDirection.current = direction;
            userScrollOffset.current = node.scrollTop;
            cancelReadingRestoreRef.current(delta === undefined ? undefined : delta < 0 ? 'older' : 'newer');
            const maxOffset = Math.max(0, node.scrollHeight - node.clientHeight);
            const currentInverted = invertedRef.current;
            const atOlderBoundary = currentInverted ? maxOffset - node.scrollTop <= 24 : node.scrollTop - Math.max(0, extent.current.leading) <= 24;
            const atNewerBoundary = currentInverted ? node.scrollTop <= 24 : maxOffset - node.scrollTop - Math.max(0, extent.current.trailing) <= 24;
            // Keys/touch can express navigation even when no scroll event can
            // fire at the edge. Layout/anchor scrolls never rearm this gate.
            if (delta !== undefined && delta < 0 && atOlderBoundary) loadBoundaryRef.current('older');
            else if (delta !== undefined && delta > 0 && atNewerBoundary) loadBoundaryRef.current('newer');
        };
        const handler = (event: WheelEvent) => {
            const delta = event.shiftKey && Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1
                ? event.deltaX : event.deltaY;
            if (delta) handleTranscriptWebWheel(event, node, () => claim(delta));
        };
        const interactiveTarget = (event: Event) => event.target instanceof Element
            && event.target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="textbox"]');
        const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || interactiveTarget(event)) return;
            const delta = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1
                : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1
                : event.key === ' ' ? (event.shiftKey ? -1 : 1) : 0;
            if (delta) claim(delta);
        };
        const pointerdown = (event: PointerEvent) => {
            if (event.defaultPrevented || event.button !== 0 || event.target !== node || node.scrollHeight <= node.clientHeight) return;
            const rect = node.getBoundingClientRect();
            // Native scrollbar presses target the scroller itself. Include
            // its overlay strip, while leaving content clicks/selection alone.
            const x = event.clientX - rect.left;
            if (x >= Math.min(node.clientLeft + node.clientWidth, rect.width - 16)
                || (node.clientLeft > 0 && x < node.clientLeft)) claim();
        };
        let touch: { x: number; y: number } | null = null;
        const touchstart = (event: TouchEvent) => {
            touch = event.touches.length === 1 && !interactiveTarget(event)
                ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
        };
        const touchmove = (event: TouchEvent) => {
            if (!touch || event.defaultPrevented || event.touches.length !== 1) return;
            const next = event.touches[0];
            const delta = touch.y - next.clientY;
            if (Math.abs(delta) > Math.abs(touch.x - next.clientX)) claim(delta);
            touch = { x: next.clientX, y: next.clientY };
        };
        const touchend = () => { touch = null; };
        node.addEventListener('keydown', keydown);
        node.addEventListener('pointerdown', pointerdown);
        node.addEventListener('touchstart', touchstart, { passive: true });
        node.addEventListener('touchmove', touchmove, { passive: true });
        node.addEventListener('touchend', touchend);
        node.addEventListener('touchcancel', touchend);
        node.addEventListener('wheel', handler, { passive: false });
        return () => {
            node.removeEventListener('wheel', handler);
            node.removeEventListener('keydown', keydown);
            node.removeEventListener('pointerdown', pointerdown);
            node.removeEventListener('touchstart', touchstart);
            node.removeEventListener('touchmove', touchmove);
            node.removeEventListener('touchend', touchend);
            node.removeEventListener('touchcancel', touchend);
        };
    }, []);

    return (
        <BrowserProgressContext.Provider value={browserProgress}>
        <TranscriptReadingContext.Provider value={reading.markers}>
        <TranscriptGroupExpansionContext.Provider value={nestedExpansion}>
        <View ref={viewportRef} collapsable={false} style={styles.container}>
            <TranscriptList<DisplayItem & { renderKey: string }>
                ref={flatListRef}
                testID="conversation-transcript-list"
                data={listItems}
                inverted={inverted}
                keyExtractor={(item) => item.renderKey}
                disableVirtualization={false}
                // Normal Web orientation avoids inverted dynamic-height feedback.
                // Stable wire keys keep surviving media mounted through replay.
                initialNumToRender={Platform.OS === 'web' ? 10 : undefined}
                windowSize={Platform.OS === 'web' ? 5 : undefined}
                maxToRenderPerBatch={Platform.OS === 'web' ? 10 : undefined}
                // RN Web otherwise clips the tail spacer at the last measured
                // index, making unmeasured anchors/latest impossible to seek.
                // Estimates mount the target; reading markers correct its offset.
                getItemLayout={Platform.OS === 'web' ? getWebItemLayout : undefined}
                {...(Platform.OS === 'web' ? { onAnchorOffsetChange: reading.adjustOffset } : {})}
                maintainVisibleContentPosition={inverted
                    ? { minIndexForVisible: 0, ...(isAtLatest ? { autoscrollToTopThreshold: 50 } : {}) }
                    : undefined}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                contentContainerStyle={props.contentContainerStyle}
                renderItem={renderItem}
                onLayout={(event) => {
                    const { width, height } = event.nativeEvent.layout;
                    setViewportHeight(height);
                    if (Platform.OS === 'web' && width !== listWidth.current) {
                        reading.pin();
                        listWidth.current = width;
                        rowHeights.current.clear();
                        extent.current = { session: props.sessionId, keys: [], leading: 0, trailing: 0 };
                        measurementDebt.current.clear();
                        setHeightRevision(value => value + 1);
                    }
                }}
                onScroll={handleScroll}
                onScrollBeginDrag={claimScroll}
                onContentSizeChange={onContentSizeChange}
                scrollEventThrottle={16}
                ListHeaderComponent={Platform.OS === 'web' && !inverted ? <View>
                    <View testID="transcript-history-leading" style={{ height: spacers.leading }} />
                    <View onLayout={event => setWebHeaderHeight(event.nativeEvent.layout.height)}>{props.visualTop}</View>
                </View> : (inverted ? props.visualBottom : props.visualTop) ?? undefined}
                ListFooterComponent={Platform.OS === 'web' && !inverted && (props.visualBottom || spacers.trailing > 0) ? <View>
                    {props.visualBottom}
                    <View testID="transcript-history-trailing" style={{ height: spacers.trailing }} />
                </View> : (inverted ? props.visualTop : props.visualBottom) ?? undefined}
                onEndReached={() => loadBoundary(inverted ? 'older' : 'newer')}
                onStartReached={!inverted ? () => {
                    if (Platform.OS !== 'web' || userScrollStarted.current) loadBoundary('older');
                } : undefined}
                onStartReachedThreshold={2}
                // Start the next backward page before the user reaches the
                // visual top. Existing messages stay interactive while the
                // request runs, and the loading affordance is normally kept
                // outside the viewport instead of flashing on every page.
                onEndReachedThreshold={2}
                onScrollToIndexFailed={handleScrollToIndexFailed}
            />
            <HistoryBoundary direction="older" reached={boundaries.older} loading={props.isLoadingOlder}
                error={props.olderError} retry={() => loadBoundary('older', true)} />
            <HistoryBoundary direction="newer" reached={boundaries.newer && !isAtLatest} loading={props.isLoadingNewer}
                error={props.newerError} retry={() => loadBoundary('newer', true)} />
            {props.showAnchorNavigation !== false && showAnchorPill && hasAnchorNavigation ? (
                <Animated.View
                    entering={FadeIn.duration(180)}
                    exiting={FadeOut.duration(260)}
                    style={[styles.anchorPillContainer, { pointerEvents: 'box-none' }]}
                >
                    <Pressable testID="conversation-anchors-button" accessibilityRole="button" onPress={openAnchorSheet} style={({ pressed }) => [styles.anchorPill, pressed && styles.anchorPillPressed]}>
                        <Octicons name="list-unordered" size={14} color={theme.colors.text} />
                        <Text style={styles.anchorPillLabel}>{t('session.anchorsButton')}</Text>
                        <Text testID="conversation-anchors-count" style={styles.anchorPillCount}>{props.hasMoreOlder ? `${anchors.length}+` : anchors.length}</Text>
                    </Pressable>
                </Animated.View>
            ) : null}
            {props.showAnchorNavigation !== false && anchorSheetOpen ? (
                <BaseModal visible onClose={closeAnchorSheet} accessibilityLabel={t('session.anchorsTitle')}>
                    <AnchorListSheet
                        anchors={anchors}
                        hasMoreOlder={props.hasMoreOlder}
                        isLoadingOlder={props.isLoadingOlder}
                        onLoadOlder={props.onLoadOlder}
                        onSelect={scrollToAnchor}
                        onClose={closeAnchorSheet}
                    />
                </BaseModal>
            ) : null}
            {props.showScrollToBottom !== false && (showScrollButton || !isAtLatest) ? (
                <View style={styles.scrollButtonContainer}>
                    <Pressable
                        testID="conversation-scroll-to-bottom"
                        accessibilityRole="button"
                        accessibilityLabel={t('session.scrollToBottom')}
                        style={({ pressed }) => [styles.scrollButton, pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault]}
                        onPress={() => { void scrollToBottom(); }}
                    >
                        <Octicons testID="conversation-scroll-to-bottom-icon" name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            ) : null}
        </View>
        </TranscriptGroupExpansionContext.Provider>
        </TranscriptReadingContext.Provider>
        </BrowserProgressContext.Provider>
    );
});

function HistoryBoundary(props: { direction: 'older' | 'newer'; reached: boolean; loading?: boolean; error?: string | null; retry: () => void }) {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
        setVisible(false);
        if (!props.reached || !props.loading) return;
        const timer = setTimeout(() => setVisible(true), 250);
        return () => clearTimeout(timer);
    }, [props.reached, props.loading]);
    if (!props.reached || (!visible && !props.error)) return null;
    return <View style={{ position: 'absolute', [props.direction === 'older' ? 'top' : 'bottom']: 0, left: 0, right: 0,
        height: 36, alignItems: 'center', justifyContent: 'center' }}>
        {props.error ? <Pressable testID={`history-${props.direction}-retry`} accessibilityRole="button" onPress={props.retry}>
            <Text style={{ color: theme.colors.text }}>{t(props.error === 'history-window-capacity' ? 'common.continue' : 'common.retry')}</Text>
        </Pressable> : <ActivityIndicator testID={`history-${props.direction}-loading`} size="small" />}
    </View>;
}

function isCollapsibleDisplayItem(
    item: DisplayItem,
): item is ToolGroupItem | Extract<DisplayItem, { type: 'agent-work-group' }> {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1 },
    scrollButtonContainer: {
        position: 'absolute', right: 16, bottom: 16, alignItems: 'flex-end', justifyContent: 'center', pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
        borderColor: theme.colors.divider, shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2, shadowOpacity: theme.colors.shadow.opacity * 0.5, elevation: 2,
    },
    scrollButtonDefault: { backgroundColor: theme.colors.surface, opacity: 0.9 },
    scrollButtonPressed: { backgroundColor: theme.colors.surface, opacity: 0.7 },
    anchorPillContainer: {
        position: 'absolute', right: 16, bottom: 60, alignItems: 'flex-end', justifyContent: 'center', pointerEvents: 'box-none',
    },
    anchorPill: {
        flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 14, height: 34,
        borderRadius: 17, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6,
        shadowOpacity: theme.colors.shadow.opacity, elevation: 3,
    },
    anchorPillPressed: { opacity: 0.7 },
    anchorPillLabel: { fontSize: 13, fontWeight: '600' as const, color: theme.colors.text },
    anchorPillCount: { fontSize: 11, fontWeight: '700' as const, color: theme.colors.textSecondary },
}));
