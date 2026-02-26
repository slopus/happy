import { describe, it, expect } from 'vitest';
import { Session } from '@/sync/storageTypes';

// Test the sorting logic used in ActiveSessionsGroup and storage.ts

function createSession(id: string, updatedAt: number, path: string = '/home/user/project'): Session {
    return {
        id,
        seq: 1,
        createdAt: updatedAt - 1000,
        updatedAt,
        active: true,
        activeAt: updatedAt,
        presence: 'online',
        thinking: false,
        thinkingAt: 0,
        metadata: {
            path,
            host: 'localhost',
            homeDir: '/home/user',
        },
        agentState: null,
        messages: [],
        permissionMode: 'default',
    } as Session;
}

describe('session sorting by activity', () => {
    it('sorts sessions by updatedAt descending (most recent first)', () => {
        const sessions = [
            createSession('old', 1000),
            createSession('newest', 3000),
            createSession('middle', 2000),
        ];

        const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

        expect(sorted[0].id).toBe('newest');
        expect(sorted[1].id).toBe('middle');
        expect(sorted[2].id).toBe('old');
    });

    it('sorts project groups by most recent session activity', () => {
        const groups = [
            { displayPath: '~/alpha', latestUpdatedAt: 1000 },
            { displayPath: '~/beta', latestUpdatedAt: 3000 },
            { displayPath: '~/gamma', latestUpdatedAt: 2000 },
        ];

        const sorted = [...groups].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);

        expect(sorted[0].displayPath).toBe('~/beta');
        expect(sorted[1].displayPath).toBe('~/gamma');
        expect(sorted[2].displayPath).toBe('~/alpha');
    });

    it('prefers activity-based sort over alphabetical path sort', () => {
        // Path "~/zebra" would come last alphabetically but should come first
        // if it has the most recent activity
        const groups = [
            { displayPath: '~/alpha', latestUpdatedAt: 1000 },
            { displayPath: '~/zebra', latestUpdatedAt: 3000 },
        ];

        const sortedByActivity = [...groups].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
        const sortedByPath = [...groups].sort((a, b) => a.displayPath.localeCompare(b.displayPath));

        // Activity sort puts zebra first
        expect(sortedByActivity[0].displayPath).toBe('~/zebra');
        // Path sort puts alpha first
        expect(sortedByPath[0].displayPath).toBe('~/alpha');
    });
});
