import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { useMachineDelegationRoles } from './useMachineDelegationRoles';

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    scope: { key: 'account-a', serverUrl: 'https://example.test' } as { key: string; serverUrl: string } | null,
    status: 'connected',
    statusListeners: new Set<(status: string) => void>(),
    accountListeners: new Set<() => void>(),
}));
vi.mock('@/sync/apiDelegation', () => ({ listMachineDelegationRoles: mocks.list }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { onStatusChange: (listener: (status: string) => void) => {
    mocks.statusListeners.add(listener); listener(mocks.status);
    return () => mocks.statusListeners.delete(listener);
} } }));
vi.mock('@/sync/firstSubmissionScope', () => ({ getFirstSubmissionScope: () => mocks.scope,
    subscribeFirstSubmissionScope: (listener: () => void) => {
        mocks.accountListeners.add(listener); return () => mocks.accountListeners.delete(listener);
    } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('role settings refresh on navigation focus', () => {
    let renderer: any;
    let result: ReturnType<typeof useMachineDelegationRoles>;
    const role = (name: string) => ({ id: 'writer-id', name, description: 'Write documentation', agent: 'antigravity',
        autoDelegate: false, createdAt: 1, updatedAt: 2 });
    function Probe({ focused = true, machineId = 'machine-a' }: { focused?: boolean; machineId?: string }) {
        result = useMachineDelegationRoles(machineId, true, focused);
        return null;
    }
    const render = async (focused = true) => { await act(async () => { renderer = TestRenderer.create(<Probe focused={focused} />); }); };
    const focus = async (focused: boolean) => { await act(async () => { renderer.update(<Probe focused={focused} />); }); };
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks(); mocks.statusListeners.clear(); mocks.accountListeners.clear(); mocks.status = 'connected';
        mocks.scope = { key: 'account-a', serverUrl: 'https://example.test' };
        mocks.list.mockResolvedValue([role('Original')]);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

    it('reads once initially, then reads the role updated by AI when settings regains focus', async () => {
        await render();
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('machine-a');
        await focus(false);
        mocks.list.mockResolvedValue([role('Updated in the conversation')]);
        await focus(true);
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(result!.roles[0].name).toBe('Updated in the conversation');
        await focus(true);
        expect(mocks.list).toHaveBeenCalledTimes(2);
    });

    it('does not fetch while the settings route is hidden, even on socket reconnect', async () => {
        await render(false);
        expect(mocks.list).not.toHaveBeenCalled();
        await act(async () => { mocks.statusListeners.forEach(listener => listener('disconnected')); });
        await act(async () => { mocks.statusListeners.forEach(listener => listener('connected')); });
        expect(mocks.list).not.toHaveBeenCalled();
        await focus(true);
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('machine-a');
    });

    it('rejects a late read from before blur after the new focused read has completed', async () => {
        let finishOld!: (roles: unknown) => void;
        mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
        await render();
        await focus(false);
        mocks.list.mockResolvedValueOnce([role('Current')]);
        await focus(true);
        await act(async () => { finishOld([role('Stale')]); });
        expect(result!.roles[0].name).toBe('Current');
        expect(mocks.list).toHaveBeenCalledTimes(2);
    });

    it('keeps the write owner scope stable when focus changes and removes data on account exit', async () => {
        await render();
        const ownerScope = result!.scope;
        await focus(false);
        expect(result!.scope).toBe(ownerScope);
        await act(async () => { mocks.scope = null; mocks.accountListeners.forEach(listener => listener()); });
        expect(result!.roles).toEqual([]);
        const reads = mocks.list.mock.calls.length;
        await focus(true);
        expect(mocks.list).toHaveBeenCalledTimes(reads);
    });
});
