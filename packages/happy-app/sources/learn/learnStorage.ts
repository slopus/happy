import { create } from 'zustand';
import type {
    LearnUser, Course, FlashCard, CardStats,
    ChatSession, ChatMessage, DailyProgress, UserStats,
    LessonContent,
} from './learnTypes';

interface LearnState {
    // Auth
    user: LearnUser | null;

    // Courses
    courses: Course[];

    // Navigation
    activeSessionId: string | null;
    activeLesson: LessonContent | null;
    contentPanelOpen: boolean;
    focusMode: boolean;
    desktopMode: 'browse' | 'study' | 'review';
    rightPanelTab: 'transcript' | 'cards' | 'lessons';
    collapsedCourses: Set<string>;
    courseOrder: string[];

    // Flashcards
    decks: Array<{ lessonId: string; lessonTitle: string; courseId: string | null; courseTitle: string | null; total: number; due: number; new: number }>;
    dueCards: FlashCard[];
    cardStats: CardStats | null;

    // Chat (all sessions: active + archived in one array)
    chatSessions: ChatSession[];
    chatMessages: Record<string, ChatMessage[]>; // sessionId -> messages

    // Progress
    today: (DailyProgress & {
        nextLesson: { id: string; title: string; courseTitle: string } | null;
        hasStudiedToday: boolean;
    }) | null;
    stats: UserStats | null;

    // Video seek (set by flashcard swipe-up, consumed by session view)
    pendingSeekTo: number | null;

    // Streaming
    streamingContent: string | null;
    streamingSessionId: string | null;

    // Status
    isLoaded: boolean;
    apiStatus: 'disconnected' | 'connected' | 'error';

    // Actions
    setUser: (user: LearnUser | null) => void;
    setCourses: (courses: Course[]) => void;
    setActiveSessionId: (id: string | null) => void;
    setActiveLesson: (lesson: LessonContent | null) => void;
    setContentPanelOpen: (open: boolean) => void;
    setFocusMode: (focus: boolean) => void;
    setDesktopMode: (mode: LearnState['desktopMode']) => void;
    setRightPanelTab: (tab: LearnState['rightPanelTab']) => void;
    toggleCourseCollapsed: (courseTitle: string) => void;
    setCourseOrder: (order: string[]) => void;
    setDecks: (decks: LearnState['decks']) => void;
    setDueCards: (cards: FlashCard[]) => void;
    removeCard: (cardId: string) => void;
    setCardStats: (stats: CardStats) => void;
    setChatSessions: (sessions: ChatSession[]) => void;
    updateSession: (sessionId: string, update: Partial<ChatSession>) => void;
    removeSession: (sessionId: string) => void;
    removeSessionsByCourse: (courseId: string) => void;
    setChatMessages: (sessionId: string, messages: ChatMessage[]) => void;
    addChatMessage: (sessionId: string, message: ChatMessage) => void;
    prependChatMessages: (sessionId: string, messages: ChatMessage[]) => void;
    setToday: (today: LearnState['today']) => void;
    setStats: (stats: UserStats) => void;
    setPendingSeekTo: (seconds: number | null) => void;
    setStreamingContent: (content: string | null) => void;
    setStreamingSessionId: (id: string | null) => void;
    setLoaded: (loaded: boolean) => void;
    setApiStatus: (status: LearnState['apiStatus']) => void;
    reset: () => void;
}

const initialState = {
    user: null,
    courses: [],
    activeSessionId: null,
    activeLesson: null,
    contentPanelOpen: true,
    focusMode: false,
    desktopMode: (typeof localStorage !== 'undefined' ? (localStorage.getItem('learn_desktop_mode') as any) : null) || 'browse' as const,
    rightPanelTab: (typeof localStorage !== 'undefined' ? (localStorage.getItem('learn_right_panel_tab') as any) : null) || 'transcript' as const,
    collapsedCourses: new Set<string>(),
    courseOrder: [] as string[],
    decks: [],
    dueCards: [],
    cardStats: null,
    chatSessions: [],
    chatMessages: {},
    pendingSeekTo: null,
    streamingContent: null,
    streamingSessionId: null,
    today: null,
    stats: null,
    isLoaded: false,
    apiStatus: 'disconnected' as const,
};

