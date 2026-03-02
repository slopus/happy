import * as React from 'react';
import { Text, View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { LessonBlocks } from './LearnContentPanel';
import { learnStorage, useLearnRightPanelTab, useLearnActiveLesson } from '../learnStorage';
import { learnApi } from '../learnApi';
import type { FlashCard } from '../learnTypes';

const isWeb = Platform.OS === 'web';

// Tab config
const TABS: { key: 'transcript' | 'cards' | 'lessons'; icon: string; label: string }[] = [
    { key: 'transcript', icon: 'document-text-outline', label: 'Конспект' },
    { key: 'cards', icon: 'layers-outline', label: 'Карточки' },
    { key: 'lessons', icon: 'list-outline', label: 'Уроки' },
];

// ========== MiniCardsList ==========

function MiniCardsList({ lessonId, courseColor }: { lessonId: string; courseColor?: string }) {
    const { theme } = useUnistyles();
    const [cards, setCards] = React.useState<FlashCard[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [flippedIds, setFlippedIds] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        setLoading(true);
        learnApi.getDueCards(100, lessonId)
            .then((res) => setCards(res.cards))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [lessonId]);

    const toggleFlip = React.useCallback((id: string) => {
        setFlippedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    if (cards.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Ionicons name="layers-outline" size={28} color={theme.colors.textSecondary} style={{ opacity: 0.4, marginBottom: 8 }} />
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, textAlign: 'center', ...Typography.default() }}>
                    Нет карточек для этого урока
                </Text>
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 4, opacity: 0.6, ...Typography.default() }}>
                    Попроси AI в чате: «сделай карточки»
                </Text>
            </View>
        );
    }

    const typeColors: Record<string, string> = {
        QA: '#2196F3',
        CLOZE: '#FF9800',
        CODE_FIX: '#E91E63',
        EXPLAIN: '#9C27B0',
        FEYNMAN: '#4CAF50',
    };

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 6 }}>
            {cards.map((card) => {
                const isFlipped = flippedIds.has(card.id);
                return (
                    <Pressable
                        key={card.id}
                        onPress={() => toggleFlip(card.id)}
                        style={({ hovered }: any) => ({
                            padding: 12,
                            borderRadius: 10,
                            backgroundColor: hovered ? theme.colors.surfaceSelected || theme.colors.groupped.item : theme.colors.groupped.item,
                            borderLeftWidth: 3,
                            borderLeftColor: typeColors[card.type] || theme.colors.textSecondary,
                            ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                        })}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <Text style={{
                                fontSize: 9, color: typeColors[card.type] || theme.colors.textSecondary,
                                textTransform: 'uppercase' as const, letterSpacing: 1,
                                ...Typography.default('semiBold'),
                            }}>
                                {card.type}
                            </Text>
                            {card.timestamp != null && card.timestamp > 0 && (
                                <Text style={{ fontSize: 9, color: theme.colors.textSecondary, ...Typography.mono() }}>
                                    {Math.floor(card.timestamp / 60)}:{(card.timestamp % 60).toString().padStart(2, '0')}
                                </Text>
                            )}
                        </View>
                        <Text style={{
                            fontSize: 12, lineHeight: 17,
                            color: isFlipped ? theme.colors.textSecondary : theme.colors.text,
                            ...Typography.default(isFlipped ? 'regular' : 'medium'),
                        }}>
                            {isFlipped ? card.back : card.front}
                        </Text>
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}

// ========== CourseTree (full course > modules > lessons) ==========

function CourseTree({
    activeId,
    onNavigate,
    courseColor,
}: {
    activeId?: string;
    onNavigate: (lessonId: string) => void;
    courseColor?: string;
}) {
    const { theme } = useUnistyles();
    const activeLesson = useLearnActiveLesson();
    const [course, setCourse] = React.useState<any>(null);
    const [loading, setLoading] = React.useState(true);

    const courseId = activeLesson?.module?.courseId;

    React.useEffect(() => {
        if (!courseId) { setLoading(false); return; }
        setLoading(true);
        learnApi.getCourse(courseId)
            .then((res) => setCourse(res.course))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [courseId]);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    const modules = course?.modules || [];
    if (modules.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Ionicons name="list-outline" size={28} color={theme.colors.textSecondary} style={{ opacity: 0.4, marginBottom: 8 }} />
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                    Нет уроков
                </Text>
            </View>
        );
    }

    const hasMultipleModules = modules.length > 1;

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
            {modules.map((mod: any, mi: number) => {
                const lessons = mod.lessons || [];
                return (
                    <View key={mod.id || mi}>
                        {/* Module header (only if multiple modules) */}
                        {hasMultipleModules && (
                            <View style={{
                                flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 10, paddingTop: mi > 0 ? 12 : 6, paddingBottom: 4,
                            }}>
                                <Ionicons name="folder-outline" size={13} color={courseColor || theme.colors.textSecondary} />
                                <Text style={{
                                    flex: 1, fontSize: 11, color: theme.colors.textSecondary,
                                    textTransform: 'uppercase', letterSpacing: 0.5,
                                    ...Typography.default('semiBold'),
                                }} numberOfLines={1}>
                                    {mod.title}
                                </Text>
                                <Text style={{
                                    fontSize: 10, color: theme.colors.textSecondary, opacity: 0.5,
                                    ...Typography.default(),
                                }}>
                                    {lessons.length}
                                </Text>
                            </View>
                        )}
                        {/* Lessons */}
                        {lessons.map((lesson: any, li: number) => {
                            const isCurrent = lesson.id === activeId;
                            const done = lesson.lessonState?.some((s: any) => s.status === 'COMPLETED') ?? false;
                            return (
                                <Pressable
                                    key={lesson.id}
                                    onPress={() => onNavigate(lesson.id)}
                                    style={({ hovered }: any) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 8,
                                        paddingHorizontal: hasMultipleModules ? 16 : 12,
                                        paddingVertical: 8,
                                        backgroundColor: isCurrent ? 'rgba(255,255,255,0.08)' : hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
                                        ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                                    })}
                                >
                                    <Text style={{
                                        fontSize: 11, color: theme.colors.textSecondary,
                                        width: 18, textAlign: 'center',
                                        ...Typography.default(),
                                    }}>
                                        {li + 1}
                                    </Text>
                                    <Ionicons
                                        name={done ? 'checkmark-circle' : isCurrent ? 'radio-button-on' : 'ellipse-outline'}
                                        size={14}
                                        color={done ? '#4CAF50' : isCurrent ? theme.colors.text : theme.colors.textSecondary}
                                    />
                                    <Text style={{
                                        flex: 1, fontSize: 12,
                                        color: isCurrent ? theme.colors.text : theme.colors.textSecondary,
                                        ...Typography.default(isCurrent ? 'semiBold' : 'regular'),
                                    }} numberOfLines={2}>
                                        {lesson.title}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                );
            })}
        </ScrollView>
    );
}

// ========== RightPanelTabs ==========

interface RightPanelTabsProps {
    onTimestampPress?: (seconds: number) => void;
    onNavigateToLesson?: (lessonId: string) => void;
    courseColor?: string;
}

export const RightPanelTabs = React.memo(({ onTimestampPress, onNavigateToLesson, courseColor }: RightPanelTabsProps) => {
    const { theme } = useUnistyles();
    const activeTab = useLearnRightPanelTab();
    const activeLesson = useLearnActiveLesson();

    return (
        <View style={{ flex: 1 }}>
            {/* Tab bar */}
            <View style={{
                flexDirection: 'row',
                borderBottomWidth: 0.5,
                borderBottomColor: theme.colors.divider,
            }}>
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.key;
                    return (
                        <Pressable
                            key={tab.key}
                            onPress={() => learnStorage.getState().setRightPanelTab(tab.key)}
                            style={({ hovered }: any) => ({
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 4,
                                paddingVertical: 10,
                                borderBottomWidth: 2,
                                borderBottomColor: isActive ? (courseColor || theme.colors.textLink) : 'transparent',
                                backgroundColor: hovered && !isActive ? 'rgba(255,255,255,0.04)' : 'transparent',
                                ...(isWeb ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                            })}
                        >
                            <Ionicons
                                name={tab.icon as any}
                                size={14}
                                color={isActive ? theme.colors.text : theme.colors.textSecondary}
                            />
                            <Text style={{
                                fontSize: 12,
                                color: isActive ? theme.colors.text : theme.colors.textSecondary,
                                ...Typography.default(isActive ? 'semiBold' : 'regular'),
                            }}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            {/* Tab content */}
            {activeTab === 'transcript' && (
                activeLesson?.content ? (
                    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
                        <LessonBlocks content={activeLesson.content} theme={theme} onTimestampPress={onTimestampPress} courseColor={courseColor} />
                    </ScrollView>
                ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                        <Ionicons name="hourglass-outline" size={28} color={theme.colors.textSecondary} style={{ opacity: 0.4 }} />
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 8, opacity: 0.6, ...Typography.default() }}>
                            Конспект появится{'\n'}после обработки видео
                        </Text>
                    </View>
                )
            )}

            {activeTab === 'cards' && activeLesson?.id && (
                <MiniCardsList lessonId={activeLesson.id} courseColor={courseColor} />
            )}
            {activeTab === 'cards' && !activeLesson?.id && (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                        Выбери урок
                    </Text>
                </View>
            )}

            {activeTab === 'lessons' && (
                <CourseTree
                    activeId={activeLesson?.id}
                    onNavigate={onNavigateToLesson || (() => {})}
                    courseColor={courseColor}
                />
            )}
        </View>
    );
});
