import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import type { SpawnSessionResult } from '@/sync/ops';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { useSpawnSession, type SpawnSessionArgs } from './useSpawnSession';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    spawnResult: { type: 'success', sessionId: 'session-1' } as SpawnSessionResult,
    machineSpawnNewSession: vi.fn(),
    refreshSession: vi.fn(),
    refreshSessions: vi.fn(),
    sendMessage: vi.fn(),
    navigateToSession: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    applySettings: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: mocks.machineSpawnNewSession,
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        refreshSession: mocks.refreshSession,
        refreshSessions: mocks.refreshSessions,
        sendMessage: mocks.sendMessage,
        applySettings: mocks.applySettings,
    },
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            updateSessionPermissionMode: mocks.updatePermission,
            updateSessionModelMode: mocks.updateModel,
            updateSessionEffortLevel: mocks.updateEffort,
            settings: {
                sidebarOrganization: {
                    lists: [{ id: 'happy-list', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'machine-1', path: '~/work', defaultAgent: 'codex', createdAt: 1 }],
                    tags: [],
                    sessions: {},
                },
            },
        }),
    },
}));
vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));
vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.alert,
        confirm: mocks.confirm,
    },
}));
vi.mock('@/text', () => ({
    t: (key: string) => key,
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
        happyCliVersion: '1.0.0',
        happyHomeDir: '/Users/jacky/.happy',
        homeDir: '/Users/jacky',
    },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 1,
};

const image = { id: 'image-1', uri: 'file:///image.png' } as AttachmentPreview;
const args: SpawnSessionArgs = {
    machineId: machine.id,
    machine,
    path: '~/work',
    agent: 'codex',
    worktreeKey: null,
    permissionMode: 'yolo',
    modelMode: 'default',
    effortLevel: null,
    prompt: 'Build it',
    images: [image],
};

type HookResult = ReturnType<typeof useSpawnSession>;

function renderHook(): { current: () => HookResult; unmount: () => void } {
    let result: HookResult | undefined;

    function HookHarness() {
        result = useSpawnSession();
        return null;
    }

    let renderer: { unmount: () => void } | undefined;
    act(() => {
        renderer = TestRenderer.create(React.createElement(HookHarness));
    });
    return {
        current: () => {
            if (!result) throw new Error('Hook did not render');
            return result;
        },
        unmount: () => act(() => renderer?.unmount()),
    };
}

describe('useSpawnSession', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.spawnResult = { type: 'success', sessionId: 'session-1' };
        mocks.machineSpawnNewSession.mockImplementation(async () => mocks.spawnResult);
        mocks.refreshSession.mockResolvedValue(true);
        mocks.refreshSessions.mockResolvedValue(undefined);
        mocks.sendMessage.mockResolvedValue(undefined);
        mocks.confirm.mockResolvedValue(false);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('creates and configures a session without sending or navigating from the core', async () => {
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawnSession(args);
        });

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/jacky/work',
            approvedNewDirectoryCreation: false,
            agent: 'codex',
            environmentVariables: undefined,
        });
        expect(mocks.refreshSession).toHaveBeenCalledWith('session-1');
        expect(mocks.refreshSessions).not.toHaveBeenCalled();
        expect(mocks.updatePermission).toHaveBeenCalledWith('session-1', 'yolo');
        expect(mocks.updateModel).toHaveBeenCalledWith('session-1', 'default');
        expect(mocks.updateEffort).toHaveBeenCalledWith('session-1', null);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('keeps the existing wrapper contract and sends/navigates exactly once', async () => {
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawn(args);
        });

        expect(result).toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', 'Build it', {
            source: 'new_session',
            attachments: [image],
        });
        expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-1');
        hook.unmount();
    });

    it('assigns a spawned session to the List supplied by the new-session route', async () => {
        const hook = renderHook();

        await act(async () => {
            await hook.current().spawnSession({ ...args, sidebarListId: 'happy-list' });
        });

        const list = { id: 'happy-list', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'machine-1', path: '~/work', defaultAgent: 'codex', folderId: null, createdAt: 1 };
        expect(mocks.applySettings).toHaveBeenCalledWith({
            sidebarOrganization: {
                folders: [],
                lists: [list],
                tags: [],
                sessions: { 'session-1': { listId: 'happy-list', tagIds: [] } },
            },
        });
        hook.unmount();
    });

    it('falls back to a full refresh when the spawned session is not yet visible', async () => {
        mocks.refreshSession.mockResolvedValue(false);
        const hook = renderHook();

        await act(async () => {
            await hook.current().spawnSession(args);
        });

        expect(mocks.refreshSession).toHaveBeenCalledWith('session-1');
        expect(mocks.refreshSessions).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('keeps sending true until the wrapper finishes its initial message', async () => {
        let resolveSend: (() => void) | undefined;
        let markSendStarted: (() => void) | undefined;
        const sendStarted = new Promise<void>((resolve) => {
            markSendStarted = resolve;
        });
        mocks.sendMessage.mockImplementation(() => {
            markSendStarted?.();
            return new Promise<void>((resolve) => {
                resolveSend = resolve;
            });
        });
        const hook = renderHook();
        let spawnPromise: Promise<boolean>;

        await act(async () => {
            spawnPromise = hook.current().spawn(args);
            await sendStarted;
        });

        expect(hook.current().sending).toBe(true);
        await act(async () => {
            resolveSend?.();
            await spawnPromise!;
        });
        expect(hook.current().sending).toBe(false);
        hook.unmount();
    });

    it('returns cancelled when directory creation is declined', async () => {
        mocks.spawnResult = { type: 'requestToApproveDirectoryCreation', directory: '/Users/jacky/new' };
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawnSession(args);
        });

        expect(result).toEqual({ type: 'cancelled' });
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.alert).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('retries once with approval when directory creation is accepted', async () => {
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/Users/jacky/new' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-approved' });
        mocks.confirm.mockResolvedValue(true);
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawnSession(args);
        });

        expect(result).toEqual({ type: 'success', sessionId: 'session-approved' });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(2);
        expect(mocks.machineSpawnNewSession.mock.calls[0][0].approvedNewDirectoryCreation).toBe(false);
        expect(mocks.machineSpawnNewSession.mock.calls[1][0].approvedNewDirectoryCreation).toBe(true);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('returns and reports an RPC error once', async () => {
        mocks.spawnResult = { type: 'error', errorMessage: 'RPC unavailable' };
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawnSession(args);
        });

        expect(result).toEqual({ type: 'error', message: 'RPC unavailable' });
        expect(mocks.alert).toHaveBeenCalledTimes(1);
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'RPC unavailable');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        hook.unmount();
    });
});
