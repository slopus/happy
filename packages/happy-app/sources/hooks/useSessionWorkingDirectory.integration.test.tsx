import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/storageTypes';
import { useSessionWorkingDirectory } from './useSessionWorkingDirectory';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    refreshSessions: vi.fn(),
    navigateToSession: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    updateDraft: vi.fn(),
}));

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { machineRPC: mocks.machineRPC },
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionHydrated: mocks.ensureSessionHydrated,
        refreshSessions: mocks.refreshSessions,
    },
}));
vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));

const machine: Machine = {
    id: 'machine-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: {
        host: 'mac',
        platform: 'darwin',
        happyCliVersion: '1.2.3',
        happyHomeDir: '/Users/test/.happy',
        homeDir: '/Users/test',
    },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 1,
};

const session: Session = {
    id: 'session-codex',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: {
        path: '/Users/test/current',
        host: 'mac',
        machineId: machine.id,
        homeDir: '/Users/test',
        flavor: 'codex',
        codexThreadId: 'thread-source',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
};

vi.mock('@/sync/storage', () => ({
    useMachine: () => machine,
    useAllSessions: () => [],
    storage: {
        getState: () => ({
            sessions: {},
            updateSessionPermissionMode: mocks.updatePermission,
            updateSessionModelMode: mocks.updateModel,
            updateSessionEffortLevel: mocks.updateEffort,
            updateSessionDraft: mocks.updateDraft,
        }),
    },
}));

type HookResult = ReturnType<typeof useSessionWorkingDirectory>;

function renderHook(): { current: () => HookResult; unmount: () => void } {
    let result: HookResult | undefined;

    function Harness() {
        result = useSessionWorkingDirectory(session, () => 'preserved draft');
        return null;
    }

    let renderer: { unmount: () => void } | undefined;
    act(() => {
        renderer = TestRenderer.create(React.createElement(Harness));
    });
    return {
        current: () => {
            if (!result) throw new Error('Hook did not render');
            return result;
        },
        unmount: () => act(() => renderer?.unmount()),
    };
}

describe('working-directory continuation hydration integration', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        mocks.machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'browseDirectory') {
                return {
                    success: true,
                    path: '/Users/test/next',
                    parent: '/Users/test',
                    home: '/Users/test',
                    directories: [],
                };
            }
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-forked' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'session-delayed' };
            }
            throw new Error(`unexpected method ${method}`);
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
    });

    it('runs one four-attempt schedule and stops before config, draft mutation, or navigation', async () => {
        vi.useFakeTimers();
        const hook = renderHook();
        let result;

        try {
            await act(async () => {
                const switchPromise = hook.current().switchDirectory('/Users/test/next');
                await vi.runAllTimersAsync();
                result = await switchPromise;
            });

            expect(result).toEqual({ success: false, error: 'session-hydration-failed' });
            expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(4);
            expect(mocks.refreshSessions).not.toHaveBeenCalled();
            expect(mocks.updatePermission).not.toHaveBeenCalled();
            expect(mocks.updateModel).not.toHaveBeenCalled();
            expect(mocks.updateEffort).not.toHaveBeenCalled();
            expect(mocks.updateDraft).not.toHaveBeenCalled();
            expect(mocks.navigateToSession).not.toHaveBeenCalled();
        } finally {
            hook.unmount();
        }
    });
});
