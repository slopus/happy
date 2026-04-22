import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTurnIndices, navigateTurn, NavigateAction, TurnInfo } from '@/hooks/useTurnIndices';

const SCROLL_THRESHOLD = 300;

export interface ChatListHandle {
    prevTurn: () => void;
    nextTurn: () => void;
    prevPage: () => void;
    nextPage: () => void;
    goToEnd: () => void;
    goToTurn: (turnNumber: number) => void;
    getTurnInfo: () => { current: number | null; total: number; turns: TurnInfo[] };
}

export const ChatList = React.memo(React.forwardRef<ChatListHandle, { session: Session; onTurnChange?: (current: number | null, total: number, turns: TurnInfo[]) => void }>((props, ref) => {
    const { messages } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            ref={ref}
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            onTurnChange={props.onTurnChange}
        />
    )
}));

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

interface ChatListInternalProps {
    metadata: Metadata | null;
    sessionId: string;
    messages: Message[];
    onTurnChange?: (current: number | null, total: number, turns: TurnInfo[]) => void;
}

const ChatListInternal = React.memo(React.forwardRef<ChatListHandle, ChatListInternalProps>((props, ref) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const turns = useTurnIndices(props.messages);
    // Track selection by message ID (stable across rewinds/reorders)
    // instead of turnNumber (shifts when earlier turns are removed).
    const selectedMessageIdRef = React.useRef<string | null>(null);
    // Keep a stable ref to onTurnChange to avoid stale closures in effects
    const onTurnChangeRef = React.useRef(props.onTurnChange);
    onTurnChangeRef.current = props.onTurnChange;

    // Resolve the selected message ID to a turns-array index
    const resolveIdx = useCallback((): number | null => {
        const id = selectedMessageIdRef.current;
        if (id === null) return null;
        const idx = turns.findIndex(t => t.messageId === id);
        return idx !== -1 ? idx : null;
    }, [turns]);

    // Push turn info to parent whenever turns change
    React.useEffect(() => {
        // If selected turn no longer exists (e.g. messages cleared/rewound), reset
        if (selectedMessageIdRef.current !== null) {
            const exists = turns.some(t => t.messageId === selectedMessageIdRef.current);
            if (!exists) {
                selectedMessageIdRef.current = null;
            }
        }
        const currentNum = selectedMessageIdRef.current !== null
            ? turns.find(t => t.messageId === selectedMessageIdRef.current)?.turnNumber ?? null
            : null;
        onTurnChangeRef.current?.(currentNum, turns.length, turns);
    }, [turns]);

    const scrollToTurnIdx = useCallback((idx: number | null) => {
        if (idx === null) {
            selectedMessageIdRef.current = null;
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        } else {
            const turn = turns[idx];
            if (turn) {
                selectedMessageIdRef.current = turn.messageId;
                flatListRef.current?.scrollToIndex({
                    index: turn.index,
                    animated: true,
                    viewPosition: 0.3,
                });
            }
        }
        const currentNum = idx !== null ? turns[idx]?.turnNumber ?? null : null;
        onTurnChangeRef.current?.(currentNum, turns.length, turns);
    }, [turns]);

    const doNavigate = useCallback((action: NavigateAction) => {
        if (turns.length === 0) return;
        const currentIdx = resolveIdx();
        const nextIdx = navigateTurn(turns, currentIdx, action);
        scrollToTurnIdx(nextIdx);
    }, [turns, resolveIdx, scrollToTurnIdx]);

    const goToTurn = useCallback((turnNumber: number) => {
        const idx = turns.findIndex(t => t.turnNumber === turnNumber);
        if (idx !== -1) {
            scrollToTurnIdx(idx);
        }
    }, [turns, scrollToTurnIdx]);

    React.useImperativeHandle(ref, () => ({
        prevTurn: () => doNavigate('prev'),
        nextTurn: () => doNavigate('next'),
        prevPage: () => doNavigate('prevPage'),
        nextPage: () => doNavigate('nextPage'),
        goToEnd: () => doNavigate('end'),
        goToTurn,
        getTurnInfo: () => {
            const id = selectedMessageIdRef.current;
            const currentNum = id !== null
                ? turns.find(t => t.messageId === id)?.turnNumber ?? null
                : null;
            return {
                current: currentNum,
                total: turns.length,
                turns,
            };
        },
    }), [doNavigate, goToTurn, turns]);

    const keyExtractor = useCallback((item: Message) => item.id, []);
    const renderItem = useCallback(({ item }: { item: Message }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);

    // In inverted FlatList, offset 0 = latest messages (visual bottom).
    // Offset increases as user scrolls up to see older messages.
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = e.nativeEvent.contentOffset.y;
        setShowScrollButton(offsetY > SCROLL_THRESHOLD);
    }, []);

    const scrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    // scrollToIndex fails for unmeasured variable-height items — this is the
    // normal path for long conversations. Use progressive scrolling: jump to
    // the farthest measured item toward the target, wait for new items to
    // render, then retry. Up to MAX_SCROLL_RETRIES attempts.
    const scrollRetryState = React.useRef<{ targetIndex: number; attempts: number } | null>(null);
    const MAX_SCROLL_RETRIES = 5;

    const handleScrollToIndexFailed = useCallback((info: {
        index: number;
        highestMeasuredFrameIndex: number;
        averageItemLength: number;
    }) => {
        const state = scrollRetryState.current;

        // First failure for this target — start progressive scroll
        if (!state || state.targetIndex !== info.index) {
            scrollRetryState.current = { targetIndex: info.index, attempts: 1 };
        } else {
            state.attempts++;
            if (state.attempts > MAX_SCROLL_RETRIES) {
                // Give up — best-effort offset jump
                flatListRef.current?.scrollToOffset({
                    offset: info.averageItemLength * info.index,
                    animated: false,
                });
                scrollRetryState.current = null;
                return;
            }
        }

        // Jump to the farthest measured item toward the target.
        // This renders new items closer to the target each time.
        const intermediateIndex = Math.min(info.index, info.highestMeasuredFrameIndex);
        flatListRef.current?.scrollToIndex({
            index: intermediateIndex,
            animated: false,
            viewPosition: 0.5,
        });

        // Wait for newly-visible items to render and get measured, then retry
        setTimeout(() => {
            flatListRef.current?.scrollToIndex({
                index: info.index,
                animated: true,
                viewPosition: 0.3,
            });
        }, 200);
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <FlatList
                ref={flatListRef}
                data={props.messages}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 10,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onScrollToIndexFailed={handleScrollToIndexFailed}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={<ListHeader />}
            />
            {showScrollButton && (
                <View style={styles.scrollButtonContainer}>
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
}));

const styles = StyleSheet.create((theme) => ({
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
