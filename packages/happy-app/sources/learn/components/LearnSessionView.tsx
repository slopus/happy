import * as React from 'react';
import { Text, View, Pressable, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { ResizableDivider } from '@/components/ResizableDivider';
import { useSidebarCollapse } from '@/components/SidebarNavigator';
import { LearnChatView } from './LearnChatView';
import { VideoPlayer, LessonBlocks, extractBlocks } from './LearnContentPanel';
import type { VideoPlayerHandle } from './LearnContentPanel';
import { RightPanelTabs } from './RightPanelTabs';
import { FlashcardReview } from './FlashcardReview';
import { CardGridReview } from './CardGridReview';
import { learnStorage, useLearnActiveLesson, useLearnDesktopMode } from '../learnStorage';
import { learnApi } from '../learnApi';
import type { ChatSession } from '../learnTypes';

// Course color palette (shared with LearnMainView)
const COURSE_COLORS = [
    '#4CAF50', '#2196F3', '#FF9800', '#9C27B0',
    '#E91E63', '#00BCD4', '#FF5722', '#607D8B',
];

function getCourseColor(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = title.charCodeAt(i) + ((hash << 5) - hash);
    }
    return COURSE_COLORS[Math.abs(hash) % COURSE_COLORS.length];
}

const FOCUS_VIDEO_KEY = 'learn_focus_video_height';
const FOCUS_VIDEO_MIN = 150;
const FOCUS_VIDEO_MAX = 600;
const FOCUS_VIDEO_DEFAULT = 450;

// Browse mode: right panel width (video + tabs)
const BROWSE_RIGHT_KEY = 'learn_browse_right_width';
const BROWSE_RIGHT_MIN = 300;
const BROWSE_RIGHT_MAX = 800;
const BROWSE_RIGHT_DEFAULT = 500;

// Browse mode: video height ratio within right panel
const BROWSE_VIDEO_KEY = 'learn_browse_video_height';
const BROWSE_VIDEO_MIN = 150;
const BROWSE_VIDEO_MAX = 500;
const BROWSE_VIDEO_DEFAULT = 320;

// Review mode: left panel width (flashcards)
const REVIEW_LEFT_KEY = 'learn_review_left_width';
const REVIEW_LEFT_MIN = 300;
const REVIEW_LEFT_MAX = 800;
const REVIEW_LEFT_DEFAULT = 500;

// Study mode: chat width
const STUDY_CHAT_KEY = 'learn_study_chat_width';
const STUDY_CHAT_MIN = 250;
const STUDY_CHAT_MAX = 700;
const STUDY_CHAT_DEFAULT = 400;

// Review mode: compact video height
const REVIEW_VIDEO_KEY = 'learn_review_video_height';
const REVIEW_VIDEO_MIN = 100;
const REVIEW_VIDEO_MAX = 700;
const REVIEW_VIDEO_DEFAULT = 200;

function loadVideoHeight(): number {
    if (Platform.OS !== 'web') return FOCUS_VIDEO_DEFAULT;
    try {
        const v = localStorage.getItem(FOCUS_VIDEO_KEY);
        if (v) return parseInt(v, 10);
    } catch {}
    return FOCUS_VIDEO_DEFAULT;
}

function saveVideoHeight(h: number) {
    if (Platform.OS !== 'web') return;
    try { localStorage.setItem(FOCUS_VIDEO_KEY, String(h)); } catch {}
}

function loadDimension(key: string, def: number): number {
    if (Platform.OS !== 'web') return def;
    try { const v = localStorage.getItem(key); if (v) return parseInt(v, 10); } catch {}
    return def;
}

function saveDimension(key: string, val: number) {
    if (Platform.OS !== 'web') return;
    try { localStorage.setItem(key, String(val)); } catch {}
}

interface LearnSessionViewProps {
    sessionId: string;
    session?: ChatSession;
    initialLessonId?: string;
}

