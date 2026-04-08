import type { Router } from "expo-router"
import { useRouter } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';

export function navigateToSession(router: Router, sessionId: string) {
    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    router.navigate(`/session/${encodeURIComponent(sessionId)}`, {
        dangerouslySingular() {
            return 'session'
        },
    });
}

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        navigateToSession(router, sessionId);
    }
}
