import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { appAuthorizationRequest } from '@/sync/apiAppDelegation';
import { decryptAppConversationHistory, parseAppConversationHistory, type AppHistoryContent } from '@/sync/appConversationHistory';

type HistoryError = 'unavailable' | 'removed' | 'key';
interface Snapshot { token: string; server: string; id: string; content: AppHistoryContent | null; error: HistoryError | null }

/** Poll only the visible owner's conversation; ignore late results after navigation or account changes. */
export function useAppConversationHistory(id?: string) {
    const token = useAuth().credentials?.token;
    const server = getServerUrl();
    const [revision, refresh] = React.useReducer(n => n + 1, 0);
    const [refreshing, setRefreshing] = React.useState(false);
    const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
    const owner = React.useRef({ token, server, id });
    owner.current = { token, server, id };
    useFocusEffect(React.useCallback(() => {
        if (!token || !id) return;
        const controller = new AbortController();
        let running = false;
        const current = () => !controller.signal.aborted && owner.current.token === token && owner.current.server === server
            && owner.current.id === id && getServerUrl() === server;
        const load = async () => {
            if (running || (AppState.currentState && AppState.currentState !== 'active')
                || (Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden)) return;
            running = true;
            setRefreshing(true);
            try {
                const raw = await appAuthorizationRequest<unknown>(token, `/conversations/${encodeURIComponent(id)}/history`, undefined, 'GET', controller.signal);
                if (!current()) return;
                const history = parseAppConversationHistory(raw, id);
                const encryption = sync.encryption.getMachineEncryption(history.machineId);
                const envelope = encryption ? await encryption.decryptRaw(history.machineEnvelope) : null;
                if (!current()) return;
                if (!envelope) { setSnapshot({ token, server, id, content: null, error: 'key' }); return; }
                const content = decryptAppConversationHistory(history, envelope);
                if (current()) setSnapshot({ token, server, id, content, error: null });
            } catch (error) {
                if (current()) setSnapshot({ token, server, id, content: null,
                    error: [401, 403, 404].includes((error as { status?: number }).status ?? 0) ? 'removed' : 'unavailable' });
            } finally { running = false; if (current()) setRefreshing(false); }
        };
        void load();
        const timer = setInterval(() => void load(), 10_000);
        const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
        const foreground = () => { if (!document.hidden) void load(); };
        if (Platform.OS === 'web') document.addEventListener('visibilitychange', foreground);
        return () => {
            controller.abort(); clearInterval(timer); subscription.remove();
            if (Platform.OS === 'web') document.removeEventListener('visibilitychange', foreground);
        };
    }, [id, token, server, revision]));
    const current = snapshot?.token === token && snapshot?.server === server && snapshot?.id === id ? snapshot : null;
    return { content: current?.content ?? null, error: current?.error ?? null, loading: Boolean(id && token && !current), refreshing, refresh };
}
