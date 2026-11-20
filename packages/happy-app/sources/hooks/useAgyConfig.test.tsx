import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgyConfig } from './useAgyConfig';
import { isAgyConfigPending } from '@/sync/agyConfigPending';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), model: vi.fn(), effort: vi.fn(), alert: vi.fn(), current: vi.fn(() => true) }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: mocks.current }));
vi.mock('@/sync/ops', () => ({ sessionSetAgyConfig: mocks.rpc }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: Object.fromEntries(['one', 'two', 'shared'].map(id => [id, { metadata: { flavor: 'antigravity' } }])), updateSessionModelMode: mocks.model, updateSessionEffortLevel: mocks.effort }) } }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
let renderer: any;
let result: ReturnType<typeof useAgyConfig>;
function Harness({ id }: { id: string }) { result = useAgyConfig(id, 'antigravity'); return null; }
beforeEach(() => { vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { act(() => renderer?.unmount()); });
it('persists only acknowledged configuration and clears an unsupported previous effort', async () => {
    let resolve!: (value: any) => void;
    mocks.rpc.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    act(() => { renderer = TestRenderer.create(<Harness id="one" />); });
    let pending!: Promise<boolean>;
    act(() => { pending = result.apply({ model: 'argon' }); });
    expect(result.busy).toBe(true); expect(isAgyConfigPending('one')).toBe(true); expect(mocks.model).not.toHaveBeenCalled();
    await act(async () => { resolve({ model: 'argon', effort: 'medium' }); await pending; });
    expect(mocks.model).toHaveBeenCalledWith('one', 'argon');
    expect(mocks.effort).toHaveBeenCalledWith('one', 'medium');
    expect(result.busy).toBe(false); expect(isAgyConfigPending('one')).toBe(false);
});
it('keeps selection after rejection and persists acknowledged settings to the original session after navigation', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('Session must be idle'));
    act(() => { renderer = TestRenderer.create(<Harness id="one" />); });
    await act(async () => { await result.apply({ effort: 'high' }); });
    expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.alert).toHaveBeenCalled();
    let resolve!: (value: any) => void;
    mocks.rpc.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    let pending!: Promise<boolean>;
    act(() => { pending = result.apply({ model: 'argon' }); });
    act(() => { renderer.update(<Harness id="two" />); });
    await act(async () => { resolve({ model: 'argon', effort: 'high' }); await pending; });
    expect(mocks.model).toHaveBeenCalledWith('one', 'argon'); expect(result.busy).toBe(false);
});

it('shares pending state between the header and composer and coalesces a second picker action', async () => {
    let resolve!: (value: any) => void;
    mocks.rpc.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const values: Array<ReturnType<typeof useAgyConfig>> = [];
    function Picker({ slot }: { slot: number }) { values[slot] = useAgyConfig('shared', 'antigravity'); return null; }
    act(() => { renderer = TestRenderer.create(<><Picker slot={0} /><Picker slot={1} /></>); });
    let pending!: Promise<boolean>;
    act(() => { pending = values[0].apply({ model: 'argon' }); });
    expect(values[1].busy).toBe(true);
    await act(async () => { await values[1].apply({ effort: 'low' }); });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ model: 'argon', effort: 'high' }); await pending; });
    expect(values[1].busy).toBe(false);
});

it('does not apply acknowledgments after account ownership changes', async () => {
    mocks.current.mockReturnValueOnce(false);
    mocks.rpc.mockResolvedValueOnce({ model: 'argon', effort: 'low' });
    act(() => { renderer = TestRenderer.create(<Harness id="one" />); });
    await act(async () => { await result.apply({ effort: 'low' }); });
    expect(mocks.model).not.toHaveBeenCalled();
});
