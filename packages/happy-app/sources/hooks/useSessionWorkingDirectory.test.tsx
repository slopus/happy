import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/storageTypes';
import { useSessionWorkingDirectory } from './useSessionWorkingDirectory';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    machineBrowseDirectory: vi.fn(),
    forkAndSpawn: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    navigateToSession: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    refreshSessions: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    updateDraft: vi.fn(),
    machine: null as Machine | null,
    sessions: [] as Session[],
    sessionsById: {} as Record<string, Session>,
}));

vi.mock('@/sync/ops', () => ({
    machineBrowseDirectory: mocks.machineBrowseDirectory,
    forkAndSpawn: mocks.forkAndSpawn,
    machineSpawnNewSession: mocks.machineSpawnNewSession,
}));
vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionHydrated: mocks.ensureSessionHydrated,
        refreshSessions: mocks.refreshSessions,
    },
}));
vi.mock('@/sync/storage', () => ({
    useMachine: () => mocks.machine,
    useAllSessions: () => mocks.sessions,
    storage: {
        getState: () => ({
            sessions: mocks.sessionsById,
            updateSessionPermissionMode: mocks.updatePermission,
            updateSessionModelMode: mocks.updateModel,
            updateSessionEffortLevel: mocks.updateEffort,
            updateSessionDraft: mocks.updateDraft,
        }),
    },
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

function makeSession(flavor: string): Session {
    return {
        id: `session-${flavor}`,
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
            flavor,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

type HookResult = ReturnType<typeof useSessionWorkingDirectory>;

function renderHook(session: Session): { current: () => HookResult; unmount: () => void } {
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

describe('useSessionWorkingDirectory continuation safety', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.machine = machine;
        mocks.sessions = [];
        mocks.sessionsById = {};
        mocks.machineBrowseDirectory.mockResolvedValue({
            success: true,
            path: '/Users/test/next',
            parent: '/Users/test',
            home: '/Users/test',
            directories: [],
        });
        mocks.ensureSessionHydrated.mockResolvedValue(true);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it.each(['codex', 'claude'])('does not spawn or navigate when %s continuation metadata is missing', async (flavor) => {
        const hook = renderHook(makeSession(flavor));
        let result;

        await act(async () => {
            result = await hook.current().switchDirectory('/Users/test/next');
        });

        expect(result).toEqual({ success: false, error: 'continuation-unavailable' });
        expect(mocks.forkAndSpawn).not.toHaveBeenCalled();
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(mocks.ensureSessionHydrated).not.toHaveBeenCalled();
        expect(mocks.refreshSessions).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        hook.unmount();
    });

    it.each([
        ['codex', 'codexThreadId', 'codex-thread-1'],
        ['claude', 'claudeSessionId', 'claude-session-1'],
    ] as const)('does not hydrate twice after a successful %s context continuation', async (
        flavor,
        providerIdKey,
        providerId,
    ) => {
        const session = makeSession(flavor);
        session.metadata![providerIdKey] = providerId;
        mocks.sessionsById['session-continued'] = makeSession(flavor);
        mocks.forkAndSpawn.mockResolvedValue({ type: 'success', sessionId: 'session-continued' });
        const hook = renderHook(session);
        let result;

        await act(async () => {
            result = await hook.current().switchDirectory('/Users/test/next');
        });

        expect(result).toEqual({
            success: true,
            changed: true,
            path: '/Users/test/next',
        });
        expect(mocks.forkAndSpawn).toHaveBeenCalledWith(
            expect.objectContaining({ kind: flavor }),
            { targetDirectory: '/Users/test/next' },
        );
        expect(mocks.ensureSessionHydrated).not.toHaveBeenCalled();
        expect(mocks.refreshSessions).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-continued');
        hook.unmount();
    });

    it.each([
        ['codex', 'codexThreadId', 'codex-thread-1'],
        ['claude', 'claudeSessionId', 'claude-session-1'],
    ] as const)('does not start a second hydration schedule after an exhausted %s continuation', async (
        flavor,
        providerIdKey,
        providerId,
    ) => {
        const session = makeSession(flavor);
        session.metadata![providerIdKey] = providerId;
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        mocks.forkAndSpawn.mockImplementation(async () => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                await mocks.ensureSessionHydrated('session-delayed');
            }
            return {
                type: 'error',
                errorCode: 'session-hydration-failed',
                errorMessage: 'session-hydration-failed',
                sessionId: 'session-delayed',
            };
        });
        const hook = renderHook(session);
        let result;

        await act(async () => {
            result = await hook.current().switchDirectory('/Users/test/next');
        });

        expect(result).toEqual({ success: false, error: 'session-hydration-failed' });
        expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(4);
        expect(mocks.refreshSessions).not.toHaveBeenCalled();
        expect(mocks.updatePermission).not.toHaveBeenCalled();
        expect(mocks.updateModel).not.toHaveBeenCalled();
        expect(mocks.updateEffort).not.toHaveBeenCalled();
        expect(mocks.updateDraft).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('keeps same-type fresh-session switching for Agents without provider continuation support', async () => {
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-next' });
        const hook = renderHook(makeSession('gemini'));

        await act(async () => {
            await hook.current().switchDirectory('/Users/test/next');
        });

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test/next',
            approvedNewDirectoryCreation: false,
            agent: 'gemini',
            parentSessionId: 'session-gemini',
        });
        expect(mocks.forkAndSpawn).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-next');
        hook.unmount();
    });

    it('bounds targeted hydration and never refreshes the account for a fresh-session switch', async () => {
        vi.useFakeTimers();
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-delayed' });
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        const hook = renderHook(makeSession('gemini'));

        try {
            let result;
            await act(async () => {
                const switchPromise = hook.current().switchDirectory('/Users/test/next');
                await vi.runAllTimersAsync();
                result = await switchPromise;
            });

            expect(result).toEqual({ success: false, error: 'session-hydration-failed' });
            expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(4);
            expect(mocks.refreshSessions).not.toHaveBeenCalled();
            expect(mocks.updateDraft).not.toHaveBeenCalled();
            expect(mocks.navigateToSession).not.toHaveBeenCalled();
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });
});
