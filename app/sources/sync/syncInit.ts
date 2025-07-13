import { syncEngine } from '@/sync/SyncEngine';
import { sessionsEngine } from '@/sync/SessionsEngine';
import { AuthCredentials } from '@/auth/tokenStorage';

const SYNC_ENDPOINT = 'https://handy-api.korshakov.org';

let isInitialized = false;

export async function initializeSync(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized, updating token');
        syncEngine.updateToken(credentials.token);
        return;
    }

    // Initialize socket connection
    syncEngine.initialize({
        endpoint: SYNC_ENDPOINT,
        token: credentials.token
    });

    // Initialize sessions engine
    await sessionsEngine.initialize(credentials);

    isInitialized = true;
}

export function disconnectSync() {
    syncEngine.disconnect();
    sessionsEngine.clear();
    isInitialized = false;
}