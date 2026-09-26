/**
 * Offline Reconnection Setup
 *
 * Handles the common pattern of creating an offline session stub with
 * automatic background reconnection for all backends (Codex, Gemini).
 *
 * @module setupOfflineReconnection
 */

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata, Session } from '@/api/types';
import { configuration } from '@/configuration';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';
import { startOfflineReconnection } from '@/utils/serverConnectionErrors';
import { resolveManagedOfflineFallback } from '@/managed/managedStartup';

/**
 * Options for setting up offline reconnection.
 */
export interface SetupOfflineReconnectionOptions {
    /**
     * Whether this is a managed Cloud run. Such a run may not create a session
     * of its own — the parent holds the only key for the one it was given.
     */
    managedRun?: boolean;
    sessionOptions?: { trackShutdownStorage?: boolean };
    /** API client instance */
    api: ApiClient;
    /** Unique session tag */
    sessionTag: string;
    /** Session metadata */
    metadata: Metadata;
    /** Agent state */
    state: AgentState;
    /** Initial API response (null if server unreachable) */
    response: Session | null;
    /**
     * Callback invoked when session is swapped after reconnection.
     * Use this to update the session reference in the calling code.
     */
    onSessionSwap: (newSession: ApiSessionClient) => void;
}

/**
 * Result from setupOfflineReconnection.
 */
export interface SetupOfflineReconnectionResult {
    /** The session client (stub if offline, real if connected) */
    session: ApiSessionClient;
    /** Handle to the reconnection process, null if connected */
    reconnectionHandle: ReturnType<typeof startOfflineReconnection<ApiSessionClient>> | null;
    /** Whether we're in offline mode */
    isOffline: boolean;
}

/**
 * Sets up offline session handling with automatic background reconnection.
 *
 * If the server is unreachable (response is null), this creates an offline
 * session stub and starts background reconnection. When reconnection succeeds,
 * the `onSessionSwap` callback is invoked with the new real session.
 *
 * @param opts - Options including api, sessionTag, metadata, state, response, onSessionSwap
 * @returns Result with session, reconnectionHandle, and isOffline flag
 *
 * @example
 * ```typescript
 * let session: ApiSessionClient;
 *
 * const result = setupOfflineReconnection({
 *     api,
 *     sessionTag,
 *     metadata,
 *     state,
 *     response,
 *     onSessionSwap: (newSession) => { session = newSession; }
 * });
 *
 * session = result.session;
 * const reconnectionHandle = result.reconnectionHandle;
 * ```
 */
export function setupOfflineReconnection(opts: SetupOfflineReconnectionOptions): SetupOfflineReconnectionResult {
    const { api, sessionTag, metadata, state, response, onSessionSwap } = opts;
    const managedRun = opts.managedRun === true;

    let session: ApiSessionClient;
    let reconnectionHandle: ReturnType<typeof startOfflineReconnection<ApiSessionClient>> | null = null;

    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        // Create a no-op session stub for offline mode using shared utility
        session = createOfflineSessionStub(sessionTag);

        // Start background reconnection
        reconnectionHandle = startOfflineReconnection<ApiSessionClient>({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                // A managed run has no session of its own to make: the parent
                // created one and holds the only key for it. Creating another
                // here would produce work nobody can read.
                resolveManagedOfflineFallback(managedRun);
                const resp = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const realSession = api.sessionSyncClient(resp, opts.sessionOptions);
                // Notify caller to swap the session reference
                onSessionSwap(realSession);
                return realSession;
            },
            onNotify: (msg) => {
                // Log to console - this matches Claude's behavior
                console.log(msg);
            }
        });

        return { session, reconnectionHandle, isOffline: true };
    } else {
        session = api.sessionSyncClient(response, opts.sessionOptions);
        return { session, reconnectionHandle: null, isOffline: false };
    }
}
