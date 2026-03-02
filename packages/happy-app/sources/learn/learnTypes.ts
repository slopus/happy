// ============================================
// AUTH
// ============================================

export interface LearnUser {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    role: 'ADMIN' | 'LEARNER';
    settings: Record<string, any> | null;
    timezone: string;
}

// ============================================
// COURSES & CONTENT
// ============================================

export type LessonType = 'TEXT' | 'VIDEO' | 'MIXED' | 'PRACTICE' | 'INTERACTIVE' | 'QUIZ';

export interface Course {
    id: string;
    title: string;
    description: string | null;
    thumbnail: string | null;
    tags: string[];
    color: string | null;
    published: boolean;
    sortOrder: number;
    modules?: CourseModule[];
    progress?: CourseProgress[] | CourseProgress;
}

export interface CourseModule {
    id: string;
    courseId: string;
    title: string;
    description: string | null;
    sortOrder: number;
    lessons: Lesson[];
}

export interface Lesson {
    id: string;
    title: string;
    type: LessonType;
    sortOrder: number;
    duration: number | null;
    lessonState?: Array<{ status: string; videoProgress?: number; completedAt: string | null }>;
}

export interface LessonContent {
    id: string;
    title: string;
    type: LessonType;
    content: string | Record<string, any> | null;
    videoUrl: string | null;
    duration: number | null;
    objectives: string[];
    checkpoints: Checkpoint[];
    notes: any[];
    lessonState: Array<{ status: string; videoProgress?: number; completedAt: string | null }>;
    module: {
        id: string;
        title?: string;
        courseId?: string;
        course: { id: string; title: string };
        lessons: Array<{ id: string; title: string; sortOrder: number }>;
    };
}

export interface Checkpoint {
    id: string;
    type: 'QUESTION' | 'EXERCISE' | 'REFLECTION';
    question: string;
    options: string[] | null;
    correctIndex: number | null;
    explanation: string | null;
}

export interface LessonState {
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
    progressPct: number;
    completedAt: string | null;
}

export interface CourseProgress {
    completedLessons: number;
    totalLessons: number;
    pct: number;
    lastAccessedAt: string | null;
}

// ============================================
// FLASHCARDS (FSRS)
// ============================================

export interface FlashCard {
    id: string;
    front: string;
    back: string;
    lessonId: string | null;
    courseId: string | null;
    courseTitle: string | null;
    timestamp: number | null;
    // FSRS fields
    due: string;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: 'NEW' | 'LEARNING' | 'REVIEW' | 'RELEARNING';
}

export type CardRating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface ReviewResult {
    card: FlashCard;
    nextDue: string;
    interval: number;
}

export interface CardStats {
    total: number;
    due: number;
    new: number;
    learning: number;
    review: number;
}

// ============================================
// CHAT (AI TUTOR)
// ============================================

export interface ChatSession {
    id: string;
    title: string | null;
    courseId: string | null;
    courseTitle: string | null;
    context: string | null;
    updatedAt: string;
    messageCount: number;
    archived?: boolean;
    active?: boolean;
    summary?: string | null;
    parentSessionId?: string | null;
}

export interface ChatMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
    images?: Array<{ url: string; mediaType: string; width?: number; height?: number }>;
    documents?: Array<{ url: string; mediaType: string; fileName: string; fileSize: number }>;
}

// ============================================
// PROGRESS & STATS
// ============================================

export interface DailyProgress {
    date: string;
    lessonsCompleted: number;
    cardsReviewed: number;
    xpEarned: number;
    studyMinutes: number;
}

export interface UserStats {
    totalXP: number;
    currentStreak: number;
    longestStreak: number;
    coursesCompleted: number;
    coursesInProgress: number;
    cardsTotal: number;
    cardsMastered: number;
}

export interface Streak {
    current: number;
    longest: number;
    lastActiveDate: string;
}
