import { syncSocket } from '@/sync/SyncSocket';
import { syncSessions } from '@/sync/SyncEngine';
import { AuthCredentials } from '@/auth/tokenStorage';
import { MessageEncryption } from './encryption';

const SYNC_ENDPOINT = 'https://handy-api.korshakov.org';

let isInitialized = false;

export async function initializeSync(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }

    // Initialize socket connection
    syncSocket.initialize({
        endpoint: SYNC_ENDPOINT,
        token: credentials.token
    }, new MessageEncryption(credentials.secret));

    // Initialize sessions engine
    await syncSessions.initialize(credentials);

    isInitialized = true;
}