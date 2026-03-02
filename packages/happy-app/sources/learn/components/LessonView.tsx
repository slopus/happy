import * as React from 'react';
import { Text, View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { learnApi } from '../learnApi';
import { learnStorage } from '../learnStorage';
import type { LessonContent } from '../learnTypes';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        padding: 16,
        paddingBottom: 100,
    },
    lessonHeader: {
        marginBottom: 16,
    },
    breadcrumb: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    lessonTitle: {
        fontSize: 22,
        color: theme.colors.text,
        ...Typography.default('bold'),
    },
    videoContainer: {
        marginBottom: 16,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#000',
    },
    objectivesContainer: {
        marginBottom: 16,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.item,
    },
    objectivesTitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    objectiveRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        paddingVertical: 2,
    },
    objectiveText: {
        fontSize: 14,
        color: theme.colors.text,
        flex: 1,
        ...Typography.default(),
    },
    markdownContainer: {
        marginBottom: 20,
    },
    footer: {
        padding: 16,
        paddingBottom: 40,
        gap: 12,
    },
    completeButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 14,
        borderRadius: 12,
    },
    completeButtonText: {
        fontSize: 16,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
    completedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
    },
    completedText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    navRow: {
        flexDirection: 'row',
        gap: 8,
    },
    navButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.item,
    },
    navButtonText: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

// Web video player component
const VideoPlayer = React.memo(({ url: rawUrl, startTime }: { url: string; startTime?: number }) => {
    if (Platform.OS !== 'web') {
        return null;
    }

    // Add /videos/ prefix for relative paths (served from nginx)
    const url = rawUrl.startsWith('http') || rawUrl.startsWith('/') ? rawUrl : `/videos/${rawUrl}`;
    const videoSrc = startTime ? `${encodeURI(url)}#t=${startTime}` : encodeURI(url);

    return (
        <View style={styles.videoContainer}>
            {/* @ts-ignore - HTML video element on web */}
            <video
                src={videoSrc}
                controls
                playsInline
                autoPlay={!!startTime}
                style={{
                    width: '100%',
                    maxHeight: 500,
                    backgroundColor: '#000',
                    display: 'block',
                }}
            />
        </View>
    );
});

interface LessonViewProps {
    lessonId: string;
    startTime?: number;
}

