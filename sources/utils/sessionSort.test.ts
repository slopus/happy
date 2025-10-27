import { describe, it, expect } from 'vitest';
import {
    getSessionPriority,
    sortSessionsByPriority,
    getSessionPriorityLabel,
    sessionNeedsAttention
} from './sessionSort';
import { Session } from '@/sync/storageTypes';

// Helper function to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'test-session',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides
    };
}

describe('sessionSort', () => {
    describe('getSessionPriority', () => {
        it('should prioritize sessions with permission requests', () => {
            const session = createMockSession({
                agentState: {
                    requests: {
                        req1: {
                            tool: 'bash',
                            arguments: {},
                            createdAt: Date.now()
                        }
                    },
                    completedRequests: null,
                    controlledByUser: null
                }
            });

            const priority = getSessionPriority(session);
            expect(priority).toBe(1000); // HAS_PERMISSION_REQUEST
        });

        it('should prioritize waiting sessions (online but not thinking)', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: false
            });

            const priority = getSessionPriority(session);
            expect(priority).toBe(500); // WAITING_FOR_INPUT
        });

        it('should prioritize active thinking sessions', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: true
            });

            const priority = getSessionPriority(session);
            expect(priority).toBe(100); // ACTIVE_THINKING
        });

        it('should give lowest priority to offline sessions', () => {
            const session = createMockSession({
                presence: 123456789 // timestamp means offline
            });

            const priority = getSessionPriority(session);
            expect(priority).toBe(0); // COMPLETED_OFFLINE
        });

        it('should prioritize permission requests over thinking state', () => {
            const sessionWithRequest = createMockSession({
                thinking: true,
                agentState: {
                    requests: { req1: { tool: 'bash', arguments: {}, createdAt: Date.now() } },
                    completedRequests: null,
                    controlledByUser: null
                }
            });
            const sessionThinking = createMockSession({
                thinking: true,
                agentState: null
            });

            expect(getSessionPriority(sessionWithRequest)).toBeGreaterThan(
                getSessionPriority(sessionThinking)
            );
        });
    });

    describe('sortSessionsByPriority', () => {
        it('should sort sessions by priority (highest first)', () => {
            const sessions: Session[] = [
                createMockSession({ id: 'offline', presence: 123456789 }),
                createMockSession({
                    id: 'has-request',
                    agentState: {
                        requests: { req1: { tool: 'bash', arguments: {}, createdAt: Date.now() } },
                        completedRequests: null,
                        controlledByUser: null
                    }
                }),
                createMockSession({ id: 'thinking', thinking: true }),
                createMockSession({ id: 'waiting', thinking: false, presence: 'online' })
            ];

            const sorted = sortSessionsByPriority(sessions);

            expect(sorted[0].id).toBe('has-request');
            expect(sorted[1].id).toBe('waiting');
            expect(sorted[2].id).toBe('thinking');
            expect(sorted[3].id).toBe('offline');
        });

        it('should sort by updatedAt when priorities are equal', () => {
            const sessions: Session[] = [
                createMockSession({
                    id: 'old-waiting',
                    thinking: false,
                    presence: 'online',
                    updatedAt: 100
                }),
                createMockSession({
                    id: 'new-waiting',
                    thinking: false,
                    presence: 'online',
                    updatedAt: 200
                })
            ];

            const sorted = sortSessionsByPriority(sessions);

            expect(sorted[0].id).toBe('new-waiting');
            expect(sorted[1].id).toBe('old-waiting');
        });

        it('should not mutate original array', () => {
            const original: Session[] = [
                createMockSession({ id: 'a', updatedAt: 100 }),
                createMockSession({ id: 'b', updatedAt: 200 })
            ];
            const originalCopy = [...original];

            sortSessionsByPriority(original);

            expect(original).toEqual(originalCopy);
        });
    });

    describe('getSessionPriorityLabel', () => {
        it('should return "Requires Action" for permission requests', () => {
            const session = createMockSession({
                agentState: {
                    requests: { req1: { tool: 'bash', arguments: {}, createdAt: Date.now() } },
                    completedRequests: null,
                    controlledByUser: null
                }
            });

            expect(getSessionPriorityLabel(session)).toBe('Requires Action');
        });

        it('should return "Waiting for Input" for waiting sessions', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: false
            });

            expect(getSessionPriorityLabel(session)).toBe('Waiting for Input');
        });

        it('should return "Active" for thinking sessions', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: true
            });

            expect(getSessionPriorityLabel(session)).toBe('Active');
        });

        it('should return "Offline" for offline sessions', () => {
            const session = createMockSession({
                presence: 123456789
            });

            expect(getSessionPriorityLabel(session)).toBe('Offline');
        });
    });

    describe('sessionNeedsAttention', () => {
        it('should return true for sessions with permission requests', () => {
            const session = createMockSession({
                agentState: {
                    requests: { req1: { tool: 'bash', arguments: {}, createdAt: Date.now() } },
                    completedRequests: null,
                    controlledByUser: null
                }
            });

            expect(sessionNeedsAttention(session)).toBe(true);
        });

        it('should return true for waiting sessions', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: false
            });

            expect(sessionNeedsAttention(session)).toBe(true);
        });

        it('should return false for thinking sessions', () => {
            const session = createMockSession({
                presence: 'online',
                thinking: true
            });

            expect(sessionNeedsAttention(session)).toBe(false);
        });

        it('should return false for offline sessions', () => {
            const session = createMockSession({
                presence: 123456789
            });

            expect(sessionNeedsAttention(session)).toBe(false);
        });
    });
});
