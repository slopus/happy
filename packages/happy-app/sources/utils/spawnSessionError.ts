import type { SpawnSessionResult } from '@/sync/ops';
import { t } from '@/text';

export function describeSpawnSessionError(result: SpawnSessionResult, fallbackMessage: string): string {
    if (result.type !== 'error') return fallbackMessage;
    if ('errorCode' in result && result.errorCode === 'session-hydration-failed') {
        return t('newSession.sessionHydrationFailed');
    }
    return result.errorMessage;
}
