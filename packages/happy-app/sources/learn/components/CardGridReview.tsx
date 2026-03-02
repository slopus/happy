import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator, Platform, ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { learnApi } from '../learnApi';
import { learnStorage, useLearnDueCards } from '../learnStorage';
import type { FlashCard, CardRating } from '../learnTypes';

function formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const PREVIEW_COUNT = 2;

// ============ Active Card (big) ============

function ActiveCard({
    card,
    flipped,
    onFlip,
    flyDirection,
}: {
    card: FlashCard;
    flipped: boolean;
    onFlip: () => void;
    flyDirection: 'left' | 'right' | null;
}) {
    const { theme } = useUnistyles();

    const flyStyle = flyDirection ? {
        transition: 'transform 0.3s ease, opacity 0.3s ease',
        transform: [
            { translateX: flyDirection === 'left' ? -600 : 600 },
        ],
        opacity: 0,
    } as any : {};

    const leftLabel = flipped ? 'забыл' : 'убрать';
    const rightLabel = flipped ? 'помню' : 'пропустить';
    const leftColor = flipped ? 'rgb(220,80,80)' : 'rgb(200,100,100)';
    const rightColor = flipped ? 'rgb(80,200,80)' : 'rgb(180,180,180)';

    return (
        <Pressable
            onPress={onFlip}
            style={[
                {
                    flex: 1,
                    borderRadius: 16,
                    padding: 24,
                    backgroundColor: theme.colors.groupped.item,
                    borderWidth: 2,
                    borderColor: theme.colors.textLink,
                    justifyContent: 'center',
                    alignItems: 'center',
                    ...(Platform.OS === 'web' ? { cursor: 'pointer', userSelect: 'none' } as any : {}),
                },
                flyStyle,
            ]}
        >
            {/* Label */}
            <Text style={{
                position: 'absolute', top: 14, left: 16,
                fontSize: 10, color: theme.colors.textSecondary,
                textTransform: 'uppercase', letterSpacing: 1.5, opacity: 0.5,
                ...Typography.default('medium'),
            }}>
                {flipped ? 'Ответ' : 'Вопрос'}
            </Text>

            {/* Content */}
            <View style={{ width: '100%', paddingHorizontal: 12 }}>
                <Text style={{
                    fontSize: 17, lineHeight: 26, textAlign: 'center',
                    color: theme.colors.text,
                    ...Typography.default(flipped ? 'regular' : 'medium'),
                }}>
                    {flipped ? card.back : card.front}
                </Text>
            </View>

            {/* Flip hint */}
            {!flipped && (
                <Text style={{
                    position: 'absolute', bottom: 14, left: 0, right: 0,
                    textAlign: 'center',
                    fontSize: 11, color: theme.colors.textSecondary, opacity: 0.3,
                    ...Typography.default(),
                }}>
                    Space — показать ответ
                </Text>
            )}

            {/* Timestamp */}
            {card.timestamp != null && card.timestamp > 0 && (
                <View style={{
                    position: 'absolute', bottom: 14, right: 16,
                    flexDirection: 'row', alignItems: 'center', gap: 3, opacity: 0.5,
                }}>
                    <Ionicons name="videocam-outline" size={11} color={theme.colors.textLink} />
                    <Text style={{
                        fontSize: 11, color: theme.colors.textLink,
                        ...Typography.mono(),
                    }}>
                        {formatTimestamp(card.timestamp)}
                    </Text>
                </View>
            )}

            {/* Arrow hints on sides — always visible */}
            <View style={{
                position: 'absolute', left: 16, top: '50%', marginTop: -10,
                flexDirection: 'row', alignItems: 'center', gap: 4, opacity: 0.2,
            }}>
                <Ionicons name="arrow-back" size={14} color={leftColor} />
                <Text style={{ fontSize: 10, color: leftColor, ...Typography.default('medium') }}>{leftLabel}</Text>
            </View>
            <View style={{
                position: 'absolute', right: 16, top: '50%', marginTop: -10,
                flexDirection: 'row', alignItems: 'center', gap: 4, opacity: 0.2,
            }}>
                <Text style={{ fontSize: 10, color: rightColor, ...Typography.default('medium') }}>{rightLabel}</Text>
                <Ionicons name="arrow-forward" size={14} color={rightColor} />
            </View>
        </Pressable>
    );
}


