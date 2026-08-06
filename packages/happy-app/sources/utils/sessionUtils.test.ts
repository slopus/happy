import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key === 'session.newChat' ? 'New chat' : key,
}));

import { getSessionName } from './sessionUtils';
import type { Session } from '@/sync/storageTypes';

function sessionWithMetadata(metadata: Session['metadata']): Session {
    return {
        id: 'session-1',
        seq: 0,
        metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        activeAt: Date.now(),
        presence: 0,
        active: false,
        thinking: false,
        thinkingAt: 0,
    };
}

describe('getSessionName', () => {
    it('uses the first-message fallback name when no explicit summary exists', () => {
        expect(getSessionName(sessionWithMetadata({
            path: '/tmp/project',
            host: 'localhost',
            name: 'Inspect authentication callback',
        }))).toBe('Inspect authentication callback');
    });

    it('prefers an explicit summary over the first-message fallback name', () => {
        expect(getSessionName(sessionWithMetadata({
            path: '/tmp/project',
            host: 'localhost',
            name: 'Inspect authentication callback',
            summary: {
                text: 'Fix auth callback',
                updatedAt: 123,
            },
        }))).toBe('Fix auth callback');
    });
});
