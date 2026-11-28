import React from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAntigravityModelCatalog } from './useAntigravityModelCatalog';
import { setFirstSubmissionScope, clearFirstSubmissionScope } from '@/sync/firstSubmissionScope';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/sync/ops', () => ({ machineGetAntigravityModelCatalog: mocks.read }));
let renderer: any, result: ReturnType<typeof useAntigravityModelCatalog>;
function Harness(props: { machineId: string; directory: string; enabled: boolean }) {
    result = useAntigravityModelCatalog(props);
    return null;
}
function deferred() {
    let resolve!: (v: any) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<any>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
const catalog = (id: string) => ({ source: 'antigravity-native', observedAt: 1, models: [{ code: id, value: id }] });
beforeEach(() => {
    mocks.read.mockReset();
    setFirstSubmissionScope('one', 'https://one');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
    act(() => renderer?.unmount());
    clearFirstSubmissionScope();
});
it('discovers on selection once, coalesces an open menu, then refreshes only on another user action', async () => {
    const first = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(catalog('future'));
    await act(async () => {
        renderer = TestRenderer.create(<Harness machineId="m" directory="/work" enabled />);
    });
    expect(result.loading).toBe(true);
    let open!: Promise<void>;
    act(() => {
        open = result.refresh();
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => {
        first.resolve(catalog('current'));
        await open;
    });
    expect(result.catalog?.models[0].code).toBe('current');
    expect(result.loading).toBe(false);
    await act(async () => {
        await result.refresh();
    });
    expect(result.catalog?.models[0].code).toBe('future');
});
it('ignores late machine/directory replies and new accounts cannot reuse a prior catalog', async () => {
    const old = deferred(),
        next = deferred(),
        account = deferred();
    mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise).mockReturnValueOnce(account.promise);
    await act(async () => {
        renderer = TestRenderer.create(<Harness machineId="one" directory="/a" enabled />);
    });
    await act(async () => {
        renderer.update(<Harness machineId="two" directory="/b" enabled />);
    });
    expect(result.catalog).toBeNull();
    await act(async () => {
        next.resolve(catalog('two'));
        old.resolve(catalog('one'));
    });
    expect(result.catalog?.models[0].code).toBe('two');
    await act(async () => {
        setFirstSubmissionScope('new', 'https://two');
    });
    expect(result.catalog).toBeNull();
    expect(result.loading).toBe(true);
    await act(async () => {
        account.resolve(catalog('new'));
    });
    expect(result.catalog?.models[0].code).toBe('new');
});
it('exposes failure without erasing the last valid snapshot and permits explicit retry', async () => {
    mocks.read
        .mockResolvedValueOnce(catalog('old'))
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce(catalog('new'));
    await act(async () => {
        renderer = TestRenderer.create(<Harness machineId="m" directory="/a" enabled />);
    });
    await act(async () => {
        await expect(result.refresh()).rejects.toThrow('unavailable');
    });
    expect(result.catalog?.models[0].code).toBe('old');
    expect(result.error).toBe(true);
    expect(result.loading).toBe(false);
    await act(async () => {
        await result.refresh();
    });
    expect(result.error).toBe(false);
    expect(result.catalog?.models[0].code).toBe('new');
});
