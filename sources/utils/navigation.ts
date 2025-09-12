import { router } from 'expo-router';

/**
 * Navigate to session screen using dangerouslySingular to ensure only one session instance on the stack
 */
export function navigateToSession(sessionId: string) {
    router.navigate(`/session/${sessionId}`, {
        dangerouslySingular(name: any, params: any) {
            return 'session';
        },
    } as any);
}

/**
 * Navigate to composer screen using dangerouslySingular to ensure only one composer instance on the stack
 */
export function navigateToComposer(params?: { machineId?: string; selectedPath?: string }) {
    router.navigate('/composer', {
        params: params as any,
        dangerouslySingular(name: any, params: any) {
            return 'composer';
        },
    } as any);
}