export const learnStorage = create<LearnState>()((set) => ({
    ...initialState,

    setUser: (user) => set({ user }),
    setCourses: (courses) => set({ courses }),
    setActiveSessionId: (id) => set({ activeSessionId: id }),
    setActiveLesson: (lesson) => set({ activeLesson: lesson }),
    setContentPanelOpen: (open) => set({ contentPanelOpen: open }),
    setFocusMode: (focus) => set({ focusMode: focus }),
    setDesktopMode: (mode) => {
        set({ desktopMode: mode, focusMode: mode === 'study' || mode === 'review' });
        if (typeof localStorage !== 'undefined') {
            try { localStorage.setItem('learn_desktop_mode', mode); } catch {}
        }
    },
    setRightPanelTab: (tab) => {
        set({ rightPanelTab: tab });
        if (typeof localStorage !== 'undefined') {
            try { localStorage.setItem('learn_right_panel_tab', tab); } catch {}
        }
    },
    toggleCourseCollapsed: (courseTitle) => set((s) => {
        const next = new Set(s.collapsedCourses);
        if (next.has(courseTitle)) {
            next.delete(courseTitle);
        } else {
            next.add(courseTitle);
        }
        return { collapsedCourses: next };
    }),
    setCourseOrder: (order) => {
        set({ courseOrder: order });
        if (typeof localStorage !== 'undefined') {
            try { localStorage.setItem('learn_course_order', JSON.stringify(order)); } catch {}
        }
    },
    setDecks: (decks) => set({ decks }),
    setDueCards: (cards) => set({ dueCards: cards }),
    removeCard: (cardId) => set((s) => ({
        dueCards: s.dueCards.filter((c) => c.id !== cardId),
    })),
    setCardStats: (stats) => set({ cardStats: stats }),
    setChatSessions: (sessions) => set({ chatSessions: sessions }),
    updateSession: (sessionId, update) => set((s) => ({
        chatSessions: s.chatSessions.map((ss) =>
            ss.id === sessionId ? { ...ss, ...update } : ss
        ),
    })),
    removeSession: (sessionId) => set((s) => ({
        chatSessions: s.chatSessions.filter((ss) => ss.id !== sessionId),
    })),
    removeSessionsByCourse: (courseId) => set((s) => ({
        chatSessions: s.chatSessions.filter((ss) => ss.courseId !== courseId),
    })),
    setChatMessages: (sessionId, messages) => set((s) => ({
        chatMessages: { ...s.chatMessages, [sessionId]: messages },
    })),
    addChatMessage: (sessionId, message) => set((s) => ({
        chatMessages: {
            ...s.chatMessages,
            [sessionId]: [...(s.chatMessages[sessionId] || []), message],
        },
    })),
    prependChatMessages: (sessionId, messages) => set((s) => ({
        chatMessages: {
            ...s.chatMessages,
            [sessionId]: [...messages, ...(s.chatMessages[sessionId] || [])],
        },
    })),
    setPendingSeekTo: (seconds) => set({ pendingSeekTo: seconds }),
    setStreamingContent: (content) => set({ streamingContent: content }),
    setStreamingSessionId: (id) => set({ streamingSessionId: id }),
    setToday: (today) => set({ today }),
    setStats: (stats) => set({ stats }),
    setLoaded: (loaded) => set({ isLoaded: loaded }),
    setApiStatus: (status) => set({ apiStatus: status }),
    reset: () => set(initialState),
}));

// ============================================
// HOOKS
// ============================================

const EMPTY_MESSAGES: ChatMessage[] = [];

export function useLearnUser() {
    return learnStorage((s) => s.user);
}

export function useLearnCourses() {
    return learnStorage((s) => s.courses);
}

export function useLearnActiveSessionId() {
    return learnStorage((s) => s.activeSessionId);
}

export function useLearnActiveLesson() {
    return learnStorage((s) => s.activeLesson);
}

export function useLearnContentPanelOpen() {
    return learnStorage((s) => s.contentPanelOpen);
}

export function useLearnFocusMode() {
    return learnStorage((s) => s.focusMode);
}

export function useLearnDesktopMode() {
    return learnStorage((s) => s.desktopMode);
}

export function useLearnRightPanelTab() {
    return learnStorage((s) => s.rightPanelTab);
}

export function useLearnCollapsedCourses() {
    return learnStorage((s) => s.collapsedCourses);
}

export function useLearnCourseOrder() {
    return learnStorage((s) => s.courseOrder);
}

export function useLearnDecks() {
    return learnStorage((s) => s.decks);
}

export function useLearnDueCards() {
    return learnStorage((s) => s.dueCards);
}

export function useLearnCardStats() {
    return learnStorage((s) => s.cardStats);
}

export function useLearnChatSessions() {
    return learnStorage((s) => s.chatSessions);
}

export function useLearnChatMessages(sessionId: string) {
    return learnStorage((s) => s.chatMessages[sessionId] || EMPTY_MESSAGES);
}

export function useLearnToday() {
    return learnStorage((s) => s.today);
}

export function useLearnStats() {
    return learnStorage((s) => s.stats);
}

export function useLearnStreamingContent() {
    return learnStorage((s) => s.streamingContent);
}

export function useLearnStreamingSessionId() {
    return learnStorage((s) => s.streamingSessionId);
}

export function useLearnLoaded() {
    return learnStorage((s) => s.isLoaded);
}

export function useLearnApiStatus() {
    return learnStorage((s) => s.apiStatus);
}
