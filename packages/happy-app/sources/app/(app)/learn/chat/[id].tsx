import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useIsTablet } from '@/utils/responsive';
import { LearnChatView } from '@/learn/components/LearnChatView';
import { LearnSessionView } from '@/learn/components/LearnSessionView';
import { CoursePicker } from '@/learn/components/CoursePicker';
import { useLearnChatSessions, useLearnCourses } from '@/learn/learnStorage';

export default function ChatScreen() {
    const { id, courseId: qsCourseId, lessonId: qsLessonId } = useLocalSearchParams<{
        id: string;
        courseId?: string;
        lessonId?: string;
    }>();
    const { theme } = useUnistyles();
    const router = useRouter();
    const isTablet = useIsTablet();
    const sessions = useLearnChatSessions();
    const courses = useLearnCourses();

    const isNew = id === 'new';
    const session = React.useMemo(
        () => (isNew ? null : sessions.find((s) => s.id === id)),
        [sessions, id, isNew]
    );

    // Redirect to existing session if opening "new" with a lessonId that already has a live session
    React.useEffect(() => {
        if (isNew && qsLessonId) {
            const lessonContext = `lesson:${qsLessonId}`;
            const existing = sessions.find((s) => s.context === lessonContext && !s.archived);
            if (existing) {
                router.replace(`/learn/chat/${existing.id}` as any);
            }
        }
    }, [isNew, qsLessonId, sessions, router]);

    // For new chats: track selected courseId locally so we can transition from picker to chat
    const [selectedCourseId, setSelectedCourseId] = React.useState<string | undefined>(qsCourseId || undefined);
    const [selectedLessonId, setSelectedLessonId] = React.useState<string | undefined>(qsLessonId || undefined);
    const [showChat, setShowChat] = React.useState(!isNew || !!qsCourseId);

    // Resolve courseId: local selection > query string > existing session
    const courseId = selectedCourseId || qsCourseId || session?.courseId || undefined;
    const lessonId = selectedLessonId || qsLessonId || undefined;

    // Find course title for header
    const courseTitle = React.useMemo(() => {
        if (!courseId) return null;
        return courses.find(c => c.id === courseId)?.title || session?.courseTitle || null;
    }, [courseId, courses, session]);

    // Header title
    const headerTitle = isNew
        ? (showChat ? (courseTitle || 'New Chat') : 'New Session')
        : (session?.title || 'Chat');

    // Course picker handlers
    const handleSelectCourse = React.useCallback((cId: string) => {
        setSelectedCourseId(cId);
        setSelectedLessonId(undefined);
        setShowChat(true);
    }, []);

    const handleSelectLesson = React.useCallback((cId: string, lId: string) => {
        // Check for existing non-archived session for this lesson
        const lessonContext = `lesson:${lId}`;
        const existing = sessions.find((s) => s.context === lessonContext && !s.archived);
        if (existing) {
            router.replace(`/learn/chat/${existing.id}` as any);
            return;
        }
        setSelectedCourseId(cId);
        setSelectedLessonId(lId);
        setShowChat(true);
    }, [sessions, router]);

    const handleSelectGeneral = React.useCallback(() => {
        setSelectedCourseId(undefined);
        setSelectedLessonId(undefined);
        setShowChat(true);
    }, []);

    // Web (tablet + phone): use LearnSessionView (handles both layouts internally)
    if (Platform.OS === 'web' && (showChat || !isNew)) {
        // Build a session-like object for LearnSessionView
        const sessionForView = session || (courseId ? {
            id: 'new',
            title: headerTitle,
            courseId,
            courseTitle: courseTitle || undefined,
        } : undefined);

        return (
            <LearnSessionView
                sessionId={isNew ? 'new' : id}
                session={sessionForView as any}
                initialLessonId={lessonId}
            />
        );
    }

    // Phone mode or new chat with course picker
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            {/* Header */}
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 12,
                paddingTop: Platform.OS === 'web' && isTablet ? 16 : 56,
                paddingBottom: 8,
                gap: 8,
                borderBottomWidth: 0.5,
                borderBottomColor: theme.colors.divider,
            }}>
                <Pressable onPress={() => {
                    if (isNew && showChat) {
                        // Go back to course picker
                        setShowChat(false);
                        setSelectedCourseId(undefined);
                        setSelectedLessonId(undefined);
                    } else {
                        router.back();
                    }
                }} hitSlop={10}>
                    <Ionicons name="chevron-back" size={24} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                    <Text style={{
                        fontSize: 15,
                        color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }} numberOfLines={1}>
                        {headerTitle}
                    </Text>
                    {showChat && courseTitle && session?.title && (
                        <Text style={{
                            fontSize: 11,
                            color: theme.colors.textSecondary,
                            marginTop: 1,
                            ...Typography.default(),
                        }} numberOfLines={1}>
                            {courseTitle}
                        </Text>
                    )}
                </View>
            </View>

            {/* Content: Course picker or Chat */}
            {isNew && !showChat ? (
                <CoursePicker
                    onSelectCourse={handleSelectCourse}
                    onSelectLesson={handleSelectLesson}
                    onSelectGeneral={handleSelectGeneral}
                />
            ) : (
                <LearnChatView
                    sessionId={isNew ? undefined : id}
                    courseId={courseId}
                    lessonId={lessonId}
                />
            )}
        </View>
    );
}
