import { describe, expect, it, vi } from 'vitest';
import { AgentStateSchema } from '@/sync/storageTypes';
import { resolveSessionState, useSessionStatus } from './sessionUtils';

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { accent: '#007aff' } } }),
}));
vi.mock('@/text', () => ({
    t: (key: string, values?: { count?: number }) => key === 'status.queued'
        ? `${values?.count} queued`
        : key,
}));

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
            name: 'queued follow-up after a stale completed outcome',
            session: {
                presence: 'online' as const,
                thinking: false,
                agentState: {
                    queuedMessages: 1,
                    turnStatus: { status: 'completed' as const, updatedAt: 1 },
                },
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
            queuedMessages: 2,
            turnStatus: { status: 'failed', updatedAt: 2, turnId: 'turn-1' },
        })).toEqual({
            requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
            queuedMessages: 2,
            turnStatus: { status: 'failed', updatedAt: 2, turnId: 'turn-1' },
        });
    });
});

describe('useSessionStatus queue label priority', () => {
    const session = {
        activeAt: 1,
        presence: 'online',
        thinking: false,
        agentState: {
            queuedMessages: 1,
            turnStatus: { status: 'completed', updatedAt: 1 },
        },
    } as Parameters<typeof useSessionStatus>[0];

    it('shows the queue label over a stale completed outcome', () => {
        expect(useSessionStatus(session)).toMatchObject({
            state: 'running',
            statusText: '1 queued',
        });
    });

    it('keeps a permission request more prominent than the queue label', () => {
        expect(useSessionStatus({
            ...session,
            agentState: {
                ...session.agentState,
                requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
            },
        })).toMatchObject({
            state: 'permission_required',
            statusText: 'status.permissionRequired',
        });
    });
});
