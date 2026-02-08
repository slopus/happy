import type { VoiceSessionRecord, VoiceSessionState } from '../types/voice';

const sessions = new Map<string, VoiceSessionRecord>();

function nowIso() {
    return new Date().toISOString();
}

export const sessionStore = {
    set(record: VoiceSessionRecord) {
        sessions.set(record.gatewaySessionId, record);
        return record;
    },

    get(gatewaySessionId: string) {
        return sessions.get(gatewaySessionId);
    },

    markState(gatewaySessionId: string, state: VoiceSessionState, lastError?: string) {
        const existing = sessions.get(gatewaySessionId);
        if (!existing) return undefined;
        const updated: VoiceSessionRecord = {
            ...existing,
            state,
            lastError,
            updatedAt: nowIso(),
        };
        sessions.set(gatewaySessionId, updated);
        return updated;
    },

    list() {
        return Array.from(sessions.values());
    },

    pruneExpired() {
        const now = Date.now();
        for (const [key, value] of sessions.entries()) {
            if (new Date(value.expiresAt).getTime() < now && value.state !== 'active') {
                sessions.delete(key);
            }
        }
    },
};
