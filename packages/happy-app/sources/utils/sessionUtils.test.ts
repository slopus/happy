import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { getSessionName } from './sessionUtils';

vi.mock('@/text', () => ({
    t: () => 'unknown',
}));

function makeSession(metadata: Session['metadata']): Session {
    return {
        id: 'session-1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('getSessionName', () => {
    it('prefers a manual metadata name over summary and path fallback', () => {
        expect(getSessionName(makeSession({
            path: '/workspace/project',
            host: 'workstation',
            name: 'Production Dashboard',
            summary: {
                text: 'Automatic summary',
                updatedAt: 1,
            },
        }))).toBe('Production Dashboard');
    });

    it('ignores blank manual names and falls back to automatic summary', () => {
        expect(getSessionName(makeSession({
            path: '/workspace/project',
            host: 'workstation',
            name: '   ',
            summary: {
                text: 'Automatic summary',
                updatedAt: 1,
            },
        }))).toBe('Automatic summary');
    });

    it('falls back to the last path segment when no title metadata exists', () => {
        expect(getSessionName(makeSession({
            path: '/workspace/project',
            host: 'workstation',
        }))).toBe('project');
    });
});
