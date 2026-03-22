import type { Router } from "expo-router"
import { useRouter } from "expo-router"

export function navigateToSession(router: Router, sessionId: string) {
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
