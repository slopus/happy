import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests the updateSessionCustomName logic extracted from the Zustand store.
 * Since the full store has many dependencies, we test the core logic
 * (normalization, persistence aggregation, session update) in isolation.
 */

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
    MMKV: vi.fn().mockImplementation(() => ({
        getString: (key: string) => mockStorage.get(key) ?? undefined,
        set: (key: string, value: string) => mockStorage.set(key, value),
        delete: (key: string) => mockStorage.delete(key),
        clearAll: () => mockStorage.clear(),
    }))
}));

import { loadSessionCustomNames, saveSessionCustomNames } from './persistence';
import type { Session } from './storageTypes';

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

/**
 * Mirrors the updateSessionCustomName logic from storage.ts.
 * This lets us test the normalization and persistence behavior
 * without importing the full Zustand store.
 */
function applyCustomNameUpdate(
    sessions: Record<string, Session>,
    sessionId: string,
    customName: string | null
): { sessions: Record<string, Session>; persisted: Record<string, string> } | null {
    const session = sessions[sessionId];
    if (!session) return null;

    const normalizedName = customName?.trim() ? customName.trim() : null;

    const allNames: Record<string, string> = {};
    Object.entries(sessions).forEach(([id, sess]) => {
        if (id === sessionId) {
            if (normalizedName) {
                allNames[id] = normalizedName;
            }
        } else if (sess.customName) {
            allNames[id] = sess.customName;
        }
    });

    saveSessionCustomNames(allNames);

    return {
        sessions: {
            ...sessions,
            [sessionId]: { ...session, customName: normalizedName }
        },
        persisted: allNames
    };
}

describe('updateSessionCustomName', () => {
    beforeEach(() => {
        mockStorage.clear();
    });

    describe('name normalization', () => {
        it('should trim leading and trailing whitespace', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            const result = applyCustomNameUpdate(sessions, 's1', '  hello  ');
            expect(result!.sessions['s1'].customName).toBe('hello');
        });

        it('should normalize whitespace-only string to null', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            const result = applyCustomNameUpdate(sessions, 's1', '   ');
            expect(result!.sessions['s1'].customName).toBeNull();
        });

        it('should normalize empty string to null', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            const result = applyCustomNameUpdate(sessions, 's1', '');
            expect(result!.sessions['s1'].customName).toBeNull();
        });

        it('should normalize null to null', () => {
            const sessions = { 's1': makeSession({ id: 's1', customName: 'Old Name' }) };
            const result = applyCustomNameUpdate(sessions, 's1', null);
            expect(result!.sessions['s1'].customName).toBeNull();
        });

        it('should preserve valid name as-is after trim', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            const result = applyCustomNameUpdate(sessions, 's1', 'Frontend Server');
            expect(result!.sessions['s1'].customName).toBe('Frontend Server');
        });
    });

    describe('session not found', () => {
        it('should return null when session does not exist', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            const result = applyCustomNameUpdate(sessions, 'nonexistent', 'Name');
            expect(result).toBeNull();
        });

        it('should not modify storage when session does not exist', () => {
            const sessions = { 's1': makeSession({ id: 's1' }) };
            saveSessionCustomNames({ 's1': 'Existing' });
            applyCustomNameUpdate(sessions, 'nonexistent', 'Name');
            expect(loadSessionCustomNames()).toEqual({ 's1': 'Existing' });
        });
    });

    describe('persistence aggregation', () => {
        it('should persist only the updated session when no other custom names exist', () => {
            const sessions = {
                's1': makeSession({ id: 's1' }),
                's2': makeSession({ id: 's2' })
            };
            const result = applyCustomNameUpdate(sessions, 's1', 'My Name');
            expect(result!.persisted).toEqual({ 's1': 'My Name' });
        });

        it('should preserve existing custom names for other sessions', () => {
            const sessions = {
                's1': makeSession({ id: 's1', customName: 'First' }),
                's2': makeSession({ id: 's2', customName: 'Second' }),
                's3': makeSession({ id: 's3' })
            };
            const result = applyCustomNameUpdate(sessions, 's1', 'Updated First');
            expect(result!.persisted).toEqual({
                's1': 'Updated First',
                's2': 'Second'
            });
        });

        it('should remove session from persistence when name is cleared', () => {
            const sessions = {
                's1': makeSession({ id: 's1', customName: 'First' }),
                's2': makeSession({ id: 's2', customName: 'Second' })
            };
            const result = applyCustomNameUpdate(sessions, 's1', null);
            expect(result!.persisted).toEqual({ 's2': 'Second' });
        });

        it('should persist empty object when last custom name is cleared', () => {
            const sessions = {
                's1': makeSession({ id: 's1', customName: 'Only Name' })
            };
            const result = applyCustomNameUpdate(sessions, 's1', '');
            expect(result!.persisted).toEqual({});
        });

        it('should write aggregated names to MMKV', () => {
            const sessions = {
                's1': makeSession({ id: 's1', customName: 'First' }),
                's2': makeSession({ id: 's2' })
            };
            applyCustomNameUpdate(sessions, 's2', 'Second');
            expect(loadSessionCustomNames()).toEqual({
                's1': 'First',
                's2': 'Second'
            });
        });
    });

    describe('session update', () => {
        it('should only modify the target session', () => {
            const sessions = {
                's1': makeSession({ id: 's1' }),
                's2': makeSession({ id: 's2' })
            };
            const result = applyCustomNameUpdate(sessions, 's1', 'New Name');
            expect(result!.sessions['s1'].customName).toBe('New Name');
            expect(result!.sessions['s2'].customName).toBeUndefined();
        });

        it('should not modify other session properties', () => {
            const original = makeSession({ id: 's1', metadata: { path: '/test', host: 'host' } });
            const sessions = { 's1': original };
            const result = applyCustomNameUpdate(sessions, 's1', 'Renamed');
            expect(result!.sessions['s1'].metadata).toEqual(original.metadata);
            expect(result!.sessions['s1'].id).toBe('s1');
            expect(result!.sessions['s1'].active).toBe(original.active);
        });
    });
});