export const LearnSessionView = React.memo(({ sessionId, session, initialLessonId }: LearnSessionViewProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const isTablet = useIsTablet();
    const headerHeight = useHeaderHeight();
    const useSplitMode = Platform.OS === 'web' && isTablet;
    const activeLesson = useLearnActiveLesson();
    const desktopMode = useLearnDesktopMode();
    const sidebar = useSidebarCollapse();

    const [videoHeight, setVideoHeight] = React.useState(loadVideoHeight);

    // Browse mode dimensions
    const [browseRightWidth, setBrowseRightWidth] = React.useState(() => loadDimension(BROWSE_RIGHT_KEY, BROWSE_RIGHT_DEFAULT));
    const [browseVideoHeight, setBrowseVideoHeight] = React.useState(() => loadDimension(BROWSE_VIDEO_KEY, BROWSE_VIDEO_DEFAULT));

    // Study mode dimensions
    const [studyChatWidth, setStudyChatWidth] = React.useState(() => loadDimension(STUDY_CHAT_KEY, STUDY_CHAT_DEFAULT));

    // Review mode dimensions
    const [reviewLeftWidth, setReviewLeftWidth] = React.useState(() => loadDimension(REVIEW_LEFT_KEY, REVIEW_LEFT_DEFAULT));
    const [reviewVideoHeight, setReviewVideoHeight] = React.useState(() => loadDimension(REVIEW_VIDEO_KEY, REVIEW_VIDEO_DEFAULT));
    const [completing, setCompleting] = React.useState(false);
    const [mobileVideoOpen, setMobileVideoOpen] = React.useState(() => {
        // If there's a pending seekTo, start with video open to avoid layout shift
        if (!isTablet && Platform.OS === 'web') {
            return !!learnStorage.getState().pendingSeekTo;
        }
        return false;
    });
    const [mobileTocOpen, setMobileTocOpen] = React.useState(false);       // Transcript panel
    const [mobileNavOpen, setMobileNavOpen] = React.useState(false);       // Course lesson navigation
    const [keyboardHeight, setKeyboardHeight] = React.useState(0);
    const videoPlayerRef = React.useRef<VideoPlayerHandle>(null);
    const videoContainerRef = React.useRef<View>(null);
    const seekTo = React.useCallback((seconds: number) => {
        videoPlayerRef.current?.seekTo(seconds);
    }, []);

    // Auto-open video on phone when lesson has video
    React.useEffect(() => {
        if (!isTablet && activeLesson?.videoUrl) {
            setMobileVideoOpen(true);
        }
    }, [activeLesson?.id]);

    // Seek to pending timestamp (set by flashcard swipe-up via store)
    React.useEffect(() => {
        const pending = learnStorage.getState().pendingSeekTo;
        if (!pending || !activeLesson?.videoUrl) return;

        // Consume the pending seek
        learnStorage.getState().setPendingSeekTo(null);

        // Ensure video is visible on phone
        if (!isTablet) setMobileVideoOpen(true);

        let attempts = 0;
        const trySeek = () => {
            if (videoPlayerRef.current) {
                videoPlayerRef.current.seekTo(pending);
            } else if (attempts < 30) {
                attempts++;
                setTimeout(trySeek, 200);
            }
        };
        // Delay to allow video player to mount
        setTimeout(trySeek, 300);
    }, [activeLesson?.videoUrl, isTablet]);

    // Swipe-up on video to hide it (phone only)
    React.useEffect(() => {
        if (Platform.OS !== 'web' || isTablet) return;
        const el = videoContainerRef.current as unknown as HTMLElement | null;
        if (!el) return;
        let startY = 0;
        let startX = 0;
        const handleTouchStart = (e: TouchEvent) => {
            startY = e.touches[0].clientY;
            startX = e.touches[0].clientX;
        };
        const handleTouchEnd = (e: TouchEvent) => {
            const dy = startY - e.changedTouches[0].clientY; // positive = swipe up
            const dx = Math.abs(e.changedTouches[0].clientX - startX);
            if (dy > 50 && dx < dy * 0.7) {
                setMobileVideoOpen(false);
            }
        };
        el.addEventListener('touchstart', handleTouchStart, { passive: true });
        el.addEventListener('touchend', handleTouchEnd, { passive: true });
        return () => {
            el.removeEventListener('touchstart', handleTouchStart);
            el.removeEventListener('touchend', handleTouchEnd);
        };
    }, [isTablet, mobileVideoOpen]);

    // Detect keyboard on mobile web via visualViewport
    React.useEffect(() => {
        if (Platform.OS !== 'web' || isTablet) return;
        const vv = (window as any).visualViewport;
        if (!vv) return;
        // Use window.innerHeight as stable baseline (not affected by address bar)
        const baseHeight = window.innerHeight;
        let rafId = 0;
        const handleResize = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const diff = baseHeight - vv.height;
                const kbH = diff > 150 ? diff : 0;
                setKeyboardHeight(kbH);
                // Keep body scrolled to top to prevent iOS Safari viewport shift
                if (kbH > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
            });
        };
        vv.addEventListener('resize', handleResize);
        return () => {
            vv.removeEventListener('resize', handleResize);
            cancelAnimationFrame(rafId);
        };
    }, [isTablet]);

    // Web swipe-down gesture to close nav/transcript panels (only when panels are open)
    React.useEffect(() => {
        if (Platform.OS !== 'web' || isTablet) return;
        if (!mobileNavOpen && !mobileTocOpen) return; // Don't attach when panels are closed
        let startY = 0;
        let startX = 0;
        let swiping = false;
        const handleTouchStart = (e: TouchEvent) => {
            const t = e.touches[0];
            startY = t.clientY;
            startX = t.clientX;
            swiping = true;
        };
        const handleTouchEnd = (e: TouchEvent) => {
            if (!swiping) return;
            swiping = false;
            const t = e.changedTouches[0];
            const dy = t.clientY - startY;
            const dx = Math.abs(t.clientX - startX);
            // Swipe down > 60px, mostly vertical
            if (dy > 60 && dx < dy * 0.6) {
                if (mobileNavOpen) setMobileNavOpen(false);
                if (mobileTocOpen) setMobileTocOpen(false);
            }
        };
        window.addEventListener('touchstart', handleTouchStart, { passive: true });
        window.addEventListener('touchend', handleTouchEnd, { passive: true });
        return () => {
            window.removeEventListener('touchstart', handleTouchStart);
            window.removeEventListener('touchend', handleTouchEnd);
        };
    }, [isTablet, mobileNavOpen, mobileTocOpen]);

    // Note: desktopMode is persisted in localStorage, no reset on unmount
    // so lesson navigation preserves the current mode

    // Load lesson on mount: prefer initialLessonId, then session context, fallback to first lesson
    React.useEffect(() => {
        // Determine which lesson to load
        const contextLessonId = session?.context?.startsWith('lesson:')
            ? session.context.slice(7)
            : undefined;
        const targetLessonId = initialLessonId || contextLessonId;

        if (targetLessonId) {
            if (activeLesson?.id === targetLessonId) return;
            learnApi.getLesson(targetLessonId).then((lessonRes) => {
                learnStorage.getState().setActiveLesson(lessonRes.lesson);
            }).catch(console.error);
        } else if (session?.courseId && !activeLesson) {
            learnApi.getCourse(session.courseId).then((res) => {
                const firstModule = res.course.modules?.[0];
                const firstLesson = firstModule?.lessons?.[0];
                if (firstLesson) {
                    learnApi.getLesson(firstLesson.id).then((lessonRes) => {
                        learnStorage.getState().setActiveLesson(lessonRes.lesson);
                    }).catch(console.error);
                }
            }).catch(console.error);
        }
    }, [initialLessonId, session?.courseId, session?.context]);


    const handleVideoResize = React.useCallback((delta: number) => {
        setVideoHeight(prev => Math.min(Math.max(prev + delta, FOCUS_VIDEO_MIN), FOCUS_VIDEO_MAX));
    }, []);

    const handleVideoResizeEnd = React.useCallback(() => {
        setVideoHeight(prev => { saveVideoHeight(prev); return prev; });
    }, []);


    // Browse mode right panel
    const handleBrowseRightResize = React.useCallback((delta: number) => {
        setBrowseRightWidth(prev => Math.min(Math.max(prev - delta, BROWSE_RIGHT_MIN), BROWSE_RIGHT_MAX));
    }, []);
    const handleBrowseRightResizeEnd = React.useCallback(() => {
        setBrowseRightWidth(prev => { saveDimension(BROWSE_RIGHT_KEY, prev); return prev; });
    }, []);
    const handleBrowseVideoResize = React.useCallback((delta: number) => {
        setBrowseVideoHeight(prev => Math.min(Math.max(prev + delta, BROWSE_VIDEO_MIN), BROWSE_VIDEO_MAX));
    }, []);
    const handleBrowseVideoResizeEnd = React.useCallback(() => {
        setBrowseVideoHeight(prev => { saveDimension(BROWSE_VIDEO_KEY, prev); return prev; });
    }, []);

    // Study mode chat width
    const handleStudyChatResize = React.useCallback((delta: number) => {
        setStudyChatWidth(prev => Math.min(Math.max(prev + delta, STUDY_CHAT_MIN), STUDY_CHAT_MAX));
    }, []);
    const handleStudyChatResizeEnd = React.useCallback(() => {
        setStudyChatWidth(prev => { saveDimension(STUDY_CHAT_KEY, prev); return prev; });
    }, []);

    // Review mode left panel
    const handleReviewLeftResize = React.useCallback((delta: number) => {
        setReviewLeftWidth(prev => Math.min(Math.max(prev + delta, REVIEW_LEFT_MIN), REVIEW_LEFT_MAX));
    }, []);
    const handleReviewLeftResizeEnd = React.useCallback(() => {
        setReviewLeftWidth(prev => { saveDimension(REVIEW_LEFT_KEY, prev); return prev; });
    }, []);
    const handleReviewVideoResize = React.useCallback((delta: number) => {
        setReviewVideoHeight(prev => Math.min(Math.max(prev + delta, REVIEW_VIDEO_MIN), REVIEW_VIDEO_MAX));
    }, []);
    const handleReviewVideoResizeEnd = React.useCallback(() => {
        setReviewVideoHeight(prev => { saveDimension(REVIEW_VIDEO_KEY, prev); return prev; });
    }, []);

    const setDesktopMode = React.useCallback((mode: 'browse' | 'study' | 'review') => {
        learnStorage.getState().setDesktopMode(mode);
    }, []);

    // Cmd+1/2/3 to switch desktop modes
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !useSplitMode) return;
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const modes: Record<string, 'browse' | 'study' | 'review'> = { '1': 'browse', '2': 'study', '3': 'review' };
            const mode = modes[e.key];
            if (mode) {
                e.preventDefault();
                setDesktopMode(mode);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [useSplitMode, setDesktopMode]);

    const navigateToLesson = React.useCallback(async (lessonId: string) => {
        try {
            // Load new lesson data
            const res = await learnApi.getLesson(lessonId);
            learnStorage.getState().setActiveLesson(res.lesson);

            // Navigate to existing session for this lesson or create new
            const lessonContext = `lesson:${lessonId}`;
            const sessions = learnStorage.getState().chatSessions;
            const existing = sessions.find((s) => s.context === lessonContext && !s.archived);
            if (existing) {
                router.replace(`/learn/chat/${existing.id}` as any);
            } else {
                const courseId = res.lesson?.module?.courseId;
                router.replace(`/learn/chat/new?lessonId=${lessonId}${courseId ? `&courseId=${courseId}` : ''}` as any);
            }
        } catch (e) {
            console.error(e);
        }
    }, [router]);

    const siblings = activeLesson?.module?.lessons || [];
    const isCompleted = activeLesson?.lessonState?.some((s) => s.status === 'COMPLETED') ?? false;

    const doComplete = React.useCallback(async () => {
        if (completing || !activeLesson) return;
        setCompleting(true);
        try {
            await learnApi.completeLesson(activeLesson.id);
            learnStorage.getState().setActiveLesson({
                ...activeLesson,
                lessonState: [{ status: 'COMPLETED', completedAt: new Date().toISOString() }],
            });
            const { courses } = await learnApi.getCourses();
            learnStorage.getState().setCourses(courses);
        } catch (e) {
            console.error(e);
        } finally {
            setCompleting(false);
        }
    }, [activeLesson, completing]);

    const doUncomplete = React.useCallback(async () => {
        if (completing || !activeLesson) return;
        setCompleting(true);
        try {
            await learnApi.uncompleteLesson(activeLesson.id);
            learnStorage.getState().setActiveLesson({
                ...activeLesson,
                lessonState: [],
            });
            const { courses } = await learnApi.getCourses();
            learnStorage.getState().setCourses(courses);
        } catch (e) {
            console.error(e);
        } finally {
            setCompleting(false);
        }
    }, [activeLesson, completing]);

    // Toggle complete: complete with confirmation, uncomplete with confirmation
    const handleComplete = React.useCallback(async () => {
        if (completing || !activeLesson) return;
        if (!isTablet && Platform.OS === 'web') {
            if (isCompleted) {
                const confirmed = window.confirm(`Mark "${activeLesson.title}" as incomplete?`);
                if (!confirmed) return;
                await doUncomplete();
            } else {
                const confirmed = window.confirm(`Complete "${activeLesson.title}"?`);
                if (!confirmed) return;
                await doComplete();
            }
        } else {
            if (isCompleted) {
                await doUncomplete();
            } else {
                await doComplete();
            }
        }
    }, [completing, activeLesson, isCompleted, isTablet, doComplete, doUncomplete]);

    const toggleBtn = {
        width: 32, height: 32,
        borderRadius: 8,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    };

    // Course-themed color for complete button
    const courseColor = session?.courseTitle ? getCourseColor(session.courseTitle) : theme.colors.accent;

    // Lesson navigation (used in both header and phone mode)
    const currentIdx = siblings.findIndex((l) => l.id === activeLesson?.id);
    const prevLessonNav = currentIdx > 0 ? siblings[currentIdx - 1] : null;
    const nextLessonNav = currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

    // Desktop header with breathing room (6px top padding + 52px content)
    const desktopHeaderHeight = useSplitMode ? 58 : headerHeight;

    // Normal mode header
    const header = (
        <View style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
            zIndex: 1000,
            backgroundColor: theme.colors.groupped.background,
            borderBottomWidth: 0.5,
            borderBottomColor: theme.colors.divider,
            paddingTop: useSplitMode ? 6 : 0,
        }}>
            <View style={{
                height: desktopHeaderHeight,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: useSplitMode ? 20 : 12,
                gap: 4,
            }}>
                {!isTablet ? (
                    <>
                        {/* Phone header: [←] [title...] [menu] [TOC] | [video] [complete] */}
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={10}
                            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                        </Pressable>
                        {/* Session title — left aligned, takes remaining space */}
                        <Pressable
                            onPress={() => router.back()}
                            style={{ flex: 1, justifyContent: 'center', minWidth: 0 }}
                        >
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.text,
                                ...Typography.default('semiBold'),
                            }} numberOfLines={1}>
                                {session?.title || 'Новый чат'}
                            </Text>
                            {session?.courseTitle && (
                                <Text style={{
                                    fontSize: 10,
                                    color: theme.colors.textSecondary,
                                    marginTop: 1,
                                    ...Typography.default(),
                                }} numberOfLines={1}>
                                    {session.courseTitle}
                                </Text>
                            )}
                        </Pressable>
                        {/* Video toggle */}
                        {activeLesson?.videoUrl && (
                            <Pressable
                                onPress={() => setMobileVideoOpen(prev => !prev)}
                                style={toggleBtn}
                                hitSlop={4}
                            >
                                <Ionicons
                                    name={mobileVideoOpen ? 'videocam' : 'videocam-outline'}
                                    size={17}
                                    color={mobileVideoOpen ? theme.colors.text : theme.colors.textSecondary}
                                />
                            </Pressable>
                        )}
                        {/* Course navigation (lesson list) */}
                        {activeLesson && siblings.length > 1 && (
                            <Pressable
                                onPress={() => { setMobileNavOpen(prev => !prev); setMobileTocOpen(false); }}
                                style={toggleBtn}
                                hitSlop={4}
                            >
                                <Ionicons name="grid-outline" size={17} color={mobileNavOpen ? theme.colors.text : theme.colors.textSecondary} />
                            </Pressable>
                        )}
                        {/* Transcript toggle */}
                        {activeLesson && (
                            <Pressable
                                onPress={() => { setMobileTocOpen(prev => !prev); setMobileNavOpen(false); }}
                                style={toggleBtn}
                                hitSlop={4}
                            >
                                <Ionicons
                                    name="document-text-outline"
                                    size={17}
                                    color={mobileTocOpen ? theme.colors.text : theme.colors.textSecondary}
                                />
                            </Pressable>
                        )}
                        {/* Complete */}
                        {activeLesson && (
                            <Pressable
                                onPress={handleComplete}
                                disabled={completing}
                                style={toggleBtn}
                                hitSlop={4}
                            >
                                {completing ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons
                                        name={isCompleted ? 'checkmark-circle' : 'checkmark-circle-outline'}
                                        size={20}
                                        color={isCompleted ? '#4CAF50' : theme.colors.textSecondary}
                                    />
                                )}
                            </Pressable>
                        )}
                    </>
                ) : (
                    <>
                        {/* Desktop header: [☰ ← →] [session title] ... [Lesson · N/M] ... [✓ | modes] */}
                        {/* Left group: sidebar + arrows (fixed position) */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
                            {/* Sidebar toggle — all modes (browse when collapsed, study/review always) */}
                            {(desktopMode !== 'browse' || sidebar.collapsed) && (
                                <Pressable
                                    onPress={sidebar.toggle}
                                    style={({ hovered }: any) => [
                                        toggleBtn,
                                        hovered && { backgroundColor: theme.colors.text + '0A' },
                                        Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                                    ]}
                                    hitSlop={8}
                                >
                                    <Ionicons name="menu-outline" size={18} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                            {/* Lesson arrows — fixed position */}
                            {activeLesson && siblings.length > 1 && (
                                <>
                                    <Pressable
                                        onPress={prevLessonNav ? () => navigateToLesson(prevLessonNav.id) : undefined}
                                        disabled={!prevLessonNav}
                                        hitSlop={4}
                                        style={({ hovered }: any) => [
                                            toggleBtn,
                                            { opacity: prevLessonNav ? 1 : 0.3 },
                                            hovered && prevLessonNav && { backgroundColor: theme.colors.text + '0A' },
                                            Platform.OS === 'web' && prevLessonNav ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                                        ]}
                                    >
                                        <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    <Pressable
                                        onPress={nextLessonNav ? () => navigateToLesson(nextLessonNav.id) : undefined}
                                        disabled={!nextLessonNav}
                                        hitSlop={4}
                                        style={({ hovered }: any) => [
                                            toggleBtn,
                                            { opacity: nextLessonNav ? 1 : 0.3 },
                                            hovered && nextLessonNav && { backgroundColor: theme.colors.text + '0A' },
                                            Platform.OS === 'web' && nextLessonNav ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                                        ]}
                                    >
                                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </>
                            )}
                        </View>
                        {/* Left: course title (clickable → browse mode) */}
                        <Pressable
                            onPress={() => setDesktopMode('browse')}
                            style={({ hovered }: any) => ({
                                flex: 1, minWidth: 0, marginLeft: 4, paddingVertical: 2, paddingHorizontal: 4,
                                borderRadius: 6,
                                backgroundColor: hovered ? theme.colors.text + '06' : 'transparent',
                                ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {}),
                            })}
                        >
                            <Text style={{
                                fontSize: 12, color: theme.colors.textSecondary,
                                ...Typography.default('medium'),
                            }} numberOfLines={1}>
                                {activeLesson?.module?.course?.title || session?.courseTitle || session?.title || 'Новый чат'}
                            </Text>
                            {activeLesson?.module?.title && (
                                <Text style={{
                                    fontSize: 10, color: theme.colors.textSecondary, opacity: 0.5,
                                    ...Typography.default(),
                                }} numberOfLines={1}>
                                    {activeLesson.module.title}
                                </Text>
                            )}
                        </Pressable>
                        {/* Center: lesson title · N/M (no arrows — they're on the left now) */}
                        <View style={{ alignItems: 'center', maxWidth: 420 }}>
                            {activeLesson ? (
                                <Text style={{
                                    fontSize: 13, color: theme.colors.text,
                                    ...Typography.default('semiBold'),
                                }} numberOfLines={1}>
                                    {activeLesson.title}
                                    {siblings.length > 1 && (
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                                            {' '}· {currentIdx + 1}/{siblings.length}
                                        </Text>
                                    )}
                                </Text>
                            ) : (
                                <Text style={{
                                    fontSize: 13, color: theme.colors.text,
                                    ...Typography.default('semiBold'),
                                }} numberOfLines={1}>
                                    {session?.title || 'Новый чат'}
                                </Text>
                            )}
                        </View>
                        {/* Right: complete + mode switcher */}
                        <View style={{ flex: 1, flexDirection: 'row', gap: 2, alignItems: 'center', justifyContent: 'flex-end' }}>
                            {activeLesson && (
                                <Pressable
                                    onPress={handleComplete}
                                    style={({ hovered }: any) => [
                                        toggleBtn,
                                        hovered && { backgroundColor: theme.colors.text + '0A' },
                                        Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                                    ]}
                                    hitSlop={4}
                                    disabled={completing}
                                >
                                    {completing ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : (
                                        <Ionicons
                                            name={isCompleted ? 'checkmark-circle' : 'checkmark-circle-outline'}
                                            size={18}
                                            color={isCompleted ? '#4CAF50' : theme.colors.textSecondary}
                                        />
                                    )}
                                </Pressable>
                            )}
                            {useSplitMode && (
                                <>
                                    <View style={{ width: 1, height: 14, backgroundColor: theme.colors.divider, marginHorizontal: 3 }} />
                                    {([
                                        { key: 'browse' as const, icon: 'book-outline' as const },
                                        { key: 'study' as const, icon: 'school-outline' as const },
                                        { key: 'review' as const, icon: 'layers-outline' as const },
                                    ] as const).map((m) => {
                                        const isActive = desktopMode === m.key;
                                        return (
                                            <Pressable
                                                key={m.key}
                                                onPress={() => setDesktopMode(m.key)}
                                                style={({ hovered }: any) => [
                                                    toggleBtn,
                                                    isActive && { backgroundColor: theme.colors.text + '15' },
                                                    !isActive && hovered && { backgroundColor: theme.colors.text + '0A' },
                                                    Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                                                ]}
                                                hitSlop={4}
                                            >
                                                <Ionicons
                                                    name={m.icon}
                                                    size={17}
                                                    color={isActive ? theme.colors.text : theme.colors.textSecondary}
                                                />
                                            </Pressable>
                                        );
                                    })}
                                </>
                            )}
                        </View>
                    </>
                )}
            </View>
        </View>
    );

    const chatView = (
        <LearnChatView
            sessionId={sessionId === 'new' ? undefined : sessionId}
            courseId={session?.courseId || undefined}
            lessonId={activeLesson?.id || initialLessonId}
            onTimestampPress={seekTo}
            timestampColor={theme.colors.text}
            courseColor={courseColor}
        />
    );

    // ==========================================
    // DESKTOP MODE: BROWSE
    // ==========================================
    // Sidebar + Chat (center) + Right panel (Video top 50% + Tabs bottom 50%)
    if (useSplitMode && desktopMode === 'browse') {
        return (
            <View style={{ flex: 1 }}>
                {header}
                <View style={{ flex: 1, flexDirection: 'row', paddingTop: desktopHeaderHeight }}>
                    {/* Chat */}
                    <View style={{ flex: 1 }}>
                        {chatView}
                    </View>
                    {/* Right panel: Video + Tabs */}
                    {activeLesson && (
                        <>
                            <ResizableDivider
                                onResize={handleBrowseRightResize}
                                onResizeEnd={handleBrowseRightResizeEnd}
                            />
                            <View style={{
                                width: browseRightWidth,
                                borderLeftWidth: 0.5,
                                borderLeftColor: theme.colors.divider,
                                backgroundColor: theme.colors.groupped.background,
                            }}>
                                {/* Video top */}
                                {activeLesson.videoUrl ? (
                                    <>
                                        <View style={{ height: browseVideoHeight, backgroundColor: '#000' }}>
                                            <VideoPlayer key={activeLesson.videoUrl} ref={videoPlayerRef} url={activeLesson.videoUrl} fill courseColor={courseColor} />
                                        </View>
                                        <ResizableDivider
                                            direction="horizontal"
                                            onResize={handleBrowseVideoResize}
                                            onResizeEnd={handleBrowseVideoResizeEnd}
                                        />
                                    </>
                                ) : null}
                                {/* Tabs bottom */}
                                <RightPanelTabs
                                    onTimestampPress={seekTo}
                                    onNavigateToLesson={navigateToLesson}
                                    courseColor={courseColor}
                                />
                            </View>
                        </>
                    )}
                </View>
            </View>
        );
    }

    // ==========================================
    // DESKTOP MODE: STUDY
    // ==========================================
    // No sidebar, Chat 1/3 left, Video ~75% right top + Tabs ~25% right bottom
    if (useSplitMode && desktopMode === 'study') {
        return (
            <View style={{ flex: 1 }}>
                {header}
                <View style={{ flex: 1, flexDirection: 'row', paddingTop: desktopHeaderHeight }}>
                    {/* Left: Chat (resizable) */}
                    <View style={{ width: studyChatWidth }}>
                        {chatView}
                    </View>
                    <ResizableDivider onResize={handleStudyChatResize} onResizeEnd={handleStudyChatResizeEnd} />
                    {/* Right: Video + Tabs */}
                    <View style={{ flex: 1, borderLeftWidth: 0.5, borderLeftColor: theme.colors.divider }}>
                        {/* Video ~75% */}
                        {activeLesson?.videoUrl ? (
                            <>
                                <View style={{ height: videoHeight, backgroundColor: '#000' }}>
                                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                                        <View style={{ height: '100%', aspectRatio: 16 / 9, maxWidth: '100%' }}>
                                            <VideoPlayer key={activeLesson.videoUrl} ref={videoPlayerRef} url={activeLesson.videoUrl} fill courseColor={courseColor} />
                                        </View>
                                    </View>
                                </View>
                                <ResizableDivider
                                    direction="horizontal"
                                    onResize={handleVideoResize}
                                    onResizeEnd={handleVideoResizeEnd}
                                />
                            </>
                        ) : null}
                        {/* Tabs ~25% */}
                        <RightPanelTabs
                            onTimestampPress={seekTo}
                            onNavigateToLesson={navigateToLesson}
                            courseColor={courseColor}
                        />
                    </View>
                </View>
            </View>
        );
    }

    // ==========================================
    // DESKTOP MODE: REVIEW
    // ==========================================
    // No sidebar, CardGrid left | Video + Chat right (resizable divider between)
    if (useSplitMode && desktopMode === 'review') {
        return (
            <View style={{ flex: 1 }}>
                {header}
                <View style={{ flex: 1, flexDirection: 'row', paddingTop: desktopHeaderHeight }}>
                    {/* Left: Card Grid */}
                    <View style={{ width: reviewLeftWidth }}>
                        <CardGridReview onTimestampPress={seekTo} />
                    </View>
                    <ResizableDivider
                        onResize={handleReviewLeftResize}
                        onResizeEnd={handleReviewLeftResizeEnd}
                    />
                    {/* Right: Video + Chat */}
                    <View style={{ flex: 1, borderLeftWidth: 0.5, borderLeftColor: theme.colors.divider }}>
                        {/* Video */}
                        {activeLesson?.videoUrl ? (
                            <>
                                <View style={{ height: reviewVideoHeight, backgroundColor: '#000' }}>
                                    <VideoPlayer key={activeLesson.videoUrl} ref={videoPlayerRef} url={activeLesson.videoUrl} fill courseColor={courseColor} />
                                </View>
                                <ResizableDivider
                                    direction="horizontal"
                                    onResize={handleReviewVideoResize}
                                    onResizeEnd={handleReviewVideoResizeEnd}
                                />
                            </>
                        ) : null}
                        {/* Chat */}
                        <View style={{ flex: 1 }}>
                            {chatView}
                        </View>
                    </View>
                </View>
            </View>
        );
    }

    // ==========================================
    // PHONE MODE
    // ==========================================
    const hasVideo = !!activeLesson?.videoUrl;
    const kbOpen = keyboardHeight > 0;

    return (
        <View style={[
            { flex: 1 },
            kbOpen ? {
                position: 'fixed' as any,
                top: 0, left: 0, right: 0,
                bottom: keyboardHeight,
                zIndex: 9999,
                overflow: 'hidden' as any,
            } : {},
        ]}>
            {!kbOpen && header}
            <View style={{ flex: 1, paddingTop: kbOpen ? 0 : headerHeight }}>
                {/* Video — hide when keyboard is open */}
                {hasVideo && mobileVideoOpen && !kbOpen && (
                    <View ref={videoContainerRef} style={{ backgroundColor: '#000' }}>
                        <VideoPlayer key={activeLesson.videoUrl!} ref={videoPlayerRef} url={activeLesson.videoUrl!} courseColor={courseColor} />
                    </View>
                )}
                {/* Lesson nav bar — hide when keyboard open */}
                {activeLesson && !kbOpen && (
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderBottomWidth: 0.5,
                        borderBottomColor: theme.colors.divider,
                        gap: 4,
                    }}>
                        <Pressable
                            onPress={prevLessonNav ? () => navigateToLesson(prevLessonNav.id) : undefined}
                            disabled={!prevLessonNav}
                            hitSlop={8}
                            style={{ opacity: prevLessonNav ? 1 : 0.3 }}
                        >
                            <Ionicons name="chevron-back" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                        <View style={{ flex: 1, alignItems: 'center' }}>
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.text,
                                textAlign: 'center',
                                ...Typography.default('semiBold'),
                            }} numberOfLines={1}>
                                {activeLesson.title}
                            </Text>
                            {siblings.length > 1 && (
                                <Text style={{
                                    fontSize: 10,
                                    color: theme.colors.textSecondary,
                                    ...Typography.default(),
                                }}>
                                    {currentIdx + 1} / {siblings.length}
                                </Text>
                            )}
                        </View>
                        <Pressable
                            onPress={nextLessonNav ? () => navigateToLesson(nextLessonNav.id) : undefined}
                            disabled={!nextLessonNav}
                            hitSlop={8}
                            style={{ opacity: nextLessonNav ? 1 : 0.3 }}
                        >
                            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                )}
                {/* Course navigation panel */}
                {!kbOpen && mobileNavOpen && activeLesson ? (
                    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
                        {siblings.map((lesson, idx) => {
                            const isCurrent = lesson.id === activeLesson?.id;
                            const lessonDone = (lesson as any).lessonState?.some((s: any) => s.status === 'COMPLETED') ?? false;
                            return (
                                <Pressable
                                    key={lesson.id}
                                    onPress={() => {
                                        navigateToLesson(lesson.id);
                                        setMobileNavOpen(false);
                                    }}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 10,
                                        paddingHorizontal: 16,
                                        paddingVertical: 12,
                                        backgroundColor: isCurrent ? 'rgba(255,255,255,0.08)' : 'transparent',
                                        borderBottomWidth: 0.5,
                                        borderBottomColor: theme.colors.divider,
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.textSecondary,
                                        width: 20,
                                        textAlign: 'center',
                                        ...Typography.default(),
                                    }}>
                                        {idx + 1}
                                    </Text>
                                    <Ionicons
                                        name={lessonDone ? 'checkmark-circle' : isCurrent ? 'radio-button-on' : 'ellipse-outline'}
                                        size={16}
                                        color={lessonDone ? '#4CAF50' : isCurrent ? theme.colors.text : theme.colors.textSecondary}
                                    />
                                    <Text style={{
                                        flex: 1,
                                        fontSize: 14,
                                        color: isCurrent ? theme.colors.text : theme.colors.textSecondary,
                                        ...Typography.default(isCurrent ? 'semiBold' : 'regular'),
                                    }} numberOfLines={2}>
                                        {lesson.title}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                ) : !kbOpen && mobileTocOpen && activeLesson ? (
                    /* Transcript panel */
                    <View style={{ flex: 1 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 16,
                            paddingVertical: 10,
                            borderBottomWidth: 0.5,
                            borderBottomColor: theme.colors.divider,
                        }}>
                            <Ionicons name="document-text-outline" size={16} color={theme.colors.textSecondary} />
                            <Text style={{
                                flex: 1,
                                fontSize: 14,
                                color: theme.colors.text,
                                marginLeft: 8,
                                ...Typography.default('semiBold'),
                            }}>
                                Транскрипт
                            </Text>
                            <Pressable onPress={() => setMobileTocOpen(false)} hitSlop={8}>
                                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                        {activeLesson?.content && extractBlocks(activeLesson.content) ? (
                            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                                <LessonBlocks content={activeLesson.content} theme={theme} courseColor={courseColor} />
                            </ScrollView>
                        ) : (
                            <View style={{
                                flex: 1,
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 32,
                            }}>
                                <Ionicons name="hourglass-outline" size={36} color={theme.colors.textSecondary} style={{ opacity: 0.4 }} />
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    textAlign: 'center',
                                    marginTop: 12,
                                    lineHeight: 20,
                                    opacity: 0.6,
                                    ...Typography.default(),
                                }}>
                                    Транскрипт со скриншотами{'\n'}появится после обработки видео
                                </Text>
                            </View>
                        )}
                    </View>
                ) : (
                    /* Chat */
                    <View style={{ flex: 1 }}>
                        <LearnChatView
                            sessionId={sessionId === 'new' ? undefined : sessionId}
                            courseId={session?.courseId || undefined}
                            lessonId={activeLesson?.id || initialLessonId}
                            onTimestampPress={seekTo}
                            timestampColor={theme.colors.text}
                            courseColor={courseColor}
                        />
                    </View>
                )}
            </View>
        </View>
    );
});
