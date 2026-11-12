import { getRuntimeAccountSelection } from '@/auth/accountRuntime';

const deletedSessions = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
type DeletionPersistence = { has: (key: string) => boolean; mark: (key: string) => void };
let persistence: DeletionPersistence | undefined;
/** The cache bootstrap supplies the account store without native imports in this leaf. */
export function configureProjectSessionDeletionPersistence(store: DeletionPersistence | undefined) { persistence = store; }
function sessionKey(sessionId: string) {
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.serverUrl, account?.generation, sessionId]);
}
function durableKey(sessionId: string) {
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.scope, account?.serverUrl, sessionId]);
}
export function isProjectSessionDeleted(sessionId: string) {
    if (deletedSessions.has(sessionKey(sessionId))) return true;
    try {
        if (!persistence?.has(durableKey(sessionId))) return false;
        deletedSessions.add(sessionKey(sessionId));
        return true;
    } catch { return false; }
}
export const getProjectSessionDeletionRevision = () => revision;
export function subscribeProjectSessionDeletions(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function markProjectSessionDeleted(sessionId: string) {
    deletedSessions.add(sessionKey(sessionId));
    try { persistence?.mark(durableKey(sessionId)); } catch { /* Keep the in-memory fence if storage is disabled. */ }
    revision++;
    for (const listener of listeners) listener();
}
