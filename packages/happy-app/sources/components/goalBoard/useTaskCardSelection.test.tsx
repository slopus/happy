import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useTaskCardSelection } from './useTaskCardSelection';
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
function deferred() {
    let resolve!: (value: string | undefined) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string | undefined>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup() {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const reads = new Map<string, ReturnType<typeof deferred>>();
    const resolve = vi.fn((id: string) => { const read = deferred(); reads.set(id, read); return read.promise; });
    const commit = vi.fn(), onError = vi.fn();
    let select!: ReturnType<typeof useTaskCardSelection>;
    function Host({ context, selectedId }: { context: string; selectedId?: string }) {
        select = useTaskCardSelection({ context, selectedId, resolve, commit, onError }); return null;
    }
    const update = (context = 'scope', selectedId?: string) => act(() => { renderer ? renderer.update(<Host {...{ context, selectedId }} />) : renderer = TestRenderer.create(<Host {...{ context, selectedId }} />); });
    renderer = undefined; update();
    return { select: (id: string) => select(id), reads, resolve, commit, onError, update };
}
it.each(['existing-chat', undefined])('commits task and conversation together: %s', async conversation => {
    const app = setup(), pending = app.select('task'); expect(app.commit).not.toHaveBeenCalled();
    app.reads.get('task')!.resolve(conversation); await pending;
    expect(app.commit.mock.calls).toEqual([['task', conversation]]);
});
it('keeps the selected card open and coalesces repeated pending clicks', async () => {
    const app = setup(); app.update('scope', 'selected'); await app.select('selected');
    expect(app.resolve).not.toHaveBeenCalled();
    const pending = app.select('other'); await app.select('other'); expect(app.resolve).toHaveBeenCalledTimes(1);
    app.reads.get('other')!.resolve('chat'); await pending; expect(app.commit).toHaveBeenCalledTimes(1);
});
it('ignores a slower earlier selection', async () => {
    const app = setup(), first = app.select('first'), second = app.select('second');
    app.reads.get('second')!.resolve('second-chat'); await second;
    app.reads.get('first')!.resolve('first-chat'); await first;
    expect(app.commit.mock.calls).toEqual([['second', 'second-chat']]);
});
it('cancels a pending switch when the open card is reselected', async () => {
    const app = setup(); app.update('scope', 'selected');
    const pending = app.select('other'); await app.select('selected');
    app.reads.get('other')!.resolve('chat'); await pending; expect(app.commit).not.toHaveBeenCalled();
});
it('ignores completion after context changes and unmount', async () => {
    const app = setup(), pending = app.select('task'); app.update('other-account-or-location');
    app.reads.get('task')!.resolve('chat'); await pending;
    const next = app.select('next'); act(() => renderer.unmount()); renderer = undefined;
    app.reads.get('next')!.resolve('chat'); await next; expect(app.commit).not.toHaveBeenCalled();
});
it('retains the current layout when lookup fails', async () => {
    const app = setup(), pending = app.select('task'), error = new Error('offline');
    app.reads.get('task')!.reject(error); await pending;
    expect(app.commit).not.toHaveBeenCalled(); expect(app.onError).toHaveBeenCalledWith(error);
});
