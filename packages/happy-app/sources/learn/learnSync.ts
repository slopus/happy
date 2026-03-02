import { learnApi } from './learnApi';
import { learnStorage } from './learnStorage';
import type { AuthCredentials } from '@/auth/tokenStorage';

let isInitialized = false;

export async function learnRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Learn already initialized: ignoring');
        return;
    }
    isInitialized = true;

    try {
        // Exchange Happy token for Learn JWT
        const { token, user } = await learnApi.exchangeToken(credentials.token);
        learnApi.setToken(token);
        learnStorage.getState().setUser(user);
        learnStorage.getState().setApiStatus('connected');

        // Fetch initial data in parallel
        const [coursesRes, todayRes, statsRes, cardStatsRes, chatRes] = await Promise.allSettled([
            learnApi.getCourses(),
            learnApi.getToday(),
            learnApi.getStats(),
            learnApi.getCardStats(),
            learnApi.getChatSessions(),
        ]);

        if (coursesRes.status === 'fulfilled') {
            learnStorage.getState().setCourses(coursesRes.value.courses);
        }
        if (todayRes.status === 'fulfilled') {
            learnStorage.getState().setToday(todayRes.value);
        }
        if (statsRes.status === 'fulfilled') {
            learnStorage.getState().setStats(statsRes.value);
        }
        if (cardStatsRes.status === 'fulfilled') {
            learnStorage.getState().setCardStats(cardStatsRes.value);
        }
        if (chatRes.status === 'fulfilled') {
            learnStorage.getState().setChatSessions(chatRes.value.sessions);
        }

        learnStorage.getState().setLoaded(true);
    } catch (error) {
        console.error('Learn init error:', error);
        learnStorage.getState().setApiStatus('error');

        // Try using cached Learn token
        const cachedToken = learnApi.getToken();
        if (cachedToken) {
            try {
                const { user } = await learnApi.getMe();
                learnStorage.getState().setUser(user);
                learnStorage.getState().setApiStatus('connected');

                const [coursesRes, todayRes] = await Promise.allSettled([
                    learnApi.getCourses(),
                    learnApi.getToday(),
                ]);
                if (coursesRes.status === 'fulfilled') {
                    learnStorage.getState().setCourses(coursesRes.value.courses);
                }
                if (todayRes.status === 'fulfilled') {
                    learnStorage.getState().setToday(todayRes.value);
                }
                learnStorage.getState().setLoaded(true);
            } catch {
                learnApi.clearToken();
                learnStorage.getState().setApiStatus('error');
            }
        }
    }
}

export function learnReset() {
    isInitialized = false;
    learnApi.clearToken();
    learnStorage.getState().reset();
}
