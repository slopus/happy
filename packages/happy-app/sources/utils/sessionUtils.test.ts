import { describe, it, expect, vi } from 'vitest';
import { getSessionSubtitle, formatPathRelativeToHome, getSessionName } from './sessionUtils';
import { Session } from '@/sync/storageTypes';

// Mock @/text to return key-based values for deterministic testing
vi.mock('@/text', () => ({
    t: (key: string) => {
        const translations: Record<string, string> = {
            'status.unknown': 'Unknown',
            'sessionInfo.startedByDaemon': 'Daemon',
            'sessionInfo.startedByTerminal': 'Terminal',
        };
        return translations[key] || key;
    }
}));

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'test-session-id',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        presence: 'online',
        thinking: false,
        thinkingAt: 0,
        metadata: {
            path: '/home/user/projects/my-app',
            host: 'localhost',
            homeDir: '/home/user',
        },
        agentState: null,
        messages: [],
        permissionMode: 'default',
        ...overrides,
    } as Session;
}

describe('sessionUtils', () => {
    describe('getSessionSubtitle', () => {
        it('returns path relative to home for terminal sessions', () => {
            const session = createSession();
            expect(getSessionSubtitle(session)).toBe('~/projects/my-app');
        });

        it('appends daemon label when session was started by daemon', () => {
            const session = createSession({
                metadata: {
                    path: '/home/user/projects/my-app',
                    host: 'localhost',
                    homeDir: '/home/user',
                    startedBy: 'daemon',
                },
            } as Partial<Session>);
            expect(getSessionSubtitle(session)).toBe('~/projects/my-app · daemon');
        });

        it('does not append label for terminal sessions', () => {
            const session = createSession({
                metadata: {
                    path: '/home/user/projects/my-app',
                    host: 'localhost',
                    homeDir: '/home/user',
                    startedBy: 'terminal',
                },
            } as Partial<Session>);
            expect(getSessionSubtitle(session)).toBe('~/projects/my-app');
        });

        it('does not append label when startedBy is not set', () => {
            const session = createSession();
            expect(getSessionSubtitle(session)).not.toContain('·');
        });

        it('returns Unknown when metadata is missing', () => {
            const session = createSession({ metadata: null } as Partial<Session>);
            expect(getSessionSubtitle(session)).toBe('Unknown');
        });
    });

    describe('formatPathRelativeToHome', () => {
        it('replaces home dir with ~', () => {
            expect(formatPathRelativeToHome('/home/user/projects', '/home/user')).toBe('~/projects');
        });

        it('returns full path when no homeDir', () => {
            expect(formatPathRelativeToHome('/home/user/projects')).toBe('/home/user/projects');
        });

        it('returns ~ for exact home dir match', () => {
            expect(formatPathRelativeToHome('/home/user', '/home/user')).toBe('~');
        });
    });
});
