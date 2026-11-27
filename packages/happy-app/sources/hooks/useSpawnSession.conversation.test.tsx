import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { portableNativeSourceIdentity } from '@slopus/happy-wire';
import { useSpawnSession, type SpawnSessionArgs } from './useSpawnSession';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    prepare: vi.fn(), reserve: vi.fn(), releaseReservation: vi.fn(), claim: vi.fn(), release: vi.fn(), commit: vi.fn(),
    prepareContext: vi.fn(), preview: vi.fn(), scope: vi.fn(), attachContext: vi.fn(), spawn: vi.fn(), spawnConversation: vi.fn(), cancelConversation: vi.fn(), online: vi.fn(), hydrate: vi.fn(),
    sessions: {} as Record<string, any>,
    send: vi.fn(), project: vi.fn(), confirmDelivery: vi.fn(), navigate: vi.fn(), alert: vi.fn(),
}));
vi.mock('@/sync/conversationSwitch', () => ({
    prepareConversationSwitch: mocks.prepare, claimConversationSwitch: mocks.claim,
    releaseConversationSwitch: mocks.release, commitConversationSwitch: mocks.commit,
    reserveConversationSwitch: mocks.reserve, releaseConversationSwitchReservation: mocks.releaseReservation,
}));
vi.mock('@/sync/sessionContextHandoff', () => ({
    prepareSessionContinuationContext: mocks.prepareContext, attachSessionContinuationContext: mocks.attachContext,
    buildPortableContextPreview: mocks.preview,
    assertPortableContextSourceScope: mocks.scope,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'switch-request' }));
