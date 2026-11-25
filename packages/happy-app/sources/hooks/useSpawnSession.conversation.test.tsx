import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { useSpawnSession, type SpawnSessionArgs } from './useSpawnSession';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    prepare: vi.fn(), claim: vi.fn(), release: vi.fn(), commit: vi.fn(),
    prepareContext: vi.fn(), attachContext: vi.fn(), spawn: vi.fn(), hydrate: vi.fn(),
    send: vi.fn(), project: vi.fn(), confirmDelivery: vi.fn(), navigate: vi.fn(), alert: vi.fn(),
}));
vi.mock('@/sync/conversationSwitch', () => ({
    prepareConversationSwitch: mocks.prepare, claimConversationSwitch: mocks.claim,
    releaseConversationSwitch: mocks.release, commitConversationSwitch: mocks.commit,
}));
vi.mock('@/sync/sessionContextHandoff', () => ({
    prepareSessionContinuationContext: mocks.prepareContext, attachSessionContinuationContext: mocks.attachContext,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'switch-request' }));
vi.mock('@/sync/sessionStartupTrace', () => ({ traceStartup: vi.fn() }));
vi.mock('@/sync/sessionStartupTraceRuntime', () => ({ sessionStartupTraceRuntime: {
    begin: vi.fn(() => 'trace'), bindSession: vi.fn(), cancel: vi.fn(),
} }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: mocks.spawn }));
vi.mock('@/sync/sync', () => ({ sync: {
    ensureSessionHydrated: mocks.hydrate, sendMessage: mocks.send,
    awaitLocalMessageProjection: mocks.project, awaitConversationHandoffDelivery: mocks.confirmDelivery,
} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
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
    mocks.prepare.mockResolvedValue('root'); mocks.prepareContext.mockResolvedValue('Earlier task context.');
    mocks.claim.mockResolvedValue(undefined); mocks.release.mockResolvedValue(undefined); mocks.commit.mockResolvedValue(undefined);
    mocks.attachContext.mockResolvedValue(undefined); mocks.spawn.mockResolvedValue({ type: 'success', sessionId: 'target' });
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
        expect(mocks.spawn).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
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
        expect(mocks.spawn).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledTimes(2);
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
});
