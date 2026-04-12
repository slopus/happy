import * as React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MessageView } from '@/components/MessageView';
import { TurnNavigator } from '@/components/TurnNavigator';
import { useTurnIndices, navigateTurn, NavigateAction } from '@/hooks/useTurnIndices';
import { useTurnNavigationKeyboard } from '@/hooks/useTurnNavigationKeyboard';
import { turnNavigationMessages, singleTurnMessages } from './messages-demo-data';
import { Message } from '@/sync/typesMessage';
import { useDemoMessages } from '@/hooks/useDemoMessages';

/**
 * Demo page for testing turn-level navigation.
 *
 * Uses a standalone inverted FlatList (not ChatList) because
 * ChatList requires a full Session object from the Zustand store.
 * This lets us test the hook + navigator with pure mock data.
 */
export default React.memo(function TurnNavigationDemoScreen() {
    const { theme } = useUnistyles();
    const [dataset, setDataset] = React.useState<'multi' | 'single'>('multi');
    const rawMessages = dataset === 'multi' ? turnNavigationMessages : singleTurnMessages;
    // Sort newest-first to match inverted FlatList convention (same as useSessionMessages)
    const messages = React.useMemo(
        () => [...rawMessages].sort((a, b) => b.createdAt - a.createdAt),
        [rawMessages],
    );

    // Load into demo session for MessageView permission rendering
    const sessionId = useDemoMessages(messages);

    // Turn navigation state — use ref to avoid stale closures in doNavigate
    const turns = useTurnIndices(messages);
    const selectedIdxRef = React.useRef<number | null>(null);
    const [selectedIdx, setSelectedIdx] = React.useState<number | null>(null);
    const flatListRef = React.useRef<FlatList>(null);

    // Reset selection when switching datasets
    React.useEffect(() => { selectedIdxRef.current = null; setSelectedIdx(null); }, [dataset]);

    const doNavigate = React.useCallback((action: NavigateAction) => {
        if (turns.length === 0) return;
        const next = navigateTurn(turns, selectedIdxRef.current, action);
        selectedIdxRef.current = next;
        setSelectedIdx(next);

        if (next === null) {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        } else {
            const turn = turns[next];
            if (turn) {
                flatListRef.current?.scrollToIndex({
                    index: turn.index,
                    animated: true,
                    viewPosition: 0.3,
                });
            }
        }
    }, [turns]);

    const handlePrev = React.useCallback(() => doNavigate('prev'), [doNavigate]);
    const handleNext = React.useCallback(() => doNavigate('next'), [doNavigate]);
    const handlePrevPage = React.useCallback(() => doNavigate('prevPage'), [doNavigate]);
    const handleNextPage = React.useCallback(() => doNavigate('nextPage'), [doNavigate]);
    const handleEnd = React.useCallback(() => doNavigate('end'), [doNavigate]);

    useTurnNavigationKeyboard({
        onPrev: handlePrev,
        onNext: handleNext,
        onPrevPage: handlePrevPage,
        onNextPage: handleNextPage,
        onEnd: handleEnd,
    });

    const currentTurnNumber = selectedIdx !== null
        ? turns[selectedIdx]?.turnNumber ?? null
        : null;
    const hasPrev = selectedIdx !== null ? selectedIdx < turns.length - 1 : turns.length > 0;
    const hasNext = selectedIdx !== null && selectedIdx > 0;

    const scrollRetryState = React.useRef<{ targetIndex: number; attempts: number } | null>(null);
    const MAX_SCROLL_RETRIES = 5;
    const handleScrollToIndexFailed = React.useCallback((info: {
        index: number;
        highestMeasuredFrameIndex: number;
        averageItemLength: number;
    }) => {
        const state = scrollRetryState.current;
        if (!state || state.targetIndex !== info.index) {
            scrollRetryState.current = { targetIndex: info.index, attempts: 1 };
        } else {
            state.attempts++;
            if (state.attempts > MAX_SCROLL_RETRIES) {
                flatListRef.current?.scrollToOffset({
                    offset: info.averageItemLength * info.index,
                    animated: false,
                });
                scrollRetryState.current = null;
                return;
            }
        }
        const intermediateIndex = Math.min(info.index, info.highestMeasuredFrameIndex);
        flatListRef.current?.scrollToIndex({
            index: intermediateIndex,
            animated: false,
            viewPosition: 0.5,
        });
        setTimeout(() => {
            flatListRef.current?.scrollToIndex({
                index: info.index,
                animated: true,
                viewPosition: 0.3,
            });
        }, 200);
    }, []);

    return (
        <View style={styles.container}>
            {/* Dataset toggle */}
            <View style={styles.toggleRow}>
                <ToggleButton
                    label={`Multi-turn (${turnNavigationMessages.filter(m => m.kind === 'user-text').length})`}
                    active={dataset === 'multi'}
                    onPress={() => setDataset('multi')}
                />
                <ToggleButton
                    label="Single turn"
                    active={dataset === 'single'}
                    onPress={() => setDataset('single')}
                />
            </View>

            {/* Chat list */}
            <View style={{ flex: 1 }}>
                <FlatList
                    ref={flatListRef}
                    data={messages}
                    inverted={true}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <MessageView
                            message={item}
                            metadata={null}
                            sessionId={sessionId}
                        />
                    )}
                    onScrollToIndexFailed={handleScrollToIndexFailed}
                    contentContainerStyle={{ paddingVertical: 20 }}
                />

                {/* Turn navigator overlay */}
                <TurnNavigator
                    currentTurnNumber={currentTurnNumber}
                    totalTurns={turns.length}
                    turns={turns}
                    onPrev={handlePrev}
                    onNext={handleNext}
                    onEnd={handleEnd}
                    onPrevPage={handlePrevPage}
                    onNextPage={handleNextPage}
                    onGoToTurn={(turnNumber) => {
                        const idx = turns.findIndex(t => t.turnNumber === turnNumber);
                        if (idx !== -1) {
                            selectedIdxRef.current = idx;
                            setSelectedIdx(idx);
                            const turn = turns[idx];
                            flatListRef.current?.scrollToIndex({
                                index: turn.index,
                                animated: true,
                                viewPosition: 0.3,
                            });
                        }
                    }}
                    hasPrev={hasPrev}
                    hasNext={hasNext}
                />
            </View>
        </View>
    );
});

const ToggleButton = React.memo((props: { label: string; active: boolean; onPress: () => void }) => {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            style={[
                styles.toggleButton,
                { backgroundColor: props.active ? theme.colors.fab.background : 'transparent' },
            ]}
        >
            <Text style={[
                styles.toggleText,
                { color: props.active ? theme.colors.fab.icon : theme.colors.textSecondary },
            ]}>
                {props.label}
            </Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    toggleRow: {
        flexDirection: 'row',
        gap: 8,
        padding: 12,
        paddingTop: 60,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    toggleButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
    },
    toggleText: {
        fontSize: 13,
        fontWeight: '600',
    },
}));
