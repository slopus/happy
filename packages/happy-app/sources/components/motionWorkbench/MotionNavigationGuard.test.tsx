import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ listener: undefined as undefined | ((e: any) => void), dispatch: vi.fn(), remove: vi.fn(), alert: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useNavigation: () => ({ addListener: (_: string, listener: (e: any) => void) => { mock.listener = listener; return mock.remove; }, dispatch: mock.dispatch }) }));
vi.mock('@/modal', () => ({ Modal: { alert: mock.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { MotionNavigationGuard } from './MotionNavigationGuard.web';
let renderer: any;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.listener = undefined; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = undefined; });
it('keeps the current conversation when the native editor refuses to discard an unfinished input', async () => {
    const prepare = vi.fn(async () => false), preventDefault = vi.fn();
    await act(async () => { renderer = TestRenderer.create(<MotionNavigationGuard enabled prepareLeave={prepare} />); });
    await act(async () => mock.listener?.({ preventDefault, data: { action: { type: 'REPLACE' } } }));
    expect(preventDefault).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(mock.dispatch).not.toHaveBeenCalled();
});
it('dispatches the exact held navigation only after the editor has saved and confirmed', async () => {
    let finish!: (ready: boolean) => void;
    const prepare = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await act(async () => { renderer = TestRenderer.create(<MotionNavigationGuard enabled prepareLeave={prepare} />); });
    const action = { type: 'NAVIGATE', payload: { name: 'session', params: { id: 'next' } } }, preventDefault = vi.fn();
    await act(async () => mock.listener?.({ preventDefault, data: { action } }));
    expect(mock.dispatch).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith(action);
});
it('does not dispatch a completed save after its route owner has unmounted', async () => {
    let finish!: (ready: boolean) => void;
    await act(async () => { renderer = TestRenderer.create(<MotionNavigationGuard enabled prepareLeave={() => new Promise<boolean>(resolve => { finish = resolve; })} />); });
    await act(async () => mock.listener?.({ preventDefault: vi.fn(), data: { action: { type: 'REPLACE' } } }));
    await act(async () => renderer.unmount()); renderer = undefined;
    await act(async () => finish(true)); expect(mock.dispatch).not.toHaveBeenCalled();
});