export const LessonView = React.memo(({ lessonId, startTime }: LessonViewProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [lesson, setLesson] = React.useState<LessonContent | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [completing, setCompleting] = React.useState(false);
    const isCompleted = lesson?.lessonState?.some((s) => s.status === 'COMPLETED') ?? false;

    React.useEffect(() => {
        setLoading(true);
        learnApi.getLesson(lessonId).then((res) => {
            setLesson(res.lesson);
        }).catch(console.error).finally(() => setLoading(false));
    }, [lessonId]);

    const handleComplete = React.useCallback(async () => {
        if (completing || !lesson) return;
        setCompleting(true);
        try {
            await learnApi.completeLesson(lessonId);
            setLesson((prev) => prev ? {
                ...prev,
                lessonState: [{ status: 'COMPLETED', completedAt: new Date().toISOString() }],
            } : prev);
            // Refresh courses in store
            const { courses } = await learnApi.getCourses();
            learnStorage.getState().setCourses(courses);
        } catch (e) {
            console.error(e);
        } finally {
            setCompleting(false);
        }
    }, [lessonId, lesson, completing]);

    if (loading || !lesson) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator />
            </View>
        );
    }

    const siblings = lesson.module?.lessons || [];
    const currentIdx = siblings.findIndex((l) => l.id === lesson.id);
    const prevLesson = currentIdx > 0 ? siblings[currentIdx - 1] : null;
    const nextLesson = currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

    return (
        <ScrollView style={styles.container}>
            {lesson.videoUrl && (
                <VideoPlayer url={lesson.videoUrl} startTime={startTime} />
            )}

            <View style={styles.content}>
                <View style={styles.lessonHeader}>
                    {lesson.module?.course && (
                        <Text style={styles.breadcrumb}>
                            {lesson.module.course.title}
                        </Text>
                    )}
                    <Text style={styles.lessonTitle}>{lesson.title}</Text>
                </View>

                {lesson.objectives && lesson.objectives.length > 0 && (
                    <View style={styles.objectivesContainer}>
                        <Text style={styles.objectivesTitle}>Learning objectives</Text>
                        {lesson.objectives.map((obj, i) => (
                            <View key={i} style={styles.objectiveRow}>
                                <Ionicons name="checkmark-circle-outline" size={16} color={theme.colors.accent} style={{ marginTop: 1 }} />
                                <Text style={styles.objectiveText}>{obj}</Text>
                            </View>
                        ))}
                    </View>
                )}

                {lesson.content && (() => {
                    // Handle structured blocks content (from pipeline)
                    const c = lesson.content as any;
                    if (c && typeof c === 'object' && Array.isArray(c.blocks)) {
                        const parts: string[] = [];
                        for (const block of c.blocks) {
                            if (block.type === 'text' && block.content) {
                                parts.push(block.content);
                            } else if (block.type === 'section') {
                                // Flat structure: block.title, block.summary
                                const title = block.title || block.section?.title;
                                const summary = block.summary || block.section?.summary || '';
                                if (title) parts.push(`### ${title}\n\n${summary}`);
                            } else if (block.type === 'key_point') {
                                const content = block.content || block.key_point?.content;
                                if (content) parts.push(`- ${content}`);
                            } else if (block.type === 'term') {
                                // Flat: block.term (string), block.definition
                                const term = typeof block.term === 'string' ? block.term : block.term?.term;
                                const def = block.definition || block.term?.definition;
                                if (term && def) parts.push(`**${term}** — ${def}`);
                            } else if (block.type === 'quiz') {
                                const q = block.question || block.quiz?.question;
                                const a = block.answer || block.quiz?.answer;
                                if (q && a) parts.push(`> **${q}**\n> ${a}`);
                            } else if (block.type === 'practical_step') {
                                const step = block.step;
                                const desc = block.description;
                                if (step) parts.push(`**${step}**${desc ? `\n${desc}` : ''}`);
                            }
                        }
                        const markdown = parts.join('\n\n');
                        return markdown ? (
                            <View style={styles.markdownContainer}>
                                <MarkdownView markdown={markdown} />
                            </View>
                        ) : null;
                    }
                    // String content
                    if (typeof c === 'string') {
                        return (
                            <View style={styles.markdownContainer}>
                                <MarkdownView markdown={c} />
                            </View>
                        );
                    }
                    return null;
                })()}
            </View>

            <View style={styles.footer}>
                {isCompleted ? (
                    <View style={styles.completedBadge}>
                        <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent} />
                        <Text style={styles.completedText}>Completed</Text>
                    </View>
                ) : (
                    <Pressable
                        style={[styles.completeButton, { backgroundColor: theme.colors.accent }]}
                        onPress={handleComplete}
                        disabled={completing}
                    >
                        {completing ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <>
                                <Ionicons name="checkmark-circle" size={20} color="#fff" />
                                <Text style={styles.completeButtonText}>Complete lesson</Text>
                            </>
                        )}
                    </Pressable>
                )}

                <View style={styles.navRow}>
                    {prevLesson && (
                        <Pressable
                            style={styles.navButton}
                            onPress={() => router.replace(`/learn/lesson/${prevLesson.id}` as any)}
                        >
                            <Ionicons name="chevron-back" size={16} color={theme.colors.text} />
                            <Text style={styles.navButtonText} numberOfLines={1}>Previous</Text>
                        </Pressable>
                    )}
                    {nextLesson && (
                        <Pressable
                            style={styles.navButton}
                            onPress={() => router.replace(`/learn/lesson/${nextLesson.id}` as any)}
                        >
                            <Text style={styles.navButtonText} numberOfLines={1}>Next</Text>
                            <Ionicons name="chevron-forward" size={16} color={theme.colors.text} />
                        </Pressable>
                    )}
                </View>
            </View>
        </ScrollView>
    );
});