vi.mock('@/sync/sessionStartupTrace', () => ({ traceStartup: vi.fn() }));
vi.mock('@/sync/sessionStartupTraceRuntime', () => ({ sessionStartupTraceRuntime: {
    begin: vi.fn(() => 'trace'), bindSession: vi.fn(), cancel: vi.fn(),
} }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: mocks.spawn, machineSpawnConversationSession: mocks.spawnConversation, machineCancelConversationLaunch: mocks.cancelConversation }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: mocks.online }));
vi.mock('@/sync/sync', () => ({ sync: {
    ensureSessionHydrated: mocks.hydrate, sendMessage: mocks.send,
    awaitLocalMessageProjection: mocks.project, awaitConversationHandoffDelivery: mocks.confirmDelivery,
} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
    sessions: mocks.sessions,
    updateSessionPermissionMode: vi.fn(), updateSessionModelMode: vi.fn(),
    updateSessionEffortLevel: vi.fn(), updateSessionFastMode: vi.fn(),
}) } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert, confirm: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}
const machine = { id: 'machine', active: true, activeAt: Date.now(), metadata: { homeDir: '/Users/test', host: 'mac' } } as Machine;
const args: SpawnSessionArgs = {
    machineId: 'machine', machine, path: '/project', agent: 'antigravity', worktreeKey: null,
    prompt: 'Continue the parser fix.', continuationSourceSessionId: 'source', continueInCurrentConversation: true,
};
const record = { rootId: 'root', sourceId: 'source', targetId: 'target', requestId: 'switch-request' };
const prepared = { context: 'Earlier task context.', archive: { snapshot: { items: [], heads: [] } }, sha256: 'hash' };
type HookResult = ReturnType<typeof useSpawnSession>;
function renderHook() {
    let result: HookResult | undefined;
    function Harness() { result = useSpawnSession(); return null; }
    let renderer!: { unmount: () => void };
    act(() => { renderer = TestRenderer.create(React.createElement(Harness)); });
    return {
        current: () => { if (!result) throw new Error('Hook did not render'); return result; },
        unmount: () => act(() => renderer.unmount()),
    };
}
beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.prepare.mockResolvedValue('root'); mocks.prepareContext.mockResolvedValue(prepared);
    mocks.online.mockReturnValue(true); mocks.sessions = {};
    mocks.cancelConversation.mockResolvedValue({ success: true, cancelled: true, targetSessionId: 'target' });
    mocks.preview.mockReturnValue('Incremental context.');
    mocks.claim.mockResolvedValue(undefined); mocks.release.mockResolvedValue(undefined); mocks.commit.mockResolvedValue(undefined);
    mocks.attachContext.mockResolvedValue(undefined); mocks.spawn.mockResolvedValue({ type: 'success', sessionId: 'target' });
    mocks.spawnConversation.mockResolvedValue({ type: 'success', sessionId: 'target' });
    mocks.hydrate.mockResolvedValue(true); mocks.send.mockResolvedValue({ type: 'queued', sessionId: 'target', localIds: ['prompt-1'] });
    mocks.project.mockResolvedValue(true); mocks.confirmDelivery.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('same-conversation handoff lifetimes', () => {
    it('releases a claim that finishes after unmount before any prompt was attempted', async () => {
        const claim = deferred(); mocks.claim.mockReturnValueOnce(claim.promise);
        const cleanupDraft = vi.fn(); const hook = renderHook(); let operation!: Promise<boolean>;
        await act(async () => { operation = hook.current().spawn(args, false, cleanupDraft); });
        expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining(record)); expect(mocks.send).not.toHaveBeenCalled();
        hook.unmount();
        await act(async () => { claim.resolve(); expect(await operation).toBe(false); });
        expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining(record));
        expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
        expect(cleanupDraft).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
    });
    it('waits for server delivery before clearing the source draft or publishing the new executor', async () => {
        const delivery = deferred(); mocks.confirmDelivery.mockReturnValueOnce(delivery.promise);
        const order: string[] = []; mocks.commit.mockImplementation(async () => { order.push('publish'); });
        const cleanupDraft = vi.fn(() => { order.push('clear'); }); const hook = renderHook(); let operation!: Promise<boolean>;
        await act(async () => { operation = hook.current().spawn(args, false, cleanupDraft); });
        expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.confirmDelivery).toHaveBeenCalledWith('target', 'source');
        expect(mocks.commit).not.toHaveBeenCalled(); expect(cleanupDraft).not.toHaveBeenCalled();
        await act(async () => { order.push('server-saved'); delivery.resolve(); expect(await operation).toBe(true); });
        expect(order).toEqual(['server-saved', 'clear', 'publish']); expect(mocks.send).toHaveBeenCalledOnce();
        expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining(record)); expect(cleanupDraft).toHaveBeenCalledOnce();
        expect(mocks.navigate).not.toHaveBeenCalled(); hook.unmount();
    });
    it('rechecks delivery on the same accepted receipt after a confirmation failure', async () => {
        mocks.confirmDelivery.mockRejectedValueOnce(new Error('server-confirmation-unavailable'));
        const cleanupDraft = vi.fn(); const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args, false, cleanupDraft)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'target' });
        expect(cleanupDraft).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.spawnConversation).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
        expect(mocks.confirmDelivery).toHaveBeenCalledTimes(2); expect(mocks.commit).toHaveBeenCalledOnce();
        expect(cleanupDraft).toHaveBeenCalledOnce(); hook.unmount();
    });
    it('releases an atomically rejected local send and retries the same candidate instead of locking the chat', async () => {
        mocks.send.mockRejectedValueOnce(new Error('attachment-upload-rejected-before-outbox'));
        const cleanupDraft = vi.fn(); const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args, false, cleanupDraft)).toBe(false); });
        expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining(record));
        expect(cleanupDraft).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.spawnConversation).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledTimes(2);
        expect(mocks.send).toHaveBeenCalledTimes(2); expect(mocks.commit).toHaveBeenCalledOnce();
        expect(cleanupDraft).toHaveBeenCalledOnce(); hook.unmount();
    });
    it('keeps the claim when unmount happens after prompt sending has begun', async () => {
        const sending = deferred<{ type: 'queued'; sessionId: string; localIds: string[] }>(); mocks.send.mockReturnValueOnce(sending.promise);
        const cleanupDraft = vi.fn(); const hook = renderHook(); let operation!: Promise<boolean>;
        await act(async () => { operation = hook.current().spawn(args, false, cleanupDraft); });
        expect(mocks.send).toHaveBeenCalledOnce(); hook.unmount();
        await act(async () => {
            sending.resolve({ type: 'queued', sessionId: 'target', localIds: ['prompt-1'] }); expect(await operation).toBe(false);
        });
        expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
        expect(cleanupDraft).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
    });
    it('reserves before the daemon launch and snapshots after native restoration', async () => {
        const order: string[] = [];
        const metadata = { machineId: 'machine', path: '/project', flavor: 'claude' };
        mocks.sessions = { source: { metadata } };
        const scoped = { ...prepared, archive: { snapshot: { heads: [{ sessionId: 'frozen-prefix', throughSeq: 5, afterSeq: 0 }, { sessionId: 'source', throughSeq: 1, afterSeq: 0 }], items: [] } } };
        mocks.reserve.mockImplementation(async () => { order.push('reserve'); });
        mocks.spawnConversation.mockImplementation(async () => { order.push('restored'); return { type: 'success', sessionId: 'target',
            nativeResume: { sourceSessionId: 'old-native-segment', coverage: [{ sessionId: 'old-native-segment', throughSeq: 8, afterSeq: 0 }],
                contextSources: [{ sessionId: 'source', identity: portableNativeSourceIdentity(metadata) }], contextEpoch: null } }; });
        mocks.prepareContext.mockImplementation(async () => { order.push('snapshot'); return scoped; });
        mocks.attachContext.mockImplementation(async () => { order.push('archive'); });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(true); });
        expect(order).toEqual(['reserve', 'restored', 'snapshot', 'archive']);
        expect(mocks.preview).toHaveBeenCalledWith(scoped.archive.snapshot, [{ sessionId: 'old-native-segment', throughSeq: 8, afterSeq: 0 }]);
        expect(mocks.attachContext).toHaveBeenCalledWith('target', 'source', { ...scoped, context: 'Incremental context.' });
        expect(mocks.spawn).not.toHaveBeenCalled(); hook.unmount();
    });
    it('retries an uncertain launch using the same durable request and sends only after a registered target exists', async () => {
        mocks.spawnConversation.mockResolvedValueOnce({ type: 'error', errorMessage: 'startup acknowledgement lost', outcomeUnknown: true });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'root' });
        expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.releaseReservation).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.reserve).toHaveBeenCalledOnce();
        expect(mocks.spawnConversation.mock.calls[0][0]).toEqual(mocks.spawnConversation.mock.calls[1][0]);
        expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.commit).toHaveBeenCalledOnce(); hook.unmount();
    });
    it('releases a targetless reservation only after a known pre-dispatch rejection', async () => {
        mocks.spawnConversation.mockResolvedValueOnce({ type: 'error', notDispatched: true, errorMessage: 'account unavailable' });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(mocks.releaseReservation).toHaveBeenCalledWith({ rootId: 'root', sourceId: 'source', requestId: 'switch-request' });
        expect(hook.current().hydrationError).toBeNull(); expect(mocks.send).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(true); });
        expect(mocks.spawnConversation).toHaveBeenCalledTimes(2); expect(mocks.send).toHaveBeenCalledOnce(); hook.unmount();
    });
    it('keeps a created candidate when snapshot collection fails and retries without another native launch', async () => {
        mocks.prepareContext.mockRejectedValueOnce(new Error('history-read-unavailable'));
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(hook.current().hydrationError).toEqual({ sessionId: 'target' }); expect(mocks.send).not.toHaveBeenCalled();
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.spawnConversation).toHaveBeenCalledOnce(); expect(mocks.prepareContext).toHaveBeenCalledTimes(2);
        expect(mocks.send).toHaveBeenCalledOnce(); hook.unmount();
    });
    it('releases an acknowledged pre-spawn reservation when its composer unmounts', async () => {
        const reserve = deferred(); mocks.reserve.mockReturnValueOnce(reserve.promise);
        const hook = renderHook(); let operation!: Promise<boolean>;
        await act(async () => { operation = hook.current().spawn(args); });
        hook.unmount();
        await act(async () => { reserve.resolve(); expect(await operation).toBe(false); });
        expect(mocks.releaseReservation).toHaveBeenCalledOnce(); expect(mocks.spawnConversation).not.toHaveBeenCalled();
    });
    it.each(['offline', 'account-changed'])('keeps a previous unknown launch reserved when Retry is %s before dispatch', async reason => {
        mocks.spawnConversation.mockResolvedValueOnce({ type: 'error', outcomeUnknown: true, errorMessage: 'lost ACK' });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        if (reason === 'offline') mocks.online.mockReturnValue(false);
        else mocks.spawnConversation.mockResolvedValueOnce({ type: 'error', notDispatched: true, errorMessage: 'binding changed before retry' });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(false); });
        expect(mocks.releaseReservation).not.toHaveBeenCalled(); expect(hook.current().hydrationError).toEqual({ sessionId: 'root' });
        expect(mocks.send).not.toHaveBeenCalled(); hook.unmount();
    });
    it('can unlock a sticky unknown launch only after the daemon proves the same request cancelled', async () => {
        mocks.spawnConversation.mockResolvedValueOnce({ type: 'error', errorMessage: 'lost ACK' })
            .mockResolvedValueOnce({ type: 'error', notDispatched: true, conversationCancelled: true, errorMessage: 'cancelled receipt' });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(false); });
        expect(mocks.releaseReservation).toHaveBeenCalledOnce(); expect(hook.current().hydrationError).toBeNull();
        expect(mocks.send).not.toHaveBeenCalled(); hook.unmount();
    });
    it('rebuilds a stale frontier after upload failure without spawning another worker', async () => {
        let revision = 0;
        mocks.prepareContext.mockImplementation(async () => {
            const expected = revision;
            return { ...prepared, assertCurrent: () => { if (revision !== expected) throw new Error('tail changed'); },
                assertIdentityCurrent: () => {}, verifyCurrent: async () => { if (revision !== expected) throw new Error('tail changed'); } };
        });
        mocks.attachContext.mockImplementationOnce(async () => { revision++; throw new Error('source changed during upload'); });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(true); });
        expect(mocks.prepareContext).toHaveBeenCalledTimes(2); expect(mocks.spawnConversation).toHaveBeenCalledOnce();
        expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.cancelConversation).not.toHaveBeenCalled(); hook.unmount();
    });
    it('cancels the unsent restored candidate when clear changes source identity during upload', async () => {
        let cleared = false;
        mocks.prepareContext.mockResolvedValue({ ...prepared, assertCurrent: () => { if (cleared) throw new Error('source reset'); },
            assertIdentityCurrent: () => { if (cleared) throw new Error('source reset'); }, verifyCurrent: async () => {} });
        mocks.attachContext.mockImplementationOnce(async () => { cleared = true; throw new Error('source reset during upload'); });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        await act(async () => { expect(await hook.current().retryHydration()).toBe(false); });
        expect(mocks.cancelConversation).toHaveBeenCalledWith({ machineId: 'machine', rootSessionId: 'root', sourceSessionId: 'source', requestId: 'switch-request' });
        expect(mocks.releaseReservation).toHaveBeenCalledOnce(); expect(hook.current().hydrationError).toBeNull();
        expect(mocks.spawnConversation).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled(); hook.unmount();
    });
    it('fences a source change in the final send gap before any atomic outbox commit', async () => {
        let changed = false;
        mocks.prepareContext.mockResolvedValue({ ...prepared, assertCurrent: () => { if (changed) throw new Error('source changed'); },
            assertIdentityCurrent: () => {}, verifyCurrent: async () => {} });
        mocks.send.mockImplementationOnce(async (_id, _prompt, options) => {
            changed = true; expect(options.isCurrent()).toBe(false); throw new Error('send owner invalidated before outbox');
        });
        const hook = renderHook();
        await act(async () => { expect(await hook.current().spawn(args)).toBe(false); });
        expect(mocks.release).toHaveBeenCalledOnce(); expect(mocks.commit).not.toHaveBeenCalled(); hook.unmount();
    });
});

it('restores an independent continuation without adopting its frozen parent later clear', async () => {
    const metadata = { machineId: 'machine', path: '/project', flavor: 'codex', codexThreadId: 'native-a' };
    mocks.sessions = { source: { metadata }, prefix: { metadata: { portableContextBoundary: { id: 'later-parent-clear', afterSeq: 50 } } } };
    const history = { ...prepared, archive: { snapshot: { items: [], heads: [
        { sessionId: 'prefix', throughSeq: 10, afterSeq: 0 }, { sessionId: 'source', throughSeq: 20, afterSeq: 0 },
    ] } } };
    mocks.prepareContext.mockResolvedValue(history);
    mocks.spawnConversation.mockResolvedValue({ type: 'success', sessionId: 'target', nativeResume: {
        sourceSessionId: 'source', coverage: [], contextEpoch: null,
        contextSources: [{ sessionId: 'source', identity: portableNativeSourceIdentity(metadata) }],
    } });
    const hook = renderHook();
    await act(async () => { expect(await hook.current().spawn({ ...args, agent: 'codex' })).toBe(true); });
    expect(mocks.cancelConversation).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce(); hook.unmount();
});
