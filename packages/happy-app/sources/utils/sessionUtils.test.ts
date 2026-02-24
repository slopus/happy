import { describe, it, expect, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => key
}));

import { getSessionName, getSessionDefaultName, getSessionCustomName } from './sessionUtils';
import type { Session } from '@/sync/storageTypes';

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'test-session',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: { path: '/Users/test/project', host: 'test-host' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
        ...overrides
    };
}

describe('sessionUtils', () => {
    describe('getSessionCustomName', () => {
        it('should return the custom name when set', () => {
            const session = makeSession({ customName: 'My Custom Name' });
            expect(getSessionCustomName(session)).toBe('My Custom Name');
        });

        it('should return null when customName is null', () => {
            const session = makeSession({ customName: null });
            expect(getSessionCustomName(session)).toBeNull();
        });

        it('should return null when customName is undefined', () => {
            const session = makeSession({ customName: undefined });
            expect(getSessionCustomName(session)).toBeNull();
        });

        it('should return null when customName is empty string', () => {
            const session = makeSession({ customName: '' });
            expect(getSessionCustomName(session)).toBeNull();
        });
    });

    describe('getSessionDefaultName', () => {
        describe('summary text', () => {
            it('should return summary text when available', () => {
                const session = makeSession({
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Fix login bug', updatedAt: Date.now() }
                    }
                });
                expect(getSessionDefaultName(session)).toBe('Fix login bug');
            });

            it('should return summary even when customName is set', () => {
                const session = makeSession({
                    customName: 'Custom',
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Summary text', updatedAt: Date.now() }
                    }
                });
                expect(getSessionDefaultName(session)).toBe('Summary text');
            });
        });

        describe('path fallback', () => {
            it('should return last path segment when no summary', () => {
                const session = makeSession({
                    metadata: { path: '/Users/test/my-project', host: 'test-host' }
                });
                expect(getSessionDefaultName(session)).toBe('my-project');
            });

            it('should handle deeply nested paths', () => {
                const session = makeSession({
                    metadata: { path: '/Users/test/code/repos/my-app', host: 'test-host' }
                });
                expect(getSessionDefaultName(session)).toBe('my-app');
            });

            it('should handle single-segment paths', () => {
                const session = makeSession({
                    metadata: { path: '/project', host: 'test-host' }
                });
                expect(getSessionDefaultName(session)).toBe('project');
            });
        });

        describe('edge cases', () => {
            it('should return status.unknown when metadata is null', () => {
                const session = makeSession({ metadata: null });
                expect(getSessionDefaultName(session)).toBe('status.unknown');
            });

            it('should return status.unknown when path has no segments', () => {
                const session = makeSession({
                    metadata: { path: '/', host: 'test-host' }
                });
                expect(getSessionDefaultName(session)).toBe('status.unknown');
            });
        });
    });

    describe('getSessionName', () => {
        describe('custom name priority', () => {
            it('should return customName when set', () => {
                const session = makeSession({ customName: 'My Custom Name' });
                expect(getSessionName(session)).toBe('My Custom Name');
            });

            it('should prioritize customName over summary text', () => {
                const session = makeSession({
                    customName: 'Priority Name',
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Summary text', updatedAt: Date.now() }
                    }
                });
                expect(getSessionName(session)).toBe('Priority Name');
            });

            it('should prioritize customName over path-based name', () => {
                const session = makeSession({
                    customName: 'Custom',
                    metadata: { path: '/Users/test/my-project', host: 'test-host' }
                });
                expect(getSessionName(session)).toBe('Custom');
            });
        });

        describe('fallback to default name', () => {
            it('should return summary text when no customName is set', () => {
                const session = makeSession({
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Fix login bug', updatedAt: Date.now() }
                    }
                });
                expect(getSessionName(session)).toBe('Fix login bug');
            });

            it('should return last path segment when no customName and no summary', () => {
                const session = makeSession({
                    metadata: { path: '/Users/test/my-project', host: 'test-host' }
                });
                expect(getSessionName(session)).toBe('my-project');
            });

            it('should return status.unknown when metadata is null', () => {
                const session = makeSession({ metadata: null });
                expect(getSessionName(session)).toBe('status.unknown');
            });
        });

        describe('edge cases', () => {
            it('should ignore null customName and fall through to summary', () => {
                const session = makeSession({
                    customName: null,
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Some summary', updatedAt: Date.now() }
                    }
                });
                expect(getSessionName(session)).toBe('Some summary');
            });

            it('should ignore empty string customName and fall through to summary', () => {
                const session = makeSession({
                    customName: '',
                    metadata: {
                        path: '/Users/test/project',
                        host: 'test-host',
                        summary: { text: 'Some summary', updatedAt: Date.now() }
                    }
                });
                expect(getSessionName(session)).toBe('Some summary');
            });

            it('should ignore undefined customName and fall through to path', () => {
                const session = makeSession({
                    customName: undefined,
                    metadata: { path: '/Users/test/fallback-project', host: 'test-host' }
                });
                expect(getSessionName(session)).toBe('fallback-project');
            });
        });
    });
});
