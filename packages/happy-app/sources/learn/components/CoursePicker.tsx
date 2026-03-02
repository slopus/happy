import * as React from 'react';
import { Text, View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { learnApi } from '../learnApi';
import { useLearnCourses } from '../learnStorage';
import type { Course, CourseModule } from '../learnTypes';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContent: {
        paddingBottom: 40,
        paddingTop: 8,
    },
    // Course item
    courseItem: {
        marginHorizontal: 12,
        marginTop: 8,
        borderRadius: 12,
        backgroundColor: theme.colors.groupped.item,
        overflow: 'hidden',
    },
    courseHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 10,
    },
    courseIcon: {
        width: 36,
        height: 36,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
    },
    courseInfo: {
        flex: 1,
    },
    courseTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    courseMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
        ...Typography.default(),
    },
    // Module item
    moduleHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 24,
        paddingRight: 14,
        paddingVertical: 10,
        gap: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    moduleTitle: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    moduleMeta: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    // Lesson item
    lessonItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 44,
        paddingRight: 14,
        paddingVertical: 8,
        gap: 8,
    },
    lessonTitle: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    lessonDuration: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    // General chat option
    generalOption: {
        marginHorizontal: 12,
        marginTop: 8,
        borderRadius: 12,
        backgroundColor: theme.colors.groupped.item,
        overflow: 'hidden',
    },
    generalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 10,
    },
}));

function formatDuration(seconds: number | null): string {
    if (!seconds) return '';
    const mins = Math.round(seconds / 60);
    return `${mins} min`;
}

interface CoursePickerProps {
    onSelectCourse: (courseId: string) => void;
    onSelectLesson: (courseId: string, lessonId: string) => void;
    onSelectGeneral: () => void;
}

// Expandable course with lazy-loaded modules
const CoursePickerItem = React.memo(({
    course,
    onSelectCourse,
    onSelectLesson,
}: {
    course: Course;
    onSelectCourse: (courseId: string) => void;
    onSelectLesson: (courseId: string, lessonId: string) => void;
}) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [modules, setModules] = React.useState<CourseModule[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [expandedModules, setExpandedModules] = React.useState<Set<string>>(new Set());

    const handleToggle = React.useCallback(async () => {
        if (!expanded && !modules) {
            setLoading(true);
            try {
                const res = await learnApi.getCourse(course.id);
                setModules(res.course.modules);
            } catch (e) {
                console.error('Failed to load course modules:', e);
            } finally {
                setLoading(false);
            }
        }
        setExpanded(!expanded);
    }, [expanded, modules, course.id]);

    const toggleModule = React.useCallback((moduleId: string) => {
        setExpandedModules(prev => {
            const next = new Set(prev);
            if (next.has(moduleId)) next.delete(moduleId);
            else next.add(moduleId);
            return next;
        });
    }, []);

    return (
        <View style={styles.courseItem}>
            {/* Course header — tap to start session with this course */}
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Pressable
                    style={({ pressed }) => [
                        styles.courseHeader,
                        { flex: 1, opacity: pressed ? 0.7 : 1 },
                    ]}
                    onPress={() => onSelectCourse(course.id)}
                >
                    <View style={[styles.courseIcon, { backgroundColor: course.color || theme.colors.accent }]}>
                        <Ionicons name="book" size={18} color="#fff" />
                    </View>
                    <View style={styles.courseInfo}>
                        <Text style={styles.courseTitle} numberOfLines={1}>{course.title}</Text>
                        {course.description && (
                            <Text style={styles.courseMeta} numberOfLines={2}>{course.description}</Text>
                        )}
                    </View>
                </Pressable>
                {/* Chevron to expand modules */}
                <Pressable
                    onPress={handleToggle}
                    hitSlop={10}
                    style={({ pressed }) => ({
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                        opacity: pressed ? 0.5 : 1,
                    })}
                >
                    {loading ? (
                        <ActivityIndicator size="small" />
                    ) : (
                        <Ionicons
                            name={expanded ? 'chevron-down' : 'chevron-forward'}
                            size={16}
                            color={theme.colors.textSecondary}
                        />
                    )}
                </Pressable>
            </View>

            {/* Expanded modules and lessons */}
            {expanded && modules && modules.map((mod) => (
                <View key={mod.id}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.moduleHeader,
                            { opacity: pressed ? 0.7 : 1 },
                        ]}
                        onPress={() => toggleModule(mod.id)}
                    >
                        <Ionicons
                            name={expandedModules.has(mod.id) ? 'chevron-down' : 'chevron-forward'}
                            size={12}
                            color={theme.colors.textSecondary}
                        />
                        <Text style={styles.moduleTitle} numberOfLines={1}>{mod.title}</Text>
                        <Text style={styles.moduleMeta}>{mod.lessons.length} lessons</Text>
                    </Pressable>

                    {expandedModules.has(mod.id) && mod.lessons
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((lesson) => (
                            <Pressable
                                key={lesson.id}
                                style={({ pressed }) => [
                                    styles.lessonItem,
                                    { opacity: pressed ? 0.7 : 1 },
                                ]}
                                onPress={() => onSelectLesson(course.id, lesson.id)}
                            >
                                <Ionicons
                                    name={lesson.type === 'VIDEO' ? 'play-circle-outline' : 'document-text-outline'}
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={styles.lessonTitle} numberOfLines={1}>{lesson.title}</Text>
                                {lesson.duration != null && lesson.duration > 0 && (
                                    <Text style={styles.lessonDuration}>{formatDuration(lesson.duration)}</Text>
                                )}
                            </Pressable>
                        ))}
                </View>
            ))}
        </View>
    );
});

export const CoursePicker = React.memo(({
    onSelectCourse,
    onSelectLesson,
    onSelectGeneral,
}: CoursePickerProps) => {
    const { theme } = useUnistyles();
    const courses = useLearnCourses();

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
            {/* General chat — no specific course */}
            <Pressable
                style={({ pressed }) => [
                    styles.generalOption,
                    { opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={onSelectGeneral}
            >
                <View style={styles.generalHeader}>
                    <View style={[styles.courseIcon, { backgroundColor: theme.colors.textSecondary }]}>
                        <Ionicons name="chatbubble-outline" size={18} color="#fff" />
                    </View>
                    <View style={styles.courseInfo}>
                        <Text style={styles.courseTitle}>Free Chat</Text>
                        <Text style={styles.courseMeta}>Ask anything without a specific course</Text>
                    </View>
                </View>
            </Pressable>

            {/* Courses */}
            {courses.map((course) => (
                <CoursePickerItem
                    key={course.id}
                    course={course}
                    onSelectCourse={onSelectCourse}
                    onSelectLesson={onSelectLesson}
                />
            ))}
        </ScrollView>
    );
});