// ============ Preview Card (small) ============

function PreviewCard({ card, label, showAnswer }: { card: FlashCard; label: string; showAnswer?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={{
            flex: 1,
            borderRadius: 10,
            padding: 10,
            backgroundColor: theme.colors.groupped.item,
            borderWidth: 1,
            borderColor: theme.colors.divider,
            opacity: 0.6,
        }}>
            <Text style={{
                fontSize: 9, color: theme.colors.textSecondary,
                textTransform: 'uppercase', letterSpacing: 1,
                marginBottom: 4, opacity: 0.5,
                ...Typography.default('medium'),
            }}>
                {label}
            </Text>
            <Text style={{
                fontSize: 12, lineHeight: 16,
                color: theme.colors.textSecondary,
                ...Typography.default(),
            }} numberOfLines={3}>
                {showAnswer ? card.back : card.front}
            </Text>
            {card.timestamp != null && card.timestamp > 0 && (
                <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 3,
                    alignSelf: 'flex-end', marginTop: 4, opacity: 0.5,
                }}>
                    <Ionicons name="videocam-outline" size={9} color={theme.colors.textLink} />
                    <Text style={{ fontSize: 9, color: theme.colors.textLink, ...Typography.mono() }}>
                        {formatTimestamp(card.timestamp)}
                    </Text>
                </View>
            )}
        </View>
    );
}


// ============ Deck Navigator (full-panel, replaces overlay) ============

interface Deck {
    lessonId: string;
    lessonTitle: string;
    courseId: string | null;
    courseTitle: string | null;
    total: number;
    due: number;
    new: number;
}

const isWeb = Platform.OS === 'web';

