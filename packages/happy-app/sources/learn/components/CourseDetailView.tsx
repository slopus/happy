import * as React from 'react';
import { Text, View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { learnApi } from '../learnApi';
import type { Course, CourseModule } from '../learnTypes';

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
    header: {
        padding: 20,
        paddingBottom: 16,
    },
    title: {
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('bold'),
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginTop: 6,
        lineHeight: 20,
        ...Typography.default(),
    },
    progressContainer: {
        marginTop: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    progressBar: {
        flex: 1,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.divider,
    },
    progressFill: {
        height: '100%',
        borderRadius: 3,
    },
    progressText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
        minWidth: 36,
        textAlign: 'right',
    },
    moduleSection: {
        marginBottom: 8,
    },
    moduleHeader: {
        paddingHorizontal: 20,
        paddingVertical: 10,
    },
    moduleTitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase' as const,
        letterSpacing: 0.5,
        ...Typography.default('semiBold'),
    },
    lessonItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 12,
        backgroundColor: theme.colors.groupped.item,
        gap: 12,
    },
    lessonBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    lessonIcon: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    lessonInfo: {
        flex: 1,
        gap: 2,
    },
    lessonTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    lessonMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    chevron: {
        marginLeft: 4,
    },
}));

interface CourseDetailViewProps {
    courseId: string;
}

export const CourseDetailView = React.memo(({ courseId }: CourseDetailViewProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [course, setCourse] = React.useState<(Course & { modules: CourseModule[] }) | null>(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        learnApi.getCourse(courseId).then((res) => {
            setCourse(res.course);
        }).catch(console.error).finally(() => setLoading(false));
    }, [courseId]);

    if (loading || !course) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator />
            </View>
        );
    }

    const progress = Array.isArray(course.progress) ? course.progress[0] : course.progress;
    const pct = progress?.pct ?? 0;
    const totalLessons = course.modules?.reduce((sum, m) => sum + (m.lessons?.length || 0), 0) || 0;
    const completedLessons = course.modules?.reduce((sum, m) =>
        sum + (m.lessons?.filter((l) => l.lessonState?.some((s) => s.status === 'COMPLETED')).length || 0), 0) || 0;

    return (
        <ScrollView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{course.title}</Text>
                {course.description && (
                    <Text style={styles.description}>{course.description}</Text>
                )}
                <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                        <View style={[styles.progressFill, {
                            width: `${pct}%`,
                            backgroundColor: course.color || theme.colors.accent,
                        }]} />
                    </View>
                    <Text style={styles.progressText}>
                        {completedLessons}/{totalLessons}
                    </Text>
                </View>
            </View>

            {course.modules?.map((mod) => (
                <View key={mod.id} style={styles.moduleSection}>
                    <View style={styles.moduleHeader}>
                        <Text style={styles.moduleTitle}>{mod.title}</Text>
                    </View>
                    {mod.lessons?.map((lesson, i) => {
                        const isCompleted = lesson.lessonState?.some((s) => s.status === 'COMPLETED');
                        const isLast = i === mod.lessons.length - 1;
                        const iconName = isCompleted ? 'checkmark-circle' : lesson.type === 'VIDEO' ? 'play-circle-outline' : 'document-text-outline';
                        const iconColor = isCompleted ? (course.color || theme.colors.accent) : theme.colors.textSecondary;

                        return (
                            <Pressable
                                key={lesson.id}
                                style={[styles.lessonItem, !isLast && styles.lessonBorder]}
                                onPress={() => router.push(`/learn/lesson/${lesson.id}` as any)}
                            >
                                <View style={[styles.lessonIcon, {
                                    backgroundColor: isCompleted
                                        ? (course.color || theme.colors.accent) + '20'
                                        : theme.colors.divider,
                                }]}>
                                    <Ionicons name={iconName as any} size={18} color={iconColor} />
                                </View>
                                <View style={styles.lessonInfo}>
                                    <Text style={[styles.lessonTitle, isCompleted && { color: theme.colors.textSecondary }]}>
                                        {lesson.title}
                                    </Text>
                                    <Text style={styles.lessonMeta}>
                                        {lesson.duration ? `${lesson.duration} min` : lesson.type}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} style={styles.chevron} />
                            </Pressable>
                        );
                    })}
                </View>
            ))}
            <View style={{ height: 40 }} />
        </ScrollView>
    );
});
