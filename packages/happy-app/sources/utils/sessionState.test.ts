import { describe, expect, it, vi } from 'vitest';
import { AgentStateSchema } from '@/sync/storageTypes';
import { resolveSessionState } from './sessionUtils';

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { accent: '#007aff' } } }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('resolveSessionState', () => {
    it.each([
        {
            name: 'old schema without outcome',
            session: { presence: 'online' as const, thinking: false, agentState: {} },
            expected: { state: 'idle', isConnected: true },
        },
        {
            name: 'ephemeral activity',
            session: { presence: 'online' as const, thinking: true, agentState: {} },
            expected: { state: 'running', isConnected: true },
        },
        {
            name: 'persisted activity after reconnect',
            session: {
                presence: 'online' as const,
                thinking: false,
                agentState: { turnStatus: { status: 'running' as const, updatedAt: 1 } },
            },
            expected: { state: 'running', isConnected: true },
        },
        {
            name: 'stale running while disconnected',
            session: {
                presence: 123,
                thinking: false,
                agentState: { turnStatus: { status: 'running' as const, updatedAt: 1 } },
            },
            expected: { state: 'idle', isConnected: false },
        },
        {
            name: 'failed outcome',
            session: {
                presence: 'online' as const,
                thinking: false,
                agentState: { turnStatus: { status: 'failed' as const, updatedAt: 1 } },
            },
            expected: { state: 'failed', isConnected: true },
        },
        {
            name: 'completed outcome',
            session: {
                presence: 123,
                thinking: false,
                agentState: { turnStatus: { status: 'completed' as const, updatedAt: 1 } },
            },
            expected: { state: 'completed', isConnected: false },
        },
        {
            name: 'cancelled outcome',
            session: {
                presence: 'online' as const,
                thinking: false,
                agentState: { turnStatus: { status: 'cancelled' as const, updatedAt: 1 } },
            },
            expected: { state: 'idle', isConnected: true },
        },
    ])('$name', ({ session, expected }) => {
        expect(resolveSessionState(session)).toEqual(expected);
    });

    it('keeps a pending permission prominent while disconnected', () => {
        expect(resolveSessionState({
            presence: 123,
            thinking: false,
            agentState: {
                requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
                turnStatus: { status: 'running', updatedAt: 1 },
            },
        })).toEqual({ state: 'permission_required', isConnected: false });
    });
});

describe('AgentStateSchema turnStatus compatibility', () => {
    it('accepts old agent state and preserves the optional encrypted outcome beside permissions', () => {
        expect(AgentStateSchema.parse({ controlledByUser: false })).toEqual({ controlledByUser: false });
        expect(AgentStateSchema.parse({
            requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
            turnStatus: { status: 'failed', updatedAt: 2, turnId: 'turn-1' },
        })).toEqual({
            requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
            turnStatus: { status: 'failed', updatedAt: 2, turnId: 'turn-1' },
        });
    });
});
