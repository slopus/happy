import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useLocalSettingMutable, useSession, useSessionMessages, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { DuplicateSheet } from './DuplicateSheet';
import { ChatFooter } from './ChatFooter';
import { Metadata, Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { DisplayItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import { Modal } from '@/modal';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';

const SCROLL_THRESHOLD = 300;
const LOAD_OLDER_THRESHOLD = 600;
const OUTLINE_PAGE_SIZE = 20;

type TopSpacerRow = { type: 'top-spacer'; id: string };
type FooterRow = { type: 'footer'; id: string };
type ItemRow = { type: 'item'; id: string; item: DisplayItem };
type VirtualRow = TopSpacerRow | ItemRow | FooterRow;
type OutlineItem = {
    id: string;
    rowIndex: number;
    title: string;
};

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
        />
    );
});

const TopSpacer = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();

    return (
        <View>
            {props.isLoadingOlder && (
                <View style={styles.loadingOlder}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const Footer = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    );
});

const QuestionOutline = React.memo((props: {
    items: OutlineItem[];
    sessionId: string;
    visible: boolean;
    onToggleVisible: () => void;
    onJump: (rowIndex: number) => void;
}) => {
    const [visibleCount, setVisibleCount] = React.useState(OUTLINE_PAGE_SIZE);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const shouldScrollToBottomRef = React.useRef(false);

    React.useEffect(() => {
        setVisibleCount(OUTLINE_PAGE_SIZE);
        shouldScrollToBottomRef.current = true;
    }, [props.sessionId]);

    React.useEffect(() => {
        setVisibleCount((count) => Math.min(Math.max(count, OUTLINE_PAGE_SIZE), Math.max(props.items.length, OUTLINE_PAGE_SIZE)));
    }, [props.items.length]);

    if (props.items.length === 0) return null;
    const visibleItems = props.items.slice(-visibleCount);
    const hasMore = visibleCount < props.items.length;

    React.useLayoutEffect(() => {
        if (!props.visible || !shouldScrollToBottomRef.current) return;
        const node = listRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        shouldScrollToBottomRef.current = false;
    }, [props.visible, props.sessionId, visibleItems.length]);

    if (!props.visible) {
        return (
            <aside style={outlineCollapsedContainerStyle}>
                <button
                    type="button"
                    title="打开大纲"
                    aria-label="打开大纲"
                    style={outlineToggleButtonStyle}
                    onClick={props.onToggleVisible}
                >
                    ›
                </button>
            </aside>
        );
    }

    return (
        <aside style={outlineContainerStyle}>
            <div style={outlineHeaderStyle}>
                <span>大纲</span>
                <button
                    type="button"
                    title="隐藏大纲"
                    aria-label="隐藏大纲"
                    style={outlineToggleButtonStyle}
                    onClick={props.onToggleVisible}
                >
                    ‹
                </button>
            </div>
            <div ref={listRef} style={outlineListStyle}>
                {hasMore && (
                    <button
                        type="button"
                        style={outlineMoreButtonStyle}
                        onClick={() => setVisibleCount((count) => count + OUTLINE_PAGE_SIZE)}
                    >
                        查看更多
                    </button>
                )}
                {visibleItems.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        title={item.title}
                        style={outlineItemStyle}
                        onClick={() => props.onJump(item.rowIndex)}
                    >
                        <span aria-hidden="true" style={outlineDotStyle} />
                        <span style={outlineTitleStyle}>{item.title}</span>
                    </button>
                ))}
            </div>
        </aside>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null;
    sessionId: string;
    messages: Message[];
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
}) => {
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const showScrollButtonRef = React.useRef(false);
    const isAtBottomRef = React.useRef(true);
    const loadingOlderRef = React.useRef(false);
    const [outlineVisible, setOutlineVisible] = useLocalSettingMutable('chatOutlineVisible');

    const groupToolCalls = useSetting('groupToolCalls');
    const displayItems = useGroupedMessages(props.messages, groupToolCalls);

    const [toggledGroups, setToggledGroups] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        setToggledGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of displayItems) {
                if (item.type === 'tool-group' && !item.hasRunning && prev.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [displayItems]);

    const handleToggleGroup = useCallback((groupId: string) => {
        setToggledGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    }, []);

    const rows = React.useMemo<VirtualRow[]>(() => {
        const chronologicalItems = displayItems.slice().reverse();
        return [
            { type: 'top-spacer', id: '__top-spacer' },
            ...chronologicalItems.map((item): ItemRow => ({ type: 'item', id: item.id, item })),
            { type: 'footer', id: '__footer' },
        ];
    }, [displayItems]);

    const outlineItems = React.useMemo<OutlineItem[]>(() => {
        return rows.flatMap((row, index) => {
            if (row.type !== 'item' || row.item.type !== 'message' || row.item.message.kind !== 'user-text') {
                return [];
            }
            const title = formatOutlineTitle(row.item.message.displayText ?? row.item.message.text);
            if (!title) return [];
            return [{ id: row.item.message.id, rowIndex: index, title }];
        });
    }, [rows]);

    const estimateSize = React.useCallback((index: number) => {
        const row = rows[index];
        if (!row) return 120;
        if (row.type === 'top-spacer') return props.isLoadingOlder ? 120 : 88;
        if (row.type === 'footer') return 96;
        if (row.item.type === 'tool-group') {
            const defaultExpanded = row.item.hasRunning;
            const expanded = toggledGroups.has(row.item.id) ? !defaultExpanded : defaultExpanded;
            return expanded ? 220 : 54;
        }
        return row.item.message.kind === 'agent-text' ? 180 : 96;
    }, [props.isLoadingOlder, rows, toggledGroups]);

    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        getItemKey: (index) => rows[index]?.id ?? index,
        estimateSize,
        overscan: 8,
        anchorTo: 'end',
        scrollEndThreshold: 80,
        useAnimationFrameWithResizeObserver: true,
        measureElement: (element) => element.getBoundingClientRect().height,
    });
    const totalSize = virtualizer.getTotalSize();
    const virtualizerRef = React.useRef(virtualizer);
    const rowsLengthRef = React.useRef(rows.length);
    virtualizerRef.current = virtualizer;
    rowsLengthRef.current = rows.length;

    React.useLayoutEffect(() => {
        virtualizer.measure();
    }, [toggledGroups, virtualizer]);

    const session = useSession(props.sessionId);
    const { canFork } = useSessionQuickActions(session, {});

    const handleForkFromMessage = useCallback((_messageId: string, claudeUuid: string) => {
        Modal.show({
            component: DuplicateSheet,
            props: {
                sessionId: props.sessionId,
                initialClaudeUuid: claudeUuid,
            },
        } as any);
    }, [props.sessionId]);

    const renderDisplayItem = useCallback((item: DisplayItem) => {
        if (item.type === 'tool-group') {
            const defaultExpanded = item.hasRunning;
            const expanded = toggledGroups.has(item.id) ? !defaultExpanded : defaultExpanded;
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={expanded}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }

        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                onForkFromUserMessage={canFork ? handleForkFromMessage : undefined}
            />
        );
    }, [props.metadata, props.sessionId, canFork, handleForkFromMessage, toggledGroups, handleToggleGroup]);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        const node = scrollRef.current;
        if (!node) return;
        virtualizerRef.current.scrollToIndex(Math.max(rowsLengthRef.current - 1, 0), { align: 'end', behavior });
        node.scrollTo({ top: node.scrollHeight, behavior });
        isAtBottomRef.current = true;
        showScrollButtonRef.current = false;
        setShowScrollButton(false);
    }, []);

    const scrollToRow = useCallback((rowIndex: number) => {
        virtualizerRef.current.scrollToIndex(rowIndex, { align: 'start', behavior: 'smooth' });
        isAtBottomRef.current = false;
        showScrollButtonRef.current = true;
        setShowScrollButton(true);
    }, []);

    const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                scrollToBottom(behavior);
            });
        });
    }, [scrollToBottom]);

    const handleLoadOlder = useCallback(() => {
        if (!props.hasMoreOlder || props.isLoadingOlder || loadingOlderRef.current) return;
        loadingOlderRef.current = true;
        void sync.loadOlderMessages(props.sessionId).finally(() => {
            loadingOlderRef.current = false;
        });
    }, [props.hasMoreOlder, props.isLoadingOlder, props.sessionId]);

    const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        const node = event.currentTarget;
        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
        const atBottom = distanceFromBottom < 80;
        isAtBottomRef.current = atBottom;

        const nextShowScrollButton = distanceFromBottom > SCROLL_THRESHOLD;
        if (nextShowScrollButton !== showScrollButtonRef.current) {
            showScrollButtonRef.current = nextShowScrollButton;
            setShowScrollButton(nextShowScrollButton);
        }

        if (node.scrollTop < LOAD_OLDER_THRESHOLD) {
            handleLoadOlder();
        }
    }, [handleLoadOlder]);

    React.useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;

        const handler = (event: WheelEvent) => {
            if (event.shiftKey && Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1) {
                node.scrollTop += event.deltaX;
                event.preventDefault();
            }
        };

        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);

    const latestMessage = props.messages[0];
    const latestMessageSignature = React.useMemo(() => {
        if (!latestMessage) return 'none';
        if (latestMessage.kind === 'agent-text' || latestMessage.kind === 'user-text') {
            return `${latestMessage.id}:${latestMessage.text.length}`;
        }
        if (latestMessage.kind === 'tool-call') {
            return `${latestMessage.id}:${latestMessage.tool.state}:${JSON.stringify(latestMessage.tool.result ?? '').length}`;
        }
        return latestMessage.id;
    }, [latestMessage]);

    React.useLayoutEffect(() => {
        isAtBottomRef.current = true;
        showScrollButtonRef.current = false;
        setShowScrollButton(false);
        scheduleScrollToBottom('auto');
    }, [props.sessionId, scheduleScrollToBottom]);

    React.useLayoutEffect(() => {
        if (!isAtBottomRef.current) return;
        scheduleScrollToBottom('auto');
    }, [latestMessageSignature, rows.length, totalSize, scheduleScrollToBottom]);

    return (
        <View style={styles.container}>
            <div style={chatShellStyle}>
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    style={scrollContainerStyle}
                >
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: '100%',
                            position: 'relative',
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const row = rows[virtualRow.index];
                            if (!row) return null;

                            return (
                                <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    {row.type === 'top-spacer' ? (
                                        <TopSpacer isLoadingOlder={props.isLoadingOlder} />
                                    ) : row.type === 'footer' ? (
                                        <Footer sessionId={props.sessionId} />
                                    ) : (
                                        renderDisplayItem(row.item)
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
                <QuestionOutline
                    items={outlineItems}
                    sessionId={props.sessionId}
                    visible={outlineVisible}
                    onToggleVisible={() => setOutlineVisible(!outlineVisible)}
                    onJump={scrollToRow}
                />
            </div>
            {showScrollButton && (
                <View style={styles.scrollButtonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault,
                        ]}
                        onPress={() => scrollToBottom()}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
        </View>
    );
});

function formatOutlineTitle(text: string) {
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

const chatShellStyle: React.CSSProperties = {
    height: '100%',
    display: 'flex',
    flexDirection: 'row',
    minWidth: 0,
};

const scrollContainerStyle: React.CSSProperties = {
    height: '100%',
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    position: 'relative',
    WebkitOverflowScrolling: 'touch',
};

const outlineContainerStyle: React.CSSProperties = {
    width: 248,
    minWidth: 248,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid rgba(128, 128, 128, 0.18)',
    padding: '72px 10px 16px',
    boxSizing: 'border-box',
    overflow: 'hidden',
};

const outlineCollapsedContainerStyle: React.CSSProperties = {
    width: 42,
    minWidth: 42,
    height: '100%',
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'center',
    borderLeft: '1px solid rgba(128, 128, 128, 0.18)',
    paddingTop: 72,
    boxSizing: 'border-box',
};

const outlineHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '0 4px 8px 8px',
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(128, 128, 128, 0.9)',
};

const outlineToggleButtonStyle: React.CSSProperties = {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    color: 'rgba(128, 128, 128, 0.9)',
    cursor: 'pointer',
    fontSize: 20,
    lineHeight: '20px',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
};

const outlineListStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: 2,
};

const outlineItemStyle: React.CSSProperties = {
    width: '100%',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    padding: '7px 8px',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
};

const outlineDotStyle: React.CSSProperties = {
    width: 6,
    height: 6,
    minWidth: 6,
    marginTop: 6,
    borderRadius: '50%',
    background: 'rgba(128, 128, 128, 0.55)',
};

const outlineTitleStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: 12,
    lineHeight: '18px',
};

const outlineMoreButtonStyle: React.CSSProperties = {
    width: '100%',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    padding: '8px',
    color: 'rgba(128, 128, 128, 0.9)',
    cursor: 'pointer',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: '16px',
};

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        position: 'relative',
    },
    loadingOlder: {
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scrollButtonContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 12,
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
