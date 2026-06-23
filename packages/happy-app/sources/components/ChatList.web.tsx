import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useLocalSettingMutable, useSession, useSessionGitStatusFiles, useSessionMessages, useSetting } from '@/sync/storage';
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
import {
    useSessionDocumentIndex,
    type SessionDocumentItem,
    type SessionDocumentType,
} from '@/utils/sessionDocuments';

const SCROLL_THRESHOLD = 300;
const LOAD_OLDER_THRESHOLD = 600;
const OUTLINE_PAGE_SIZE = 20;
const DOCUMENT_FILTERS: Array<{ key: 'all' | SessionDocumentType; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'markdown', label: 'Markdown' },
    { key: 'code', label: '代码' },
    { key: 'image', label: '图片' },
    { key: 'data', label: '数据' },
    { key: 'document', label: '文档' },
    { key: 'other', label: '其他' },
];

type TopSpacerRow = { type: 'top-spacer'; id: string };
type FooterRow = { type: 'footer'; id: string };
type ItemRow = { type: 'item'; id: string; item: DisplayItem };
type VirtualRow = TopSpacerRow | ItemRow | FooterRow;
type OutlineItem = {
    id: string;
    rowIndex: number;
    title: string;
};
type SidePanelMode = 'outline' | 'documents';

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

    if (props.items.length === 0) {
        return <div style={panelEmptyStyle}>本次会话还没有问题大纲</div>;
    }
    const visibleItems = props.items.slice(-visibleCount);
    const hasMore = visibleCount < props.items.length;

    React.useLayoutEffect(() => {
        if (!shouldScrollToBottomRef.current) return;
        const node = listRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        shouldScrollToBottomRef.current = false;
    }, [props.sessionId, visibleItems.length]);

    return (
        <div ref={listRef} style={panelListStyle}>
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
    );
});

