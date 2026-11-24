import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import type { SpawnSessionResult } from '@/sync/ops';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { useSpawnSession, configureSpawnedSession, type SpawnSessionArgs } from './useSpawnSession';
import { resolveNewSessionSpawnSettings } from '@/utils/newSessionSpawnSettings';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { sessionStartupTraceRuntime } from '@/sync/sessionStartupTraceRuntime';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
    traceStartup: vi.fn(),
    runtimeEvents: [] as Array<{ stage: string; sessionId?: string }>,
    spawnResult: { type: 'success', sessionId: 'session-1' } as SpawnSessionResult,
    machineSpawnNewSession: vi.fn(),
    ensureSessionHydrated: vi.fn(),
    refreshSessions: vi.fn(),
    sendMessage: vi.fn(),
    awaitLocalMessageProjection: vi.fn(),
    navigateToSession: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    applySettings: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    prepareHandoff: vi.fn(),
    attachHandoff: vi.fn(),
}));

vi.mock('@/sync/sessionContextHandoff', () => ({
    prepareSessionContinuationContext: mocks.prepareHandoff,
    attachSessionContinuationContext: mocks.attachHandoff,
}));

vi.mock('expo-crypto', () => ({
    randomUUID: mocks.randomUUID,
}));
vi.mock('@/sync/sessionStartupTrace', () => ({
    traceStartup: mocks.traceStartup,
}));
vi.mock('@/sync/sessionStartupTraceRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/sessionStartupTraceRuntime')>();
    return {
        ...actual,
        sessionStartupTraceRuntime: actual.createWebStartupTraceRuntime((event) => mocks.runtimeEvents.push(event as { stage: string; sessionId?: string })),
    };
});

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: mocks.machineSpawnNewSession,
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionHydrated: mocks.ensureSessionHydrated,
        refreshSessions: mocks.refreshSessions,
        sendMessage: mocks.sendMessage,
        awaitLocalMessageProjection: mocks.awaitLocalMessageProjection,
        applySettings: mocks.applySettings,
    },
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            updateSessionPermissionMode: mocks.updatePermission,
            updateSessionModelMode: mocks.updateModel,
            updateSessionEffortLevel: mocks.updateEffort,
            updateSessionFastMode: vi.fn(),
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
    it('configures explicit native defaults that survive into the first outgoing message', () => {
        const session: any = { metadata: { flavor: 'codex' } };
        mocks.updateModel.mockImplementationOnce((_id, modelMode) => { session.modelMode = modelMode; });
        mocks.updateEffort.mockImplementationOnce((_id, effortLevel) => { session.effortLevel = effortLevel; });
        const launch = resolveNewSessionSpawnSettings({ draftWorktreeKey: null,
            resolvedModes: { modelMode: 'gpt-6.1-sol', effortLevel: 'high' },
            liveSelection: { modelKey: undefined, effortKey: null, worktreeKey: '__none__', fastMode: false } });
        configureSpawnedSession('new-native', launch);
        expect(resolveMessageModeMeta(session)).toMatchObject({ model: null, effort: null });
    });
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.traceStartup.mockReset();
        mocks.runtimeEvents = [];
        mocks.spawnResult = { type: 'success', sessionId: 'session-1' };
        mocks.machineSpawnNewSession.mockImplementation(async () => mocks.spawnResult);
        mocks.ensureSessionHydrated.mockResolvedValue(true);
        mocks.refreshSessions.mockResolvedValue(undefined);
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        mocks.awaitLocalMessageProjection.mockReset().mockResolvedValue(true);
        mocks.confirm.mockResolvedValue(false);
        mocks.prepareHandoff.mockReset().mockResolvedValue('Saved conversation: ORCHID-7392');
        mocks.attachHandoff.mockReset().mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        delete (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe;
    });

    it('snapshots source history before spawn and persists it before the first Antigravity message', async () => {
        const order: string[] = [];
        mocks.prepareHandoff.mockImplementationOnce(async () => { order.push('snapshot'); return 'ORCHID-7392'; });
        mocks.machineSpawnNewSession.mockImplementationOnce(async () => { order.push('spawn'); return mocks.spawnResult; });
        mocks.attachHandoff.mockImplementationOnce(async () => { order.push('attach'); });
        mocks.sendMessage.mockImplementationOnce(async () => {
            order.push('send');
            return { type: 'queued', sessionId: 'session-1', localIds: ['local-1'] };
        });
        const hook = renderHook();
        await act(async () => {
            expect(await hook.current().spawn({ ...args, agent: 'antigravity', images: [],
                continuationSourceSessionId: 'codex-source', prompt: 'What was the code?' })).toBe(true);
        });
        expect(order).toEqual(['snapshot', 'spawn', 'attach', 'send']);
        expect(mocks.attachHandoff).toHaveBeenCalledWith('session-1', 'codex-source', 'ORCHID-7392');
        expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', 'What was the code?', expect.any(Object));
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'antigravity' }));
        hook.unmount();
    });

    it('fails before spawning when source history cannot be read', async () => {
        mocks.prepareHandoff.mockRejectedValueOnce(new Error('continuation-history-unavailable'));
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn({ ...args, continuationSourceSessionId: 'source' })).toBe(false); });
        expect(mocks.machineSpawnNewSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('retries handoff persistence on the same worker without sending before it is saved', async () => {
        mocks.attachHandoff.mockRejectedValueOnce(new Error('synthetic-metadata-failure'));
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn({ ...args, continuationSourceSessionId: 'source' })).toBe(false); });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(hook.current().hydrationError).toEqual({ sessionId: 'session-1' });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.attachHandoff).toHaveBeenCalledTimes(2);
        expect(mocks.prepareHandoff).toHaveBeenCalledTimes(1);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('does not send an old draft if the composer unmounts while handoff persistence is pending', async () => {
        let release!: () => void;
        mocks.attachHandoff.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const hook = renderHook();
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.current().spawn({ ...args, continuationSourceSessionId: 'source' }); });
        expect(mocks.attachHandoff).toHaveBeenCalledOnce();
        hook.unmount();
        await act(async () => { release(); expect(await pending).toBe(false); });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
    });

    it('waits for receipt projection before transferring the draft and navigating once', async () => {
        const order: string[] = [];
        let resolveProjection!: (value: boolean) => void;
        mocks.sendMessage.mockImplementationOnce(async () => {
            order.push('receipt');
            return { type: 'queued', sessionId: 'session-1', localIds: ['local-1', 'local-2'] };
        });
        mocks.awaitLocalMessageProjection.mockImplementationOnce(() => new Promise<boolean>(resolve => {
            resolveProjection = value => { order.push('projection'); resolve(value); };
        }));
        mocks.navigateToSession.mockImplementationOnce(() => order.push('navigate'));
        const hook = renderHook();
        let spawning!: Promise<boolean>;
        await act(async () => { spawning = hook.current().spawn(args, false, () => order.push('draft-transfer')); });
        expect(order).toEqual(['receipt']);
        expect(mocks.awaitLocalMessageProjection).toHaveBeenCalledWith('session-1', ['local-1', 'local-2'], {
            type: 'queued', sessionId: 'session-1', localIds: ['local-1', 'local-2'],
        });
        await act(async () => { resolveProjection(true); expect(await spawning).toBe(true); });
        expect(order).toEqual(['receipt', 'projection', 'draft-transfer', 'navigate']);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('retries a failed projection with the original receipt without sending or navigating early', async () => {
        const receipt = { type: 'queued', sessionId: 'session-1', localIds: ['local-1'] };
        mocks.sendMessage.mockResolvedValueOnce(receipt);
        mocks.awaitLocalMessageProjection.mockResolvedValueOnce(false);
        const transferred = vi.fn();
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args, false, transferred)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'session-1' });
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(transferred).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.awaitLocalMessageProjection.mock.calls).toEqual([
            ['session-1', ['local-1'], receipt], ['session-1', ['local-1'], receipt],
        ]);
        expect(mocks.awaitLocalMessageProjection.mock.calls[1][2]).toBe(receipt);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        expect(transferred).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('retains the first created session after local queue failure and retries without respawning', async () => {
        mocks.sendMessage.mockRejectedValueOnce(new Error('synthetic-queue-failure'));
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'session-1' });
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.machineSpawnNewSession.mock.calls.length).toBe(1);
        expect(mocks.navigateToSession.mock.calls.length).toBe(1);
        hook.unmount();
    });

    it('coalesces repeated initial clicks while the first spawn RPC is pending', async () => {
        let release!: (value: unknown) => void;
        mocks.machineSpawnNewSession.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const hook = renderHook();
        let first!: Promise<boolean>;
        await act(async () => {
            first = hook.current().spawn(args);
            expect(await hook.current().spawn(args)).toBe(false);
        });
        await act(async () => { release({ type: 'success', sessionId: 'session-1' }); expect(await first).toBe(true); });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('binds the real browser trace only after navigation has a registered session id', async () => {
        // Catches a delayed ready event attaching before the spawn RPC supplies its session identity.
        let release!: (value: SpawnSessionResult) => void;
        mocks.machineSpawnNewSession.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        mocks.sendMessage.mockResolvedValue({ type: 'queued', sessionId: 'delayed-session', localIds: ['local-1'] });
        const hook = renderHook();
        let spawn!: Promise<boolean>;

        await act(async () => {
            spawn = hook.current().spawn(args);
            await Promise.resolve();
        });
        expect(sessionStartupTraceRuntime.markSessionStage(
            'delayed-session',
            'web.processor.ready_received',
            20,
        )).toBe(false);

        await act(async () => {
            release({ type: 'success', sessionId: 'delayed-session' });
            await spawn;
        });
        expect(mocks.navigateToSession).toHaveBeenCalledWith('delayed-session');
        expect(mocks.runtimeEvents.map((event) => event.stage)).not.toContain('web.processor.ready_received');

        const readyHandler = () => sessionStartupTraceRuntime.markSessionStage(
            'delayed-session',
            'web.processor.ready_received',
            30,
        );
        expect(readyHandler()).toBe(true);
        expect(mocks.runtimeEvents.map((event) => event.stage)).toContain('web.processor.ready_received');
        hook.unmount();
    });

    it('retries navigation without queuing an already accepted first message again', async () => {
        mocks.navigateToSession.mockImplementationOnce(() => { throw new Error('synthetic-navigation-failure'); });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'session-1' });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).toHaveBeenCalledTimes(2);
        hook.unmount();
    });

    it('does not navigate without an explicit successful local queue receipt', async () => {
        mocks.sendMessage.mockResolvedValue(undefined);
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(mocks.navigateToSession.mock.calls.length).toBe(0);
        hook.unmount();
    });

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
        expect(mocks.ensureSessionHydrated).toHaveBeenCalledWith('session-1');
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

        const list = { id: 'happy-list', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'machine-1', path: '~/work', defaultAgent: 'codex', createdAt: 1 };
        expect(mocks.applySettings).toHaveBeenCalledWith({
            sidebarOrganization: {
                lists: [list],
                tags: [],
                sessions: { 'session-1': { listId: 'happy-list', tagIds: [] } },
            },
        });
        hook.unmount();
    });

    it('does not refresh the account when one spawned session stays temporarily absent', async () => {
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        const hook = renderHook();
        let result;

        try {
            await act(async () => {
                const spawnPromise = hook.current().spawnSession(args);
                await vi.advanceTimersByTimeAsync(0);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(99);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(2);
                await vi.advanceTimersByTimeAsync(249);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(2);
                await vi.advanceTimersByTimeAsync(1);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(3);
                await vi.advanceTimersByTimeAsync(499);
                expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(3);
                await vi.advanceTimersByTimeAsync(1);
                result = await spawnPromise;
            });

            expect(result).toEqual({
                type: 'error',
                message: 'newSession.sessionHydrationFailed',
                sessionId: 'session-1',
            });
            expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(4);
            expect(mocks.ensureSessionHydrated).toHaveBeenNthCalledWith(4, 'session-1');
            expect(mocks.refreshSessions).not.toHaveBeenCalled();
            expect(mocks.updatePermission).not.toHaveBeenCalled();
            expect(mocks.sendMessage).not.toHaveBeenCalled();
            expect(mocks.navigateToSession).not.toHaveBeenCalled();
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('reports a real hydration retry without letting probe failure interrupt spawn', async () => {
        // Catches ensureSessionHydratedWithRetry hiding its second attempt from
        // the active spawn sample, or observability changing product behavior.
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockRejectedValueOnce(new Error('synthetic-hydration-failure')).mockResolvedValueOnce(true);
        let retryCount = 0;
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markRetry: (...args: unknown[]) => {
                expect(args).toEqual([]);
                retryCount += 1;
                throw new Error('private-probe-error');
            },
        };
        const hook = renderHook();

        try {
            let result;
            await act(async () => {
                const spawnPromise = hook.current().spawn(args);
                await vi.runAllTimersAsync();
                result = await spawnPromise;
            });

            expect(result).toBe(true);
            expect(retryCount).toBe(1);
            expect(mocks.ensureSessionHydrated).toHaveBeenCalledTimes(2);
            expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('creates one trace and keeps traced spawn, hydrate, configure, local queue, and navigation in order', async () => {
        const order: string[] = [];
        mocks.traceStartup.mockImplementation((event: { stage: string }) => {
            order.push(event.stage);
        });
        mocks.machineSpawnNewSession.mockImplementation(async () => {
            order.push('spawn');
            return { type: 'success', sessionId: 'session-1' };
        });
        mocks.ensureSessionHydrated.mockImplementation(async () => {
            order.push('hydrate');
            return true;
        });
        mocks.updatePermission.mockImplementation(() => order.push('configure'));
        mocks.sendMessage.mockImplementation(async () => {
            order.push('send');
            return { type: 'queued', sessionId: 'session-1', localIds: ['local-1'] };
        });
        mocks.navigateToSession.mockImplementation(() => order.push('navigate'));
        const hook = renderHook();

        await act(async () => {
            await hook.current().spawn(args);
        });

        expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
            traceId: '00000000-0000-4000-8000-000000000001',
        }));
        expect(order).toEqual([
            'web.spawn.clicked',
            'spawn',
            'hydrate',
            'web.session.hydrated',
            'configure',
            'send',
            'web.first_message.queued',
            'navigate',
            'web.session.navigated',
        ]);
        expect(mocks.traceStartup.mock.calls.map(([event]) => event)).toEqual([
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'web.spawn.clicked',
                machineId: 'machine-1',
                outcome: 'success',
            }),
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'web.session.hydrated',
                sessionId: 'session-1',
                machineId: 'machine-1',
                outcome: 'success',
            }),
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'web.first_message.queued',
                sessionId: 'session-1',
                machineId: 'machine-1',
                outcome: 'success',
            }),
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'web.session.navigated',
                sessionId: 'session-1',
                machineId: 'machine-1',
                outcome: 'success',
            }),
        ]);
        hook.unmount();
    });

    it('continues the spawn flow when startup tracing throws', async () => {
        mocks.traceStartup.mockImplementation(() => {
            throw new Error('trace-logger-failed');
        });
        const hook = renderHook();
        let result;

        await act(async () => {
            result = await hook.current().spawn(args);
        });

        expect(result).toBe(true);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-1');
        hook.unmount();
    });

    it('does not repeat hydration telemetry when message queue recovery is retried', async () => {
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        const hook = renderHook();

        try {
            await act(async () => {
                const spawnPromise = hook.current().spawn(args);
                await vi.runAllTimersAsync();
                await spawnPromise;
            });

            mocks.ensureSessionHydrated.mockResolvedValue(true);
            mocks.sendMessage.mockRejectedValueOnce(new Error('queue failed'));
            await act(async () => {
                expect(await hook.current().retryHydration()).toBe(false);
            });

            mocks.sendMessage.mockResolvedValueOnce({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
            await act(async () => {
                expect(await hook.current().retryHydration()).toBe(true);
            });

            const hydratedEvents = mocks.traceStartup.mock.calls
                .map(([event]) => event)
                .filter((event) => event.stage === 'web.session.hydrated');
            expect(hydratedEvents).toHaveLength(1);
            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('retries hydration without respawning and completes configure/send/navigation once', async () => {
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        const hook = renderHook();

        try {
            let firstResult;
            await act(async () => {
                const spawnPromise = hook.current().spawn(args);
                await vi.runAllTimersAsync();
                firstResult = await spawnPromise;
            });

            expect(firstResult).toBe(false);
            expect(hook.current().hydrationError).toEqual({ sessionId: 'session-1' });
            expect(mocks.updatePermission).not.toHaveBeenCalled();
            expect(mocks.sendMessage).not.toHaveBeenCalled();
            expect(mocks.navigateToSession).not.toHaveBeenCalled();

            mocks.ensureSessionHydrated.mockResolvedValue(true);
            let retryResult;
            await act(async () => {
                retryResult = await hook.current().retryHydration();
            });

            expect(retryResult).toBe(true);
            expect(hook.current().hydrationError).toBeNull();
            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(mocks.updatePermission).toHaveBeenCalledTimes(1);
            expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
            expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', 'Build it', {
                source: 'new_session',
                attachments: [image],
            });
            expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);

            await act(async () => {
                await hook.current().retryHydration();
            });
            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(mocks.updatePermission).toHaveBeenCalledTimes(1);
            expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('counts explicit hydration recovery before its first internal attempt', async () => {
        // Catches retryHydration resetting the helper's attempt index and
        // hiding the user-visible retry when that new call succeeds at once.
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        let retryCount = 0;
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markRetry: () => { retryCount += 1; },
        };
        const hook = renderHook();

        try {
            await act(async () => {
                const spawnPromise = hook.current().spawn(args);
                await vi.runAllTimersAsync();
                await spawnPromise;
            });
            expect(retryCount).toBe(3);

            mocks.ensureSessionHydrated.mockResolvedValue(true);
            await act(async () => {
                expect(await hook.current().retryHydration()).toBe(true);
            });
            expect(retryCount).toBe(4);
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('coalesces concurrent recovery actions into one queued message and navigation', async () => {
        vi.useFakeTimers();
        mocks.ensureSessionHydrated.mockResolvedValue(false);
        const hook = renderHook();

        try {
            await act(async () => {
                const spawnPromise = hook.current().spawn(args);
                await vi.runAllTimersAsync();
                await spawnPromise;
            });

            let resolveHydration: ((hydrated: boolean) => void) | undefined;
            mocks.ensureSessionHydrated.mockImplementation(() => new Promise<boolean>((resolve) => {
                resolveHydration = resolve;
            }));
            let firstRetry!: Promise<boolean>;
            let secondResult;
            await act(async () => {
                firstRetry = hook.current().retryHydration();
                await Promise.resolve();
                secondResult = await hook.current().retryHydration();
            });

            expect(secondResult).toBe(false);
            await act(async () => {
                resolveHydration?.(true);
                await firstRetry;
            });

            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession).toHaveBeenCalledTimes(1);
        } finally {
            hook.unmount();
            vi.useRealTimers();
        }
    });

    it('keeps sending true until the wrapper finishes its initial message', async () => {
        let resolveSend: (() => void) | undefined;
        let markSendStarted: (() => void) | undefined;
        const sendStarted = new Promise<void>((resolve) => {
            markSendStarted = resolve;
        });
        mocks.sendMessage.mockImplementation(() => {
            markSendStarted?.();
            return new Promise((resolve) => {
                resolveSend = () => resolve({ type: 'queued', sessionId: 'session-1', localIds: ['local-1'] });
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

    it('reuses one wrapper trace when approved directory creation retries the spawn RPC', async () => {
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/Users/jacky/new' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-approved' });
        mocks.confirm.mockResolvedValue(true);
        const hook = renderHook();

        await act(async () => {
            await hook.current().spawn({ ...args, prompt: '', images: undefined });
        });

        expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
        expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(2);
        expect(mocks.machineSpawnNewSession.mock.calls[0][0].traceId).toBe('00000000-0000-4000-8000-000000000001');
        expect(mocks.machineSpawnNewSession.mock.calls[1][0].traceId).toBe('00000000-0000-4000-8000-000000000001');
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
