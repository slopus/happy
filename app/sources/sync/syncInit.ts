import { syncEngine } from '@/sync/SyncEngine';
import { AuthCredentials } from '@/auth/tokenStorage';

const SYNC_ENDPOINT = 'https://handy-api.korshakov.org';

let isInitialized = false;

export function initializeSync(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized, updating token');
        syncEngine.updateToken(credentials.token);
        return;
    }

    syncEngine.initialize({
        endpoint: SYNC_ENDPOINT,
        token: credentials.token
    });

    isInitialized = true;
}

export function disconnectSync() {
    syncEngine.disconnect();
    isInitialized = false;
}