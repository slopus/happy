import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { useSessionQuickActions } from './useSessionQuickActions';

const mocks = vi.hoisted(() => ({
    connected: false,
    online: true,
    latestSession: undefined as Session | undefined,
    restore: vi.fn(),
    resume: vi.fn(),
    refresh: vi.fn(),
    navigate: vi.fn(),
    alert: vi.fn(),
    success: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
}));
vi.mock('@/sync/ops', () => ({
    sessionRestoreMetadata: mocks.restore,
    machineResumeSession: mocks.resume,
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: mocks.refresh } }));
vi.mock('@/sync/storage', () => ({
    useMachine: () => ({ id: 'machine-1', metadata: {} }),
    useSetting: () => false,
    storage: { getState: () => ({ settings: {},
        sessions: { 'original-session': mocks.latestSession },
        machines: { 'machine-1': { id: 'machine-1', metadata: {} } },
        updateSessionPermissionMode: mocks.updatePermission,
        updateSessionModelMode: mocks.updateModel,
        updateSessionEffortLevel: mocks.updateEffort,
    }) },
}));
vi.mock('@/utils/sessionUtils', () => ({
    useSessionStatus: () => ({ isConnected: mocks.connected, state: 'idle' }),
    getSessionName: () => 'Archived task',
}));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => mocks.online }));
vi.mock('@/sync/messageMeta', () => ({
    resolveMessageModeMeta: () => ({ model: 'gpt-6.1-sol', permissionMode: 'yolo', effort: 'xhigh' }),
}));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/hooks/useWorktreeCleanup', () => ({ maybeCleanupWorktree: vi.fn() }));
vi.mock('@/hooks/useSessionManagementPreferences', () => ({
    useSessionManagementPreferences: () => ({ isPinned: () => false, togglePinned: vi.fn() }),
}));
vi.mock('@/sync/sessionContinuation', () => ({ createSessionContinuation: vi.fn() }));
vi.mock('@/utils/copySessionMetadataToClipboard', () => ({}));
vi.mock('@/utils/sessionFork', () => ({ getSessionForkSource: () => null }));
vi.mock('@/utils/sessionTitleRegeneration', () => ({ canRegenerateSessionTitle: () => false }));
vi.mock('@/utils/messageForkPoint', () => ({}));
vi.mock('@/components/DuplicateSheet', () => ({ DuplicateSheet: () => null }));
vi.mock('@/components/haptics', () => ({ hapticsSuccess: mocks.success }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const session = {
    id: 'original-session', metadataVersion: 4,
    presence: 1,
    metadata: { machineId: 'machine-1', path: '/project', flavor: 'codex',
        codexThreadId: 'original-thread', lifecycleState: 'archived' },
    permissionMode: 'yolo', modelMode: 'gpt-6.1-sol', effortLevel: 'xhigh',
} as Session;

let renderer: { unmount: () => void };
let actions: ReturnType<typeof useSessionQuickActions>;
function mount(target = session) {
    function Harness() { actions = useSessionQuickActions(target); return null; }
    act(() => { renderer = TestRenderer.create(React.createElement(Harness)); });
}
async function restore() {
    await act(async () => { actions.restoreSession(); });
}

describe('restoring archived sessions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.connected = false;
        mocks.online = true;
        mocks.latestSession = session;
        mocks.restore.mockResolvedValue({ version: 5 });
        mocks.resume.mockResolvedValue({ type: 'success', sessionId: session.id });
        mocks.refresh.mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const original = console.error;
        vi.spyOn(console, 'error').mockImplementation((...args) => {
            if (String(args[0]).startsWith('react-test-renderer is deprecated')) return;
            original(...args);
        });
    });
    afterEach(() => { act(() => renderer?.unmount()); vi.restoreAllMocks(); });

    it('reconnects the original worker with its modes after restoring list membership', async () => {
        mount();
        await restore();
        expect(mocks.resume).toHaveBeenCalledWith({ machineId: 'machine-1', sessionId: 'original-session',
            agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'yolo', effort: 'xhigh' });
        expect(mocks.restore.mock.invocationCallOrder[0]).toBeLessThan(mocks.resume.mock.invocationCallOrder[0]);
        expect(mocks.navigate).toHaveBeenCalledWith('original-session');
        expect(mocks.updateModel).toHaveBeenCalledWith('original-session', 'gpt-6.1-sol');
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('waits for reconnection before announcing restore success', async () => {
        let finish!: (value: unknown) => void;
        mocks.resume.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        mount();
        await restore();
        expect(actions.restoringSession).toBe(true);
        expect(mocks.success).not.toHaveBeenCalled();
        await act(async () => { finish({ type: 'success', sessionId: session.id }); });
        expect(actions.restoringSession).toBe(false);
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('reports resume failure so an unarchived but disconnected chat is not presented as ready', async () => {
        mocks.resume.mockResolvedValue({ type: 'error', errorMessage: 'Original thread unavailable' });
        mount();
        await restore();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'Original thread unavailable', expect.any(Array));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it.each(['online-worker', 'offline-machine', 'no-backend-id'] as const)(
        'restores metadata without restarting an unavailable or warm worker: %s', async kind => {
            mocks.connected = kind === 'online-worker';
            mocks.online = kind !== 'offline-machine';
            const target = kind === 'no-backend-id'
                ? { ...session, metadata: { ...session.metadata!, codexThreadId: undefined } } : session;
            mount(target);
            await restore();
            expect(mocks.restore).toHaveBeenCalledOnce();
            expect(mocks.refresh).toHaveBeenCalled();
            expect(mocks.resume).not.toHaveBeenCalled();
        },
    );

    it('does not start a worker when restoring metadata failed', async () => {
        mocks.restore.mockRejectedValue(new Error('Version conflict'));
        mount();
        await restore();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalled();
    });

    it('preserves a worker that reconnected while the restore was refreshing', async () => {
        mocks.refresh.mockImplementationOnce(async () => {
            mocks.latestSession = { ...session, presence: 'online', thinking: true };
        });
        mount();
        await restore();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('does not resume if the machine went offline during the metadata restore', async () => {
        mocks.refresh.mockImplementationOnce(async () => { mocks.online = false; });
        mount();
        await restore();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalled();
    });
});
