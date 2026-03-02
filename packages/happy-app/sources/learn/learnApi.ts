import { Platform } from 'react-native';
import type {
    LearnUser, Course, CourseModule, LessonContent,
    FlashCard, CardRating, ReviewResult, CardStats,
    ChatSession, ChatMessage, DailyProgress, UserStats,
} from './learnTypes';

const LEARN_API_URL = process.env.EXPO_PUBLIC_LEARN_API_URL || '';

class LearnApi {
    private token: string | null = null;

    setToken(token: string) {
        this.token = token;
        if (Platform.OS === 'web') {
            try { localStorage.setItem('learn-token', token); } catch {}
        }
    }

    getToken(): string | null {
        if (this.token) return this.token;
        if (Platform.OS === 'web') {
            try { return localStorage.getItem('learn-token'); } catch {}
        }
        return null;
    }

    clearToken() {
        this.token = null;
        if (Platform.OS === 'web') {
            try { localStorage.removeItem('learn-token'); } catch {}
        }
    }

    private async request<T>(path: string, options?: RequestInit): Promise<T> {
        const token = this.getToken();
        const headers: Record<string, string> = {
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        };
        if (options?.body) {
            headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(`${LEARN_API_URL}${path}`, {
            ...options,
            headers: {
                ...headers,
                ...options?.headers,
            },
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }

        return res.json();
    }

    // ============================================
    // AUTH
    // ============================================

    async exchangeToken(happyToken: string): Promise<{ token: string; user: LearnUser }> {
        const res = await fetch(`${LEARN_API_URL}/v1/auth/exchange`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${happyToken}` },
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Exchange failed: HTTP ${res.status}`);
        }
        return res.json();
    }

    async getMe(): Promise<{ user: LearnUser }> {
        return this.request('/v1/auth/me');
    }

    // ============================================
    // COURSES
    // ============================================

    async getCourses(): Promise<{ courses: Course[] }> {
        return this.request('/v1/courses');
    }

    async getCourse(id: string): Promise<{ course: Course & { modules: CourseModule[] } }> {
        return this.request(`/v1/courses/${id}`);
    }

    // ============================================
    // LESSONS
    // ============================================

    async getLesson(id: string): Promise<{ lesson: LessonContent }> {
        return this.request(`/v1/lessons/${id}`);
    }

    async completeLesson(id: string): Promise<void> {
        await this.request(`/v1/lessons/${id}/complete`, { method: 'POST' });
    }

    async uncompleteLesson(id: string): Promise<void> {
        await this.request(`/v1/lessons/${id}/uncomplete`, { method: 'POST' });
    }

    // ============================================
    // FLASHCARDS
    // ============================================

    async getDueCards(limit: number = 20, lessonId?: string): Promise<{ cards: FlashCard[]; count: number }> {
        const params = new URLSearchParams({ limit: String(limit) });
        if (lessonId) params.set('lessonId', lessonId);
        return this.request(`/v1/cards/due?${params}`);
    }

    async dismissCard(id: string): Promise<void> {
        await this.request(`/v1/cards/${id}`, { method: 'DELETE' });
    }

    async getDecks(): Promise<{ decks: Array<{
        lessonId: string;
        lessonTitle: string;
        courseId: string | null;
        courseTitle: string | null;
        total: number;
        due: number;
        new: number;
    }> }> {
        return this.request('/v1/cards/decks');
    }

    async reviewCard(
        id: string,
        rating: CardRating,
        elapsed: number,
        answer?: string
    ): Promise<{ card: FlashCard; review: { aiScore: number | null; aiFeedback: string | null }; next: { interval: number } }> {
        return this.request(`/v1/cards/${id}/review`, {
            method: 'POST',
            body: JSON.stringify({ rating, elapsed, answer }),
        });
    }

    async getCardStats(): Promise<CardStats & { reviewsToday: number }> {
        return this.request('/v1/cards/stats');
    }

    async generateCards(lessonId: string): Promise<{ cards: FlashCard[]; count: number }> {
        return this.request('/v1/cards/generate', {
            method: 'POST',
            body: JSON.stringify({ lessonId }),
        });
    }

    // ============================================
    // CHAT
    // ============================================

    async uploadImage(base64Data: string, mediaType: string, sessionId?: string): Promise<{ url: string; mediaType: string }> {
        return this.request('/v1/images', {
            method: 'POST',
            body: JSON.stringify({ data: base64Data, mediaType, sessionId }),
        });
    }

    async sendMessage(
        message: string,
        sessionId?: string,
        lessonId?: string,
        courseId?: string,
        images?: Array<{ url: string; mediaType: string }>,
        documents?: Array<{ url: string; mediaType: string; fileName: string; fileSize: number }>,
    ): Promise<{ sessionId: string; message: ChatMessage; cardsGenerated?: boolean }> {
        return this.request('/v1/chat', {
            method: 'POST',
            body: JSON.stringify({
                message, sessionId, lessonId, courseId,
                ...(images?.length ? { images } : {}),
                ...(documents?.length ? { documents } : {}),
            }),
        });
    }

    async sendMessageStream(
        message: string,
        opts?: { sessionId?: string; lessonId?: string; courseId?: string; images?: Array<{ url: string; mediaType: string }>; documents?: Array<{ url: string; mediaType: string; fileName: string; fileSize: number }> },
        callbacks?: {
            onSession?: (sessionId: string) => void;
            onDelta?: (content: string) => void;
            onDone?: (data: { messageId: string; cardsGenerated: boolean }) => void;
            onError?: (error: string) => void;
        },
    ) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const token = this.getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${LEARN_API_URL}/v1/chat/stream`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ message, ...opts }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let eventType = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    eventType = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (eventType === 'session') callbacks?.onSession?.(data.sessionId);
                        else if (eventType === 'delta') callbacks?.onDelta?.(data.content);
                        else if (eventType === 'done') callbacks?.onDone?.(data);
                        else if (eventType === 'error') callbacks?.onError?.(data.error);
                    } catch {}
                    eventType = '';
                }
            }
        }
    }

    async getChatHistory(sessionId: string, opts?: { limit?: number; before?: string }): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
        const params = new URLSearchParams();
        if (opts?.limit) params.set('limit', String(opts.limit));
        if (opts?.before) params.set('before', opts.before);
        const qs = params.toString();
        return this.request(`/v1/chat/${sessionId}${qs ? `?${qs}` : ''}`);
    }

    async getChatSessions(): Promise<{ sessions: ChatSession[] }> {
        return this.request('/v1/chat');
    }

    async getSessionChain(sessionId: string): Promise<{
        chain: Array<{
            id: string;
            title: string | null;
            summary: string | null;
            messageCount: number;
            active: boolean;
            createdAt: string;
        }>;
    }> {
        return this.request(`/v1/chat/${sessionId}/chain`);
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.request(`/v1/chat/${sessionId}/archive`, { method: 'POST' });
    }

    async unarchiveSession(sessionId: string): Promise<void> {
        await this.request(`/v1/chat/${sessionId}/unarchive`, { method: 'POST' });
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request(`/v1/chat/${sessionId}`, { method: 'DELETE' });
    }

    async archiveCourse(courseId: string): Promise<void> {
        await this.request(`/v1/chat/course/${courseId}/archive`, { method: 'POST' });
    }

    async deleteCourse(courseId: string): Promise<void> {
        await this.request(`/v1/chat/course/${courseId}`, { method: 'DELETE' });
    }

    // ============================================
    // PROGRESS
    // ============================================

    async getToday(): Promise<DailyProgress & {
        nextLesson: { id: string; title: string; courseTitle: string } | null;
        hasStudiedToday: boolean;
    }> {
        return this.request('/v1/progress/today');
    }

    async getStats(): Promise<UserStats> {
        return this.request('/v1/progress/stats');
    }

    async recordStreak(): Promise<void> {
        await this.request('/v1/progress/streak', { method: 'POST' });
    }

    // ============================================
    // NOTES
    // ============================================

    async getNotes(lessonId?: string): Promise<{ notes: any[] }> {
        const params = lessonId ? `?lessonId=${lessonId}` : '';
        return this.request(`/v1/notes${params}`);
    }

    async createNote(content: string, lessonId?: string): Promise<{ note: any }> {
        return this.request('/v1/notes', {
            method: 'POST',
            body: JSON.stringify({ content, lessonId }),
        });
    }

    // ============================================
    // SETTINGS
    // ============================================

    async updateSettings(settings: Record<string, any>): Promise<{ user: { id: string; settings: any } }> {
        return this.request('/v1/auth/settings', {
            method: 'PATCH',
            body: JSON.stringify({ settings }),
        });
    }
}

export const learnApi = new LearnApi();