function DeckNavigator({
    decks,
    selectedLessonId,
    onSelect,
    onSelectAll,
    onClose,
    reviewedCount,
    totalCards,
}: {
    decks: Deck[];
    selectedLessonId: string | null;
    onSelect: (lessonId: string) => void;
    onSelectAll: () => void;
    onClose: () => void;
    reviewedCount: number;
    totalCards: number;
}) {
    const { theme } = useUnistyles();
    const totalDue = decks.reduce((sum, d) => sum + d.due, 0);
    const progress = totalCards > 0 ? Math.round((reviewedCount / totalCards) * 100) : 0;
    const [activeCourseId, setActiveCourseId] = React.useState<string | null>(null);

    // Group by course
    const courseGroups = React.useMemo(() => {
        const map = new Map<string, { title: string; decks: Deck[]; due: number }>();
        for (const d of decks) {
            const cid = d.courseId || '_other';
            const ct = d.courseTitle || 'Другое';
            if (!map.has(cid)) map.set(cid, { title: ct, decks: [], due: 0 });
            const g = map.get(cid)!;
            g.decks.push(d);
            g.due += d.due;
        }
        return Array.from(map.entries());
    }, [decks]);

    // Filtered decks based on active course pill
    const filteredDecks = React.useMemo(() => {
        if (!activeCourseId) return decks;
        return decks.filter(d => (d.courseId || '_other') === activeCourseId);
    }, [decks, activeCourseId]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            {/* Header */}
            <View style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingHorizontal: 16, paddingVertical: 12,
                borderBottomWidth: 0.5, borderBottomColor: theme.colors.divider,
            }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{
                        fontSize: 14, color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}>
                        Колоды
                    </Text>
                    <Text style={{
                        fontSize: 11, color: theme.colors.textSecondary, marginTop: 1,
                        ...Typography.default(),
                    }}>
                        {progress}% · {reviewedCount}/{totalCards}
                    </Text>
                </View>
                <Pressable
                    onPress={onClose}
                    hitSlop={8}
                    style={({ hovered }: any) => ({
                        width: 28, height: 28, borderRadius: 6,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: hovered ? theme.colors.text + '0A' : 'transparent',
                        ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                    })}
                >
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {/* Course pills (horizontal scroll) */}
            {courseGroups.length > 1 && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ maxHeight: 44, borderBottomWidth: 0.5, borderBottomColor: theme.colors.divider }}
                    contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}
                >
                    {/* "All" pill */}
                    <Pressable
                        onPress={() => setActiveCourseId(null)}
                        style={({ hovered }: any) => ({
                            paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
                            backgroundColor: !activeCourseId ? theme.colors.text + '15' : hovered ? theme.colors.text + '08' : 'transparent',
                            borderWidth: 1,
                            borderColor: !activeCourseId ? theme.colors.text + '25' : theme.colors.divider,
                            ...(isWeb ? { cursor: 'pointer', transition: 'all 0.15s ease' } as any : {}),
                        })}
                    >
                        <Text style={{
                            fontSize: 12, color: !activeCourseId ? theme.colors.text : theme.colors.textSecondary,
                            ...Typography.default(!activeCourseId ? 'semiBold' : 'regular'),
                        }}>
                            Все · {totalDue}
                        </Text>
                    </Pressable>
                    {courseGroups.map(([courseId, group]) => {
                        const isActive = activeCourseId === courseId;
                        return (
                            <Pressable
                                key={courseId}
                                onPress={() => setActiveCourseId(isActive ? null : courseId)}
                                style={({ hovered }: any) => ({
                                    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
                                    backgroundColor: isActive ? theme.colors.text + '15' : hovered ? theme.colors.text + '08' : 'transparent',
                                    borderWidth: 1,
                                    borderColor: isActive ? theme.colors.text + '25' : theme.colors.divider,
                                    ...(isWeb ? { cursor: 'pointer', transition: 'all 0.15s ease' } as any : {}),
                                })}
                            >
                                <Text style={{
                                    fontSize: 12, color: isActive ? theme.colors.text : theme.colors.textSecondary,
                                    ...Typography.default(isActive ? 'semiBold' : 'regular'),
                                }} numberOfLines={1}>
                                    {group.title} · {group.due}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            )}

            {/* "All cards" button */}
            <Pressable
                onPress={() => { onSelectAll(); onClose(); }}
                style={({ hovered }: any) => ({
                    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                    paddingHorizontal: 14, paddingVertical: 10, marginHorizontal: 10, marginTop: 10,
                    borderRadius: 10,
                    backgroundColor: !selectedLessonId
                        ? theme.colors.text + '10'
                        : hovered ? theme.colors.text + '06' : 'transparent',
                    ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                })}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="layers-outline" size={16} color={!selectedLessonId ? theme.colors.text : theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13, color: !selectedLessonId ? theme.colors.text : theme.colors.textSecondary,
                        ...Typography.default(!selectedLessonId ? 'semiBold' : 'medium'),
                    }}>
                        Все карточки
                    </Text>
                </View>
                <Text style={{
                    fontSize: 12, color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}>
                    {totalDue}
                </Text>
            </Pressable>

            {/* Lesson cards grid (2 columns) */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {filteredDecks.map((deck, idx) => {
                    const isSelected = selectedLessonId === deck.lessonId;
                    const pct = deck.total > 0 ? Math.round(((deck.total - deck.due) / deck.total) * 100) : 100;
                    return (
                        <Pressable
                            key={deck.lessonId}
                            onPress={() => { onSelect(deck.lessonId); onClose(); }}
                            style={({ hovered }: any) => ({
                                width: '48.5%' as any,
                                padding: 12,
                                borderRadius: 12,
                                backgroundColor: isSelected
                                    ? theme.colors.text + '12'
                                    : hovered ? theme.colors.text + '08' : theme.colors.groupped.item,
                                borderWidth: 1,
                                borderColor: isSelected ? theme.colors.text + '20' : theme.colors.divider + '60',
                                ...(isWeb ? { cursor: 'pointer', transition: 'all 0.15s ease' } as any : {}),
                            })}
                        >
                            {/* Lesson number + title */}
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
                                <Text style={{
                                    fontSize: 11, color: theme.colors.textSecondary, opacity: 0.5,
                                    minWidth: 16,
                                    ...Typography.default('medium'),
                                }}>
                                    {idx + 1}
                                </Text>
                                <Text style={{
                                    flex: 1, fontSize: 12, lineHeight: 16,
                                    color: isSelected ? theme.colors.text : theme.colors.textSecondary,
                                    ...Typography.default(isSelected ? 'semiBold' : 'medium'),
                                }} numberOfLines={2}>
                                    {deck.lessonTitle}
                                </Text>
                            </View>
                            {/* Due badge */}
                            <Text style={{
                                fontSize: 11,
                                color: deck.due > 0 ? theme.colors.text : '#4CAF50',
                                marginBottom: 6,
                                ...Typography.default(deck.due > 0 ? 'semiBold' : 'regular'),
                            }}>
                                {deck.due > 0 ? `${deck.due} к повт.` : '✓ повторено'}
                            </Text>
                            {/* Mini progress bar */}
                            <View style={{
                                height: 3, backgroundColor: theme.colors.divider,
                                borderRadius: 2, overflow: 'hidden',
                            }}>
                                <View style={{
                                    height: '100%', width: `${pct}%`,
                                    backgroundColor: pct === 100 ? '#4CAF50' : theme.colors.textSecondary + '60',
                                    borderRadius: 2,
                                }} />
                            </View>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}


// ============ Progress Bar (bottom right, clickable) ============

function ProgressBlock({
    reviewedCount,
    totalCards,
    onOpenPicker,
}: {
    reviewedCount: number;
    totalCards: number;
    onOpenPicker: () => void;
}) {
    const { theme } = useUnistyles();
    const progress = totalCards > 0 ? Math.round((reviewedCount / totalCards) * 100) : 0;

    return (
        <Pressable
            onPress={onOpenPicker}
            style={({ hovered }: any) => ({
                flex: 1,
                borderRadius: 10,
                padding: 12,
                backgroundColor: hovered ? theme.colors.text + '0A' : theme.colors.groupped.item,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                justifyContent: 'space-between',
                ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
            })}
        >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{
                    fontSize: 9, color: theme.colors.textSecondary,
                    textTransform: 'uppercase', letterSpacing: 1, opacity: 0.5,
                    ...Typography.default('medium'),
                }}>
                    Колоды
                </Text>
                <Ionicons name="grid-outline" size={12} color={theme.colors.textSecondary} style={{ opacity: 0.4 }} />
            </View>

            <View style={{ alignItems: 'center', gap: 4, marginVertical: 6 }}>
                <Text style={{
                    fontSize: 24, color: theme.colors.text,
                    ...Typography.default('bold'),
                }}>
                    {progress}%
                </Text>
                <Text style={{
                    fontSize: 10, color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}>
                    {reviewedCount} из {totalCards}
                </Text>
            </View>

            <View style={{
                height: 3, backgroundColor: theme.colors.divider,
                borderRadius: 2, overflow: 'hidden',
            }}>
                <View style={{
                    height: '100%', width: `${progress}%`,
                    backgroundColor: '#4CAF50', borderRadius: 2,
                }} />
            </View>
        </Pressable>
    );
}


// ============ CardGridReview ============

interface CardGridReviewProps {
    onTimestampPress?: (seconds: number) => void;
}

export const CardGridReview = React.memo(({ onTimestampPress }: CardGridReviewProps) => {
    const { theme } = useUnistyles();
    const dueCards = useLearnDueCards();
    const [loading, setLoading] = React.useState(true);
    const [flipped, setFlipped] = React.useState(false);
    const [flyDirection, setFlyDirection] = React.useState<'left' | 'right' | null>(null);
    const [reviewedCount, setReviewedCount] = React.useState(0);
    const [startTime, setStartTime] = React.useState(Date.now());
    const [reviewing, setReviewing] = React.useState(false);
    const [decks, setDecks] = React.useState<Deck[]>([]);
    const [selectedLessonId, setSelectedLessonId] = React.useState<string | null>(null);
    const [showDeckPicker, setShowDeckPicker] = React.useState(false);
    const [lastCard, setLastCard] = React.useState<FlashCard | null>(null);

    // Load decks + all due cards on mount
    React.useEffect(() => {
        Promise.all([
            learnApi.getDecks(),
            learnApi.getDueCards(50),
        ]).then(([decksRes, cardsRes]) => {
            setDecks(decksRes.decks);
            learnStorage.getState().setDueCards(cardsRes.cards);
        }).catch(console.error)
          .finally(() => setLoading(false));
    }, []);

    const loadCards = React.useCallback((lessonId?: string) => {
        setLoading(true);
        setReviewedCount(0);
        setSelectedLessonId(lessonId || null);
        learnApi.getDueCards(50, lessonId)
            .then((res) => {
                learnStorage.getState().setDueCards(res.cards);
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    const currentCard = dueCards[0] || null;
    const previewCards = dueCards.slice(1, 1 + PREVIEW_COUNT);
    const totalCards = reviewedCount + dueCards.length;

    // Reset flip when card changes
    React.useEffect(() => {
        setFlipped(false);
        setStartTime(Date.now());
        setFlyDirection(null);
    }, [currentCard?.id]);

    const flipCard = React.useCallback(() => {
        if (!currentCard) return;
        setFlipped(prev => !prev);
    }, [currentCard]);

    const rateCard = React.useCallback(async (rating: CardRating, direction: 'left' | 'right') => {
        if (reviewing || !currentCard || !flipped) return;
        setReviewing(true);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const cardToSave = currentCard;

        setFlyDirection(direction);

        setTimeout(async () => {
            try {
                await learnApi.reviewCard(cardToSave.id, rating, elapsed);
                setLastCard(cardToSave);
                learnStorage.getState().removeCard(cardToSave.id);
                setReviewedCount(c => c + 1);
            } catch (e) {
                console.error('[rate]', e);
            } finally {
                setReviewing(false);
                setFlyDirection(null);
            }
        }, 300);
    }, [reviewing, currentCard, flipped, startTime]);

    // Dismiss card (remove permanently)
    const dismissCard = React.useCallback(async () => {
        if (reviewing || !currentCard) return;
        setReviewing(true);
        const cardToSave = currentCard;
        setFlyDirection('left');
        setTimeout(async () => {
            try {
                await learnApi.dismissCard(cardToSave.id);
                setLastCard(cardToSave);
                learnStorage.getState().removeCard(cardToSave.id);
            } catch (e) {
                console.error('[dismiss]', e);
            } finally {
                setReviewing(false);
                setFlyDirection(null);
            }
        }, 300);
    }, [reviewing, currentCard]);

    // Skip card (move to end of queue)
    const skipCard = React.useCallback(() => {
        if (!currentCard) return;
        setFlyDirection('right');
        setTimeout(() => {
            const cards = learnStorage.getState().dueCards;
            const rest = cards.filter(c => c.id !== currentCard.id);
            learnStorage.getState().setDueCards([...rest, currentCard]);
            setFlyDirection(null);
        }, 300);
    }, [currentCard]);

    // Keyboard shortcuts
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.contentEditable === 'true') return;

            // Escape closes deck picker
            if (e.key === 'Escape' && showDeckPicker) {
                e.preventDefault();
                setShowDeckPicker(false);
                return;
            }
            if (showDeckPicker) return; // Don't process other keys when picker is open

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    if (flipped) {
                        rateCard(1, 'left'); // Forgot
                    } else {
                        dismissCard(); // Remove
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (flipped) {
                        rateCard(3, 'right'); // Remember
                    } else {
                        skipCard(); // Skip to later
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (currentCard?.timestamp != null && currentCard.timestamp > 0) {
                        onTimestampPress?.(currentCard.timestamp);
                    }
                    break;
                case ' ':
                    e.preventDefault();
                    flipCard();
                    break;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [rateCard, dismissCard, skipCard, flipCard, flipped, currentCard, onTimestampPress, showDeckPicker]);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
            </View>
        );
    }

    // Show DeckNavigator as full panel when picker is open
    if (showDeckPicker) {
        return (
            <DeckNavigator
                decks={decks}
                selectedLessonId={selectedLessonId}
                onSelect={(id) => loadCards(id)}
                onSelectAll={() => loadCards()}
                onClose={() => setShowDeckPicker(false)}
                reviewedCount={reviewedCount}
                totalCards={totalCards}
            />
        );
    }

    if (dueCards.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
                <Ionicons name="checkmark-circle" size={48} color="#4CAF50" style={{ marginBottom: 12, opacity: 0.6 }} />
                <Text style={{
                    fontSize: 18, color: theme.colors.text, marginBottom: 6,
                    ...Typography.default('semiBold'),
                }}>
                    {reviewedCount > 0 ? 'Сессия завершена!' : 'Всё повторено'}
                </Text>
                <Text style={{
                    fontSize: 14, color: theme.colors.textSecondary, marginBottom: 20,
                    ...Typography.default(),
                }}>
                    {reviewedCount > 0 ? `${reviewedCount} карточек пройдено` : 'Нет карточек для повторения'}
                </Text>
                <Pressable
                    onPress={() => setShowDeckPicker(true)}
                    style={({ hovered }: any) => ({
                        paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10,
                        backgroundColor: hovered ? theme.colors.text + '12' : theme.colors.groupped.item,
                        ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                    })}
                >
                    <Text style={{
                        fontSize: 14, color: theme.colors.textLink,
                        ...Typography.default('medium'),
                    }}>
                        Выбрать колоду
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, padding: 12 }}>
            {/* Active card (~70%) */}
            <View style={{ flex: 7 }}>
                {currentCard && (
                    <ActiveCard
                        key={currentCard.id}
                        card={currentCard}
                        flipped={flipped}
                        onFlip={flipCard}
                        flyDirection={flyDirection}
                    />
                )}
            </View>

            {/* Bottom row (~30%): progress + prev card + next card */}
            <View style={{ flex: 3, flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <ProgressBlock
                    reviewedCount={reviewedCount}
                    totalCards={totalCards}
                    onOpenPicker={() => setShowDeckPicker(true)}
                />
                {/* Previous (last answered) */}
                {lastCard ? (
                    <PreviewCard key={`prev-${lastCard.id}`} card={lastCard} label="Предыдущая" showAnswer />
                ) : (
                    <View style={{ flex: 1 }} />
                )}
                {/* Next card */}
                {previewCards[0] ? (
                    <PreviewCard key={`next-${previewCards[0].id}`} card={previewCards[0]} label="Следующая" />
                ) : (
                    <View style={{ flex: 1 }} />
                )}
            </View>

            {/* Keyboard hints */}
            <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                paddingTop: 10, paddingBottom: 2, gap: 16, opacity: 0.35,
            }}>
                {[
                    { key: 'Space', label: 'флип' },
                    { key: '←', label: flipped ? 'забыл' : 'убрать' },
                    { key: '→', label: flipped ? 'помню' : 'пропустить' },
                    { key: '↑', label: 'видео' },
                ].map(h => (
                    <View key={h.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{
                            paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
                            backgroundColor: theme.colors.groupped.item,
                            borderWidth: 1, borderColor: theme.colors.divider,
                        }}>
                            <Text style={{
                                fontSize: 10, color: theme.colors.textSecondary,
                                ...Typography.mono(),
                            }}>{h.key}</Text>
                        </View>
                        <Text style={{
                            fontSize: 10, color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}>{h.label}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
});
