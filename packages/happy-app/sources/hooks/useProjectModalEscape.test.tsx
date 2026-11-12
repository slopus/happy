import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ modals: [] as unknown[], dismiss: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/modal', () => ({ useModal: () => ({ state: { modals: mock.modals }, dismissTopModal: mock.dismiss }) }));
import { useProjectModalEscape } from './useProjectModalEscape';
let renderer: any;
const close = vi.fn();
let listeners: Record<string, Set<(event: any) => void>>;
function Host({ busy = false }: { busy?: boolean }) { useProjectModalEscape(close, busy); return null; }
const event = (key = 'Escape', repeat = false) => ({ key, repeat, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });
const dispatch = (type: string, value = event()) => { for (const listener of [...(listeners[type] ?? [])]) listener(value); return value; };
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.modals = []; listeners = {};
    vi.stubGlobal('window', { addEventListener: (type: string, listener: any) => (listeners[type] ??= new Set()).add(listener), removeEventListener: (type: string, listener: any) => listeners[type]?.delete(listener) });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.unstubAllGlobals(); });
it('cancels only the nested confirmation and consumes its keyup after rerender', () => {
    mock.modals = [{}]; act(() => { renderer = TestRenderer.create(<Host />); });
    act(() => { dispatch('keydown'); });
    expect(mock.dismiss).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    mock.modals = []; act(() => renderer.update(<Host />));
    act(() => { dispatch('keydown', event('Escape', true)); });
    expect(close).not.toHaveBeenCalled();
    const released = dispatch('keyup'); expect(released.stopImmediatePropagation).toHaveBeenCalledOnce();
    act(() => { dispatch('keydown'); }); expect(close).toHaveBeenCalledOnce();
});
it('keeps busy dialogs open and leaves unrelated keys alone', () => {
    act(() => { renderer = TestRenderer.create(<Host busy />); });
    const unrelated = dispatch('keydown', event('Enter')); expect(unrelated.preventDefault).not.toHaveBeenCalled();
    dispatch('keydown'); dispatch('keyup'); expect(close).not.toHaveBeenCalled();
    act(() => renderer.update(<Host />)); dispatch('keydown'); expect(close).toHaveBeenCalledOnce();
});
