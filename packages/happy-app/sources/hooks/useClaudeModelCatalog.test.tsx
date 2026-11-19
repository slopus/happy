import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useClaudeModelCatalog } from './useClaudeModelCatalog';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/sync/ops', () => ({ machineGetClaudeModelCatalog: mocks.read }));
let renderer: any;
let result: ReturnType<typeof useClaudeModelCatalog>;
function Harness(props: { machineId: string; directory: string; enabled: boolean }) { result = useClaudeModelCatalog(props); return null; }
function deferred() { let resolve!: (v: any) => void; let reject!: (e: any) => void; const promise = new Promise<any>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const catalog = (id: string) => ({ source: 'claude-native', observedAt: Date.now(), models: [{ code: id, value: id }] });
beforeEach(() => { mocks.read.mockReset(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { act(() => renderer?.unmount()); });

it('reads once on selection, coalesces menu refresh, and gets a new catalog on the next action', async () => {
    const first = deferred(); mocks.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(catalog('future'));
    await act(async () => { renderer = TestRenderer.create(<Harness machineId="one" directory="/work" enabled />); });
    let opening!: Promise<void>;
    act(() => { opening = result.refresh(); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(catalog('current')); await opening; });
    expect(result.catalog?.models[0].code).toBe('current');
    await act(async () => { await result.refresh(); });
    expect(result.catalog?.models[0].code).toBe('future');
});

it('never borrows a catalog across machines, directories or disabled agents when a reply arrives late', async () => {
    const old = deferred(); const next = deferred(); mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await act(async () => { renderer = TestRenderer.create(<Harness machineId="one" directory="/work" enabled />); });
    await act(async () => { renderer.update(<Harness machineId="two" directory="/other" enabled />); });
    expect(result.catalog).toBeNull();
    await act(async () => { next.resolve(catalog('two')); });
    await act(async () => { old.resolve(catalog('one')); });
    expect(result.catalog?.models[0].code).toBe('two');
    await act(async () => { renderer.update(<Harness machineId="two" directory="/other" enabled={false} />); });
    expect(result.catalog).toBeNull();
});

it('keeps the previous snapshot and exposes a failed refresh for an old or unavailable runtime', async () => {
    mocks.read.mockResolvedValueOnce(catalog('current')).mockRejectedValueOnce(new Error('RPC unavailable'));
    await act(async () => { renderer = TestRenderer.create(<Harness machineId="one" directory="/work" enabled />); });
    await act(async () => { await expect(result.refresh()).rejects.toThrow('RPC unavailable'); });
    expect(result.catalog?.models[0].code).toBe('current'); expect(result.error).toBeTruthy();
});
