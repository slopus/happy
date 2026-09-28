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

it('shows that a failed turn still has a connected worker', () => {
    const session = {
        activeAt: 1,
        presence: 'online',
        thinking: false,
        agentState: { turnStatus: { status: 'failed', updatedAt: 1 } },
    } as Parameters<typeof useSessionStatus>[0];
    expect(useSessionStatus(session)).toMatchObject({
        state: 'failed',
        isConnected: true,
        statusText: 'status.failed · status.online',
    });
});

describe('useSessionStatus result synchronization', () => {
    const session = {
        activeAt: 1,
        presence: 'online',
        thinking: false,
        agentState: { turnStatus: { status: 'completed', updatedAt: 1 } },
    } as Parameters<typeof useSessionStatus>[0];

    it('shows pending results without changing the completed execution state', () => {
        expect(useSessionStatus(session, true)).toMatchObject({
            state: 'completed',
            isConnected: true,
            statusText: 'status.syncingResults',
            statusColor: '#007aff',
            statusDotColor: '#007aff',
            isPulsing: true,
        });
        expect(useSessionStatus(session, false)).toMatchObject({
            state: 'completed',
            statusText: 'status.completed',
            isPulsing: false,
        });
    });

    it('keeps offline information while waiting for completed results', () => {
        expect(useSessionStatus({ ...session, presence: 123 }, true)).toMatchObject({
            state: 'completed',
            isConnected: false,
            statusText: 'status.syncingResults · status.lastSeen',
        });
    });

    it.each([
        { state: 'running', thinking: true, agentState: session.agentState, label: 'status.running' },
        { state: 'failed', thinking: false, agentState: { turnStatus: { status: 'failed', updatedAt: 2 } }, label: 'status.failed · status.online' },
        { state: 'permission_required', thinking: false, agentState: { ...session.agentState, requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } }, label: 'status.permissionRequired' },
        { state: 'idle', thinking: false, agentState: null, label: 'status.idle' },
    ] as const)('preserves $state priority over result synchronization', ({ state, thinking, agentState, label }) => {
        expect(useSessionStatus({ ...session, thinking, agentState }, true)).toMatchObject({
            state,
            statusText: label,
        });
    });
});
