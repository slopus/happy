import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator, Platform, Dimensions, ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { learnApi } from '../learnApi';
import { learnStorage, useLearnDueCards, useLearnChatSessions } from '../learnStorage';
import type { FlashCard, CardRating } from '../learnTypes';

const SWIPE_THRESHOLD = 80;
const SCREEN_WIDTH = Dimensions.get('window').width;

function formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============ Types ============

interface Deck {
    lessonId: string;
    lessonTitle: string;
    courseId: string | null;
    courseTitle: string | null;
    total: number;
    due: number;
    new: number;
}

// ============ DeckGrid ============

interface CourseGroup {
    courseId: string;
    courseTitle: string;
    decks: Deck[];
    totalDue: number;
}

function DeckGrid({
    decks,
    loading,
    onSelect,
    onSelectAll,
}: {
    decks: Deck[];
    loading: boolean;
    onSelect: (lessonId: string) => void;
    onSelectAll: () => void;
}) {
    const { theme } = useUnistyles();
    const [collapsedCourses, setCollapsedCourses] = React.useState<Set<string>>(new Set());

    const toggleCollapse = React.useCallback((courseId: string) => {
        setCollapsedCourses((prev) => {
            const next = new Set(prev);
            if (next.has(courseId)) next.delete(courseId);
            else next.add(courseId);
            return next;
        });
    }, []);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
            </View>
        );
    }

    const totalDue = decks.reduce((sum, d) => sum + d.due, 0);

    if (decks.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
                <Text style={{
                    fontSize: 20, color: theme.colors.text, marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}>
                    Нет карточек
                </Text>
                <Text style={{
                    fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center',
                    ...Typography.default(),
                }}>
                    Карточки появятся после прохождения уроков
                </Text>
            </View>
        );
    }

    // Group decks by course
    const courseGroups: CourseGroup[] = [];
    const courseMap = new Map<string, CourseGroup>();
    for (const deck of decks) {
        const cid = deck.courseId || 'other';
        const ctitle = deck.courseTitle || 'Другое';
        if (!courseMap.has(cid)) {
            const group: CourseGroup = { courseId: cid, courseTitle: ctitle, decks: [], totalDue: 0 };
            courseMap.set(cid, group);
            courseGroups.push(group);
        }
        const g = courseMap.get(cid)!;
        g.decks.push(deck);
        g.totalDue += deck.due;
    }

    const borderColor = theme.colors.textSecondary + '40';

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}
            contentContainerStyle={{ padding: 16 }}
        >
            {/* Review all button */}
            {totalDue > 0 && (
                <Pressable
                    onPress={onSelectAll}
                    style={{
                        borderWidth: 1,
                        borderColor,
                        borderRadius: 16, padding: 20,
                        marginBottom: 20, alignItems: 'center',
                    }}
                >
                    <Text style={{
                        fontSize: 16, color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}>
                        Все карточки
                    </Text>
                    <Text style={{
                        fontSize: 13, color: theme.colors.textSecondary, marginTop: 4,
                        ...Typography.default(),
                    }}>
                        {totalDue} к повторению
                    </Text>
                </Pressable>
            )}

            {/* Course groups */}
            {courseGroups.map((group) => {
                const isCollapsed = collapsedCourses.has(group.courseId);
                return (
                    <View key={group.courseId} style={{ marginBottom: 20 }}>
                        {/* Course header */}
                        <Pressable
                            onPress={() => toggleCollapse(group.courseId)}
                            style={{
                                flexDirection: 'row', alignItems: 'center',
                                justifyContent: 'space-between',
                                paddingVertical: 8, paddingHorizontal: 4,
                                marginBottom: isCollapsed ? 0 : 10,
                            }}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                                <Ionicons
                                    name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: 14, color: theme.colors.text,
                                    ...Typography.default('semiBold'),
                                }} numberOfLines={1}>
                                    {group.courseTitle}
                                </Text>
                            </View>
                            {group.totalDue > 0 && (
                                <Text style={{
                                    fontSize: 12, color: theme.colors.textSecondary,
                                    ...Typography.default(),
                                }}>
                                    {group.totalDue} к повт.
                                </Text>
                            )}
                        </Pressable>

                        {/* Lesson decks */}
                        {!isCollapsed && (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                                {group.decks.map((deck) => {
                                    const progressPct = deck.total > 0 ? ((deck.total - deck.due) / deck.total) * 100 : 0;
                                    return (
                                        <Pressable
                                            key={deck.lessonId}
                                            onPress={() => onSelect(deck.lessonId)}
                                            style={{
                                                width: '47%' as any,
                                                flexGrow: 1,
                                                borderWidth: 1,
                                                borderColor,
                                                borderRadius: 16, padding: 16,
                                                minHeight: 100,
                                                justifyContent: 'space-between',
                                            }}
                                        >
                                            <Text style={{
                                                fontSize: 14, color: theme.colors.text,
                                                ...Typography.default('semiBold'),
                                            }} numberOfLines={2}>
                                                {deck.lessonTitle}
                                            </Text>
                                            <View style={{ marginTop: 12 }}>
                                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                                    <Text style={{
                                                        fontSize: 12, color: theme.colors.textSecondary, opacity: 0.6,
                                                        ...Typography.default(),
                                                    }}>
                                                        {deck.total} карт
                                                    </Text>
                                                    {deck.due > 0 && (
                                                        <Text style={{
                                                            fontSize: 12, color: theme.colors.text,
                                                            ...Typography.default('semiBold'),
                                                        }}>
                                                            {deck.due}
                                                        </Text>
                                                    )}
                                                </View>
                                                {/* Progress bar */}
                                                <View style={{
                                                    height: 3, backgroundColor: theme.colors.textSecondary + '15',
                                                    borderRadius: 2, overflow: 'hidden',
                                                }}>
                                                    <View style={{
                                                        height: '100%',
                                                        width: `${progressPct}%`,
                                                        backgroundColor: theme.colors.textSecondary + '60',
                                                        borderRadius: 2,
                                                    }} />
                                                </View>
                                            </View>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            })}
        </ScrollView>
    );
}

// ============ SwipeCard ============

function SwipeCard({
    card,
    showBack,
    onFlip,
    onRate,
    onSkip,
    onDismiss,
    onGoBack,
    onOpenSource,
    onTimestampPress,
    reviewing,
}: {
    card: FlashCard;
    showBack: boolean;
    onFlip: () => void;
    onRate: (rating: CardRating) => void;
    onSkip: () => void;
    onDismiss: () => void;
    onGoBack: () => void;
    onOpenSource: () => void;
    onTimestampPress?: (seconds: number) => void;
    reviewing: boolean;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [dragX, setDragX] = React.useState(0);
    const [dragY, setDragY] = React.useState(0);
    const [isDragging, setIsDragging] = React.useState(false);
    const [flyAway, setFlyAway] = React.useState<'left' | 'right' | 'down' | 'up' | null>(null);

    React.useEffect(() => {
        setDragX(0);
        setDragY(0);
        setFlyAway(null);
    }, [card.id]);

    const doFlyAway = React.useCallback((dir: 'left' | 'right', cb: () => void) => {
        setFlyAway(dir);
        setTimeout(cb, 300);
    }, []);

    // Web drag handlers
    const startXRef = React.useRef(0);
    const startYRef = React.useRef(0);
    const isDraggingRef = React.useRef(false);
    const dragYRef = React.useRef(0);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const onMove = (clientX: number, clientY: number) => {
            if (!isDraggingRef.current) return;
            const dx = clientX - startXRef.current;
            const dy = clientY - startYRef.current;
            // Determine dominant axis — only move in one direction
            if (Math.abs(dy) > Math.abs(dx)) {
                setDragX(0);
                setDragY(dy);
            } else {
                setDragX(dx);
                setDragY(0);
            }
            dragYRef.current = dy;
        };
        const onEnd = () => {
            if (!isDraggingRef.current) return;
            isDraggingRef.current = false;
            setIsDragging(false);
            const dy = dragYRef.current;
            dragYRef.current = 0;

            // Swipe up to open source (video/lesson)
            if (dy < -SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dragX) && card.lessonId) {
                setFlyAway('up');
                setTimeout(() => {
                    onOpenSource();
                    setFlyAway(null);
                    setDragY(0);
                }, 300);
                setDragX(0);
                setDragY(0);
                return;
            }

            // Swipe down to go back
            if (dy > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dragX)) {
                if (showBack) {
                    // If showing answer, flip back to question (no fly-away)
                    onFlip();
                } else {
                    // If showing question, go back to deck grid
                    setFlyAway('down');
                    setTimeout(() => onGoBack(), 300);
                }
                setDragX(0);
                setDragY(0);
                return;
            }

            setDragY(0);
            setDragX((dx) => {
                if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                    if (showBack) {
                        doFlyAway(dx > 0 ? 'right' : 'left', () => {
                            onRate(dx > 0 ? 3 : 1);
                        });
                    } else {
                        // On question side: both directions skip to next card
                        doFlyAway(dx > 0 ? 'right' : 'left', onSkip);
                    }
                }
                return 0;
            });
        };
        const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
        const onMouseUp = () => onEnd();
        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length === 1 && isDraggingRef.current) {
                e.preventDefault();
                onMove(e.touches[0].clientX, e.touches[0].clientY);
            }
        };
        const onTouchEnd = () => onEnd();

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('touchend', onTouchEnd);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };
    }, [showBack, doFlyAway, onRate, onSkip, onDismiss, onGoBack, onFlip, onOpenSource, card.lessonId]);

    const startDrag = React.useCallback((clientX: number, clientY: number) => {
        startXRef.current = clientX;
        startYRef.current = clientY;
        isDraggingRef.current = true;
        setIsDragging(true);
    }, []);

    // Keyboard arrows for desktop
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (showBack) {
                    doFlyAway('left', () => onRate(1));
                } else {
                    doFlyAway('left', onSkip);
                }
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (showBack) {
                    doFlyAway('right', () => onRate(3));
                } else {
                    doFlyAway('right', onSkip);
                }
            } else if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                if (!showBack) onFlip();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showBack, doFlyAway, onRate, onSkip, onFlip]);

    const rotation = dragX * 0.05;

    const swipeDir = dragY > 25 ? 'down' : dragY < -25 ? 'up' : (Math.abs(dragX) > 25 ? (dragX > 0 ? 'right' : 'left') : null);

    // Swipe indicator labels depend on state
    const rightLabel = showBack ? 'ПОМНЮ' : 'ПРОПУСТИТЬ';
    const leftLabel = showBack ? 'ЗАБЫЛ' : 'УБРАТЬ';
    const rightColor = showBack ? 'rgba(100, 200, 100, 0.8)' : 'rgba(180, 180, 180, 0.6)';
    const leftColor = showBack ? 'rgba(200, 100, 100, 0.8)' : 'rgba(200, 100, 100, 0.6)';
    const downLabel = showBack ? 'ВОПРОС' : 'НАЗАД';
    const downColor = 'rgba(180, 180, 180, 0.6)';
    const hasSource = !!card.lessonId;
    const upLabel = 'ЧАТ';
    const upColor = theme.colors.textLink;

    const SCREEN_HEIGHT = Dimensions.get('window').height;
    const cardTransform = flyAway
        ? flyAway === 'down'
            ? { transform: [{ translateY: SCREEN_HEIGHT }], opacity: 0 }
            : flyAway === 'up'
            ? { transform: [{ translateY: -SCREEN_HEIGHT }], opacity: 0 }
            : {
                transform: [
                    { translateX: flyAway === 'right' ? SCREEN_WIDTH : -SCREEN_WIDTH },
                    { rotate: `${flyAway === 'right' ? 20 : -20}deg` },
                ],
                opacity: 0,
            }
        : {
            transform: [
                { translateX: dragX },
                { translateY: dragY !== 0 ? dragY * 0.5 : 0 },
                { rotate: `${rotation}deg` },
            ],
            opacity: Math.abs(dragY) > 0 ? Math.max(0.5, 1 - Math.abs(dragY) / 300) : 1,
        };

    return (
        <View style={{ flex: 1 }}>
            <View
                style={[
                    {
                        flex: 1,
                        transition: isDragging ? undefined : 'transform 0.3s ease, opacity 0.3s ease',
                    } as any,
                    cardTransform,
                ]}
                {...(Platform.OS === 'web' ? {
                    onMouseDown: (e: any) => { e.preventDefault(); startDrag(e.clientX, e.clientY); },
                    onTouchStart: (e: any) => {
                        if (e.touches?.length === 1) startDrag(e.touches[0].clientX, e.touches[0].clientY);
                    },
                } : {})}
            >
                {/* Swipe indicators */}
                {swipeDir === 'right' && (
                    <View style={{
                        position: 'absolute', top: 24, right: 24, zIndex: 10,
                        paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6,
                        borderWidth: 2, borderColor: rightColor,
                    }}>
                        <Text style={{ color: rightColor, fontSize: 14, fontWeight: '700', ...Typography.default('bold') }}>
                            {rightLabel}
                        </Text>
                    </View>
                )}
                {swipeDir === 'left' && (
                    <View style={{
                        position: 'absolute', top: 24, left: 24, zIndex: 10,
                        paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6,
                        borderWidth: 2, borderColor: leftColor,
                    }}>
                        <Text style={{ color: leftColor, fontSize: 14, fontWeight: '700', ...Typography.default('bold') }}>
                            {leftLabel}
                        </Text>
                    </View>
                )}
                {swipeDir === 'down' && (
                    <View style={{
                        position: 'absolute', bottom: 24, alignSelf: 'center', zIndex: 10,
                        paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8,
                        borderWidth: 2, borderColor: downColor,
                        flexDirection: 'row', alignItems: 'center', gap: 6,
                    }}>
                        <Ionicons name="chevron-down" size={14} color={downColor} />
                        <Text style={{ color: downColor, fontSize: 14, fontWeight: '700', ...Typography.default('bold') }}>
                            {downLabel}
                        </Text>
                    </View>
                )}
                {swipeDir === 'up' && hasSource && (
                    <View style={{
                        position: 'absolute', top: 24, alignSelf: 'center', zIndex: 10,
                        paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8,
                        borderWidth: 2, borderColor: upColor,
                        flexDirection: 'row', alignItems: 'center', gap: 6,
                    }}>
                        <Ionicons name="chatbubble-ellipses" size={14} color={upColor} />
                        <Text style={{ color: upColor, fontSize: 14, fontWeight: '700', ...Typography.default('bold') }}>
                            {upLabel}
                        </Text>
                    </View>
                )}

                {/* Card */}
                <Pressable
                    style={{
                        flex: 1,
                        borderRadius: 20,
                        padding: 32,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.colors.groupped.item,
                        ...(Platform.OS === 'web' ? {
                            cursor: 'grab',
                            userSelect: 'none',
                            touchAction: 'none',
                        } as any : {}),
                    }}
                    onPress={!showBack ? onFlip : undefined}
                >
                    <Text style={{
                        fontSize: 11, color: theme.colors.textSecondary,
                        textTransform: 'uppercase' as const, letterSpacing: 1.5,
                        marginBottom: 24, opacity: 0.6,
                        ...Typography.default('medium'),
                    }}>
                        {showBack ? 'Ответ' : 'Вопрос'}
                    </Text>

                    <View style={{ width: '100%', paddingHorizontal: 8, overflow: 'hidden' as const }}>
                        <Text style={{
                            fontSize: 18, lineHeight: 28, textAlign: 'center',
                            color: theme.colors.text,
                            ...Typography.default('medium'),
                        }}>
                            {showBack ? card.back : card.front}
                        </Text>
                    </View>

                    {!showBack && (
                        <Text style={{
                            marginTop: 32, fontSize: 14,
                            color: theme.colors.textSecondary, opacity: 0.4,
                            ...Typography.default(),
                        }}>
                            Нажми чтобы увидеть ответ
                        </Text>
                    )}
                    {card.timestamp != null && card.timestamp > 0 && card.lessonId && (
                        <Pressable
                            onPress={() => {
                                if (onTimestampPress) {
                                    onTimestampPress(card.timestamp!);
                                } else {
                                    router.push(`/learn/lesson/${card.lessonId}?t=${card.timestamp}` as any);
                                }
                            }}
                            hitSlop={8}
                            style={{
                                position: 'absolute', bottom: 12, right: 16,
                                flexDirection: 'row', alignItems: 'center', gap: 4, opacity: 0.5,
                            }}
                        >
                            <Ionicons name="videocam-outline" size={12} color={theme.colors.textLink} />
                            <Text style={{
                                fontSize: 11, color: theme.colors.textLink,
                                ...Typography.mono(),
                            }}>
                                {formatTimestamp(card.timestamp)}
                            </Text>
                        </Pressable>
                    )}
                </Pressable>
            </View>

            {/* Action buttons — same style on both screens */}
            <View style={{
                flexDirection: 'row', gap: 12, marginTop: 12,
                paddingHorizontal: 4,
            }}>
                <Pressable
                    style={{
                        flex: 1, paddingVertical: 16, borderRadius: 14,
                        backgroundColor: theme.colors.groupped.item,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                    onPress={() => {
                        if (showBack) {
                            doFlyAway('left', () => onRate(1));
                        } else {
                            doFlyAway('left', onSkip);
                        }
                    }}
                    disabled={reviewing}
                >
                    <Ionicons name="arrow-back" size={16} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 15, color: theme.colors.textSecondary,
                        ...Typography.default('medium'),
                    }}>
                        {showBack ? 'Забыл' : 'Убрать'}
                    </Text>
                </Pressable>
                <Pressable
                    style={{
                        flex: 1, paddingVertical: 16, borderRadius: 14,
                        backgroundColor: theme.colors.groupped.item,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                    onPress={() => {
                        if (showBack) {
                            doFlyAway('right', () => onRate(3));
                        } else {
                            doFlyAway('right', onSkip);
                        }
                    }}
                    disabled={reviewing}
                >
                    <Text style={{
                        fontSize: 15, color: theme.colors.text,
                        ...Typography.default('medium'),
                    }}>
                        {showBack ? 'Помню' : 'Пропустить'}
                    </Text>
                    <Ionicons name="arrow-forward" size={16} color={theme.colors.text} />
                </Pressable>
            </View>
        </View>
    );
}

// ============ FlashcardReview ============

interface FlashcardReviewProps {
    embedded?: boolean;
    onTimestampPress?: (seconds: number) => void;
    onOpenSource?: () => void;
}

export const FlashcardReview = React.memo(({ embedded, onTimestampPress, onOpenSource: externalOpenSource }: FlashcardReviewProps = {}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const dueCards = useLearnDueCards();
    const chatSessions = useLearnChatSessions();
    const [showBack, setShowBack] = React.useState(false);
    const [reviewing, setReviewing] = React.useState(false);
    const [startTime, setStartTime] = React.useState(Date.now());
    const [reviewedCount, setReviewedCount] = React.useState(0);
    const [loading, setLoading] = React.useState(true);
    const [selectedLessonId, setSelectedLessonId] = React.useState<string | null>(null);
    const storeDecks = learnStorage((s) => s.decks);
    const [decks, setDecks] = React.useState<Deck[]>([]);
    const [showDecks, setShowDecks] = React.useState(true);

    // Load decks on mount
    React.useEffect(() => {
        learnApi.getDecks()
            .then((res) => {
                setDecks(res.decks);
                learnStorage.getState().setDecks(res.decks);
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    // Sync decks from storage (updated when cards generated from chat)
    React.useEffect(() => {
        if (storeDecks.length > 0) {
            setDecks(storeDecks);
        }
    }, [storeDecks]);

    // Load cards when deck selected
    const loadCards = React.useCallback(async (lessonId?: string) => {
        setLoading(true);
        try {
            const res = await learnApi.getDueCards(50, lessonId);
            learnStorage.getState().setDueCards(res.cards);
            setSelectedLessonId(lessonId || null);
            setShowDecks(false);
            setReviewedCount(0);
            setShowBack(false);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }, []);

    const currentCard = dueCards[0];

    const handleFlip = React.useCallback(() => {
        setShowBack(prev => !prev);
    }, []);

    const handleRate = React.useCallback(async (rating: CardRating) => {
        if (reviewing || !currentCard) return;
        setReviewing(true);
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        try {
            console.log('[rate] Rating card:', currentCard.id, 'rating:', rating);
            await learnApi.reviewCard(currentCard.id, rating, elapsed);
            console.log('[rate] Success');
            learnStorage.getState().removeCard(currentCard.id);
            setReviewedCount((c) => c + 1);
            setShowBack(false);
            setStartTime(Date.now());
        } catch (e) {
            console.error('[rate] Error:', e);
        } finally {
            setReviewing(false);
        }
    }, [currentCard, reviewing, startTime]);

    const handleSkip = React.useCallback(() => {
        if (!currentCard) return;
        // Move card to end of queue
        const cards = learnStorage.getState().dueCards;
        const rest = cards.filter((c) => c.id !== currentCard.id);
        learnStorage.getState().setDueCards([...rest, currentCard]);
        setShowBack(false);
        setStartTime(Date.now());
    }, [currentCard]);

    const handleDismiss = React.useCallback(async () => {
        if (!currentCard) return;
        try {
            console.log('[dismiss] Dismissing card:', currentCard.id);
            await learnApi.dismissCard(currentCard.id);
            console.log('[dismiss] Success, removing from UI');
            learnStorage.getState().removeCard(currentCard.id);
            setShowBack(false);
            setStartTime(Date.now());
        } catch (e) {
            console.error('[dismiss] Error:', e);
        }
    }, [currentCard]);

    const goBack = React.useCallback(() => {
        setShowDecks(true);
        setSelectedLessonId(null);
        learnStorage.getState().setDueCards([]);
        // Reload decks
        learnApi.getDecks()
            .then((res) => setDecks(res.decks))
            .catch(console.error);
    }, []);

    // Show deck selection
    if (showDecks) {
        return (
            <DeckGrid
                decks={decks}
                loading={loading}
                onSelect={(lessonId) => loadCards(lessonId)}
                onSelectAll={() => loadCards()}
            />
        );
    }

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
            </View>
        );
    }

    // Done / empty
    if (dueCards.length === 0 || !currentCard) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
                <Text style={{
                    fontSize: 20, color: theme.colors.text, marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}>
                    {reviewedCount > 0 ? 'Сессия завершена' : 'Всё повторено'}
                </Text>
                <Text style={{
                    fontSize: 15, color: theme.colors.textSecondary, marginBottom: 24,
                    ...Typography.default(),
                }}>
                    {reviewedCount > 0
                        ? `${reviewedCount} карточек пройдено`
                        : 'Нет карточек для повторения'}
                </Text>
                <Pressable onPress={goBack} style={{
                    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12,
                    backgroundColor: theme.colors.groupped.item,
                }}>
                    <Text style={{
                        fontSize: 14, color: theme.colors.text,
                        ...Typography.default('medium'),
                    }}>
                        К колодам
                    </Text>
                </Pressable>
            </View>
        );
    }

    const totalCards = reviewedCount + dueCards.length;
    const progress = totalCards > 0 ? (reviewedCount / totalCards) * 100 : 0;

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            {/* Header */}
            <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                paddingTop: 12, paddingBottom: 8, paddingHorizontal: 16,
            }}>
                <Pressable
                    onPress={() => showBack ? setShowBack(false) : goBack()}
                    style={{ position: 'absolute', left: 16 }}
                >
                    <Ionicons name="chevron-back" size={20} color={theme.colors.textSecondary} />
                </Pressable>
                <Text style={{
                    fontSize: 14, color: theme.colors.textSecondary,
                    ...Typography.default('medium'),
                }}>
                    {reviewedCount + 1} / {totalCards}
                </Text>
            </View>

            {/* Progress bar */}
            <View style={{
                height: 2, backgroundColor: theme.colors.groupped.item,
                marginHorizontal: 20, borderRadius: 1, overflow: 'hidden',
            }}>
                <View style={{
                    height: '100%', width: `${progress}%`,
                    backgroundColor: theme.colors.textSecondary,
                    borderRadius: 1,
                }} />
            </View>

            {/* Card */}
            <View style={{ flex: 1, padding: 20 }}>
                <SwipeCard
                    key={currentCard.id}
                    card={currentCard}
                    showBack={showBack}
                    onFlip={handleFlip}
                    onRate={handleRate}
                    onSkip={handleSkip}
                    onDismiss={handleDismiss}
                    onGoBack={goBack}
                    onTimestampPress={onTimestampPress}
                    onOpenSource={externalOpenSource || (() => {
                        if (!currentCard.lessonId) return;
                        const t = currentCard.timestamp;
                        // Store pending seek for session view to pick up
                        if (t != null && t > 0) {
                            learnStorage.getState().setPendingSeekTo(t);
                        }
                        // Find existing session for this lesson
                        const lessonContext = `lesson:${currentCard.lessonId}`;
                        const existingSession = chatSessions.find(
                            (s) => s.context === lessonContext && !s.archived
                        );
                        if (existingSession) {
                            router.replace(`/learn/chat/${existingSession.id}?lessonId=${currentCard.lessonId}` as any);
                        } else {
                            const params = new URLSearchParams();
                            params.set('lessonId', currentCard.lessonId);
                            if (currentCard.courseId) params.set('courseId', currentCard.courseId);
                            router.replace(`/learn/chat/new?${params.toString()}` as any);
                        }
                    })}
                    reviewing={reviewing}
                />
            </View>
        </View>
    );
});