const SessionDocumentsPanel = React.memo((props: {
    documents: SessionDocumentItem[];
    onOpenFile: (path: string) => void;
}) => {
    const [query, setQuery] = React.useState('');
    const [filter, setFilter] = React.useState<'all' | SessionDocumentType>('all');

    const filteredDocuments = React.useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        return props.documents.filter((item) => {
            if (filter !== 'all' && item.type !== filter) return false;
            if (!normalizedQuery) return true;
            return item.path.toLowerCase().includes(normalizedQuery)
                || item.name.toLowerCase().includes(normalizedQuery)
                || (item.ext ?? '').toLowerCase().includes(normalizedQuery);
        });
    }, [filter, props.documents, query]);

    return (
        <div style={documentsPanelStyle}>
            <input
                value={query}
                placeholder="搜索文件"
                style={documentsSearchStyle}
                onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <div style={documentsFilterRowStyle}>
                {DOCUMENT_FILTERS.map((item) => (
                    <button
                        key={item.key}
                        type="button"
                        style={{
                            ...documentsFilterButtonStyle,
                            ...(filter === item.key ? documentsFilterButtonActiveStyle : null),
                        }}
                        onClick={() => setFilter(item.key)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
            <div style={panelListStyle}>
                {filteredDocuments.length === 0 ? (
                    <div style={panelEmptyStyle}>
                        {props.documents.length === 0 ? '本次会话还没有产出文件' : '没有匹配的文件'}
                    </div>
                ) : filteredDocuments.map((item) => (
                    <button
                        key={item.path}
                        type="button"
                        title={item.path}
                        style={documentItemStyle}
                        onClick={() => props.onOpenFile(item.path)}
                    >
                        <span style={documentIconStyle}>
                            <Octicons name={getDocumentIcon(item)} size={14} color="rgba(128, 128, 128, 0.9)" />
                        </span>
                        <span style={documentMainStyle}>
                            <span style={documentNameStyle}>{item.name}</span>
                            <span style={documentPathStyle}>{item.path}</span>
                        </span>
                        <span style={documentStatusStyle}>{getDocumentStatusLabel(item.status)}</span>
                    </button>
                ))}
            </div>
        </div>
    );
});

const SessionSidePanel = React.memo((props: {
    mode: SidePanelMode;
    visible: boolean;
    outlineItems: OutlineItem[];
    documents: SessionDocumentItem[];
    sessionId: string;
    onModeChange: (mode: SidePanelMode) => void;
    onToggleVisible: () => void;
    onJumpToOutline: (rowIndex: number) => void;
    onOpenDocument: (path: string) => void;
}) => {
    if (!props.visible) {
        return (
            <aside style={sidePanelCollapsedContainerStyle}>
                <button
                    type="button"
                    title="打开侧边栏"
                    aria-label="打开侧边栏"
                    style={sidePanelToggleButtonStyle}
                    onClick={props.onToggleVisible}
                >
                    ›
                </button>
            </aside>
        );
    }

    return (
        <aside style={sidePanelContainerStyle}>
            <div style={sidePanelHeaderStyle}>
                <div style={sidePanelTabsStyle}>
                    <button
                        type="button"
                        title="大纲"
                        aria-label="大纲"
                        style={{
                            ...sidePanelTabButtonStyle,
                            ...(props.mode === 'outline' ? sidePanelTabButtonActiveStyle : null),
                        }}
                        onClick={() => props.onModeChange('outline')}
                    >
                        <Octicons name="list-unordered" size={14} />
                    </button>
                    <button
                        type="button"
                        title="文档"
                        aria-label="文档"
                        style={{
                            ...sidePanelTabButtonStyle,
                            ...(props.mode === 'documents' ? sidePanelTabButtonActiveStyle : null),
                        }}
                        onClick={() => props.onModeChange('documents')}
                    >
                        <Octicons name="file-directory" size={14} />
                    </button>
                </div>
                <button
                    type="button"
                    title="隐藏侧边栏"
                    aria-label="隐藏侧边栏"
                    style={sidePanelToggleButtonStyle}
                    onClick={props.onToggleVisible}
                >
                    ‹
                </button>
            </div>
            {props.mode === 'outline' ? (
                <QuestionOutline
                    items={props.outlineItems}
                    sessionId={props.sessionId}
                    onJump={props.onJumpToOutline}
                />
            ) : (
                <SessionDocumentsPanel
                    documents={props.documents}
                    onOpenFile={props.onOpenDocument}
                />
            )}
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
    const router = useRouter();
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const showScrollButtonRef = React.useRef(false);
    const isAtBottomRef = React.useRef(true);
    const loadingOlderRef = React.useRef(false);
    const [sidePanelVisible, setSidePanelVisible] = useLocalSettingMutable('chatOutlineVisible');
    const [sidePanelMode, setSidePanelMode] = useLocalSettingMutable('chatSidePanelMode');
    const gitStatusFiles = useSessionGitStatusFiles(props.sessionId);
    const sessionDocuments = useSessionDocumentIndex(props.sessionId, props.messages, props.metadata, gitStatusFiles);

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

    const handleOpenDocument = useCallback((path: string) => {
        router.push(`/session/${props.sessionId}/file?path=${btoa(path)}`);
    }, [props.sessionId, router]);

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
                <SessionSidePanel
                    mode={sidePanelMode}
                    visible={sidePanelVisible}
                    outlineItems={outlineItems}
                    documents={sessionDocuments}
                    sessionId={props.sessionId}
                    onModeChange={setSidePanelMode}
                    onToggleVisible={() => setSidePanelVisible(!sidePanelVisible)}
                    onJumpToOutline={scrollToRow}
                    onOpenDocument={handleOpenDocument}
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

function getDocumentIcon(item: SessionDocumentItem): React.ComponentProps<typeof Octicons>['name'] {
    if (item.status === 'deleted') return 'trash';
    if (item.type === 'image') return 'image';
    if (item.type === 'markdown' || item.type === 'document') return 'file';
    if (item.type === 'data') return 'database';
    if (item.type === 'code') return 'code-square';
    return 'file';
}

function getDocumentStatusLabel(status: SessionDocumentItem['status']) {
    switch (status) {
        case 'created':
            return '新增';
        case 'deleted':
            return '删除';
        default:
            return '修改';
    }
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

const sidePanelContainerStyle: React.CSSProperties = {
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

const sidePanelCollapsedContainerStyle: React.CSSProperties = {
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

const sidePanelHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '0 4px 10px 4px',
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(128, 128, 128, 0.9)',
};

const sidePanelTabsStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: 2,
    borderRadius: 8,
    background: 'rgba(128, 128, 128, 0.08)',
};

const sidePanelTabButtonStyle: React.CSSProperties = {
    width: 28,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    color: 'rgba(128, 128, 128, 0.85)',
    cursor: 'pointer',
};

const sidePanelTabButtonActiveStyle: React.CSSProperties = {
    background: 'rgba(128, 128, 128, 0.18)',
    color: 'inherit',
};

const sidePanelToggleButtonStyle: React.CSSProperties = {
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

const panelListStyle: React.CSSProperties = {
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

const documentsPanelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
    gap: 8,
};

const documentsSearchStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid rgba(128, 128, 128, 0.22)',
    borderRadius: 8,
    background: 'rgba(128, 128, 128, 0.08)',
    color: 'inherit',
    padding: '7px 9px',
    fontSize: 12,
    lineHeight: '16px',
    outline: 'none',
};

const documentsFilterRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
    paddingBottom: 2,
};

const documentsFilterButtonStyle: React.CSSProperties = {
    flex: '0 0 auto',
    border: 0,
    borderRadius: 999,
    background: 'transparent',
    color: 'rgba(128, 128, 128, 0.9)',
    padding: '5px 8px',
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: '14px',
    whiteSpace: 'nowrap',
};

const documentsFilterButtonActiveStyle: React.CSSProperties = {
    background: 'rgba(128, 128, 128, 0.18)',
    color: 'inherit',
};

const documentItemStyle: React.CSSProperties = {
    width: '100%',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    border: 0,
    borderRadius: 8,
    background: 'transparent',
    padding: '8px',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
};

const documentIconStyle: React.CSSProperties = {
    width: 20,
    height: 20,
    minWidth: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
};

const documentMainStyle: React.CSSProperties = {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
};

const documentNameStyle: React.CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    lineHeight: '16px',
};

const documentPathStyle: React.CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'rgba(128, 128, 128, 0.82)',
    fontSize: 11,
    lineHeight: '15px',
};

const documentStatusStyle: React.CSSProperties = {
    flex: '0 0 auto',
    color: 'rgba(128, 128, 128, 0.82)',
    fontSize: 11,
    lineHeight: '15px',
};

const panelEmptyStyle: React.CSSProperties = {
    color: 'rgba(128, 128, 128, 0.82)',
    fontSize: 12,
    lineHeight: '18px',
    padding: '16px 8px',
    textAlign: 'center',
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
