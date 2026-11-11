import { getRuntimeAccountSelection } from '@/auth/accountRuntime';

const deletedSessions = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
function sessionKey(sessionId: string) {
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.serverUrl, account?.generation, sessionId]);
}
export function isProjectSessionDeleted(sessionId: string) { return deletedSessions.has(sessionKey(sessionId)); }
export const getProjectSessionDeletionRevision = () => revision;
export function subscribeProjectSessionDeletions(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function markProjectSessionDeleted(sessionId: string) {
    deletedSessions.add(sessionKey(sessionId));
    revision++;
    for (const listener of listeners) listener();
}
