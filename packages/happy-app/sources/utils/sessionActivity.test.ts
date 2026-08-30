import { describe, expect, it } from 'vitest';
import { getSessionActivityAt } from './sessionActivity';
import type { Session } from '@/sync/storageTypes';

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session',
        seq: 0,
        createdAt: 100,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('getSessionActivityAt', () => {
    it('prefers the published timestamp so every device agrees on the order', () => {
        const value = getSessionActivityAt(session({
            metadata: { path: '/repo', host: 'host', lastMeaningfulMessageAt: 900 },
            lastMessageSentAt: 300,
        }));
        expect(value).toBe(900);
    });

    it('falls back to this device\'s own last sent message', () => {
        const value = getSessionActivityAt(session({
            metadata: { path: '/repo', host: 'host' },
            lastMessageSentAt: 300,
        }));
        expect(value).toBe(300);
    });

    it('falls back to creation when the session has never been touched', () => {
        expect(getSessionActivityAt(session())).toBe(100);
    });

    // An agent that publishes the field is authoritative even when it reports a
    // time older than what this device happens to remember sending: the local
    // value is a guess about one device, the published one covers them all.
    it('does not let the local timestamp override the published one', () => {
        const value = getSessionActivityAt(session({
            metadata: { path: '/repo', host: 'host', lastMeaningfulMessageAt: 200 },
            lastMessageSentAt: 800,
        }));
        expect(value).toBe(200);
    });
});
