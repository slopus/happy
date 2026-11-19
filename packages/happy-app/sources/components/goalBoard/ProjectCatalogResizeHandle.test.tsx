import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textLink: 'current-theme-link' } } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { ProjectCatalogResizeHandle } from './ProjectCatalogResizeHandle.web';

let renderer: any;
const onResize = vi.fn();
const listeners = new Map<string, () => void>();
const style = { cursor: 'auto', userSelect: 'text' };
const target = {
    focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    previousElementSibling: { getBoundingClientRect: () => ({ width: 500 }) },
};
const pointer = (clientX: number, pointerId = 1) => ({ clientX, pointerId, button: 0, isPrimary: true, preventDefault: vi.fn(), currentTarget: target });
const handle = () => renderer.root.findByProps({ role: 'separator' });
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('document', { body: { style } });
    vi.stubGlobal('window', { addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), removeEventListener: (event: string) => listeners.delete(event) });
    vi.clearAllMocks();
    act(() => { renderer = TestRenderer.create(<ProjectCatalogResizeHandle width={500} rowWidth={1580} rightWidth={320} onResize={onResize} />); });
});
afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });

it('drags from the rendered catalog edge and clamps both ends without squeezing chat', () => {
    act(() => handle().props.onPointerDown(pointer(600)));
    expect(style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    act(() => handle().props.onPointerMove(pointer(400)));
    expect(onResize).toHaveBeenLastCalledWith(300);
    act(() => handle().props.onPointerMove(pointer(-1000)));
    expect(onResize).toHaveBeenLastCalledWith(280);
    act(() => handle().props.onPointerUp(pointer(2000)));
    expect(onResize).toHaveBeenLastCalledWith(880);
    expect(style).toEqual({ cursor: 'auto', userSelect: 'text' });
});

it('ignores another pointer and stops resizing after capture is lost', () => {
    act(() => handle().props.onPointerDown(pointer(600)));
    act(() => handle().props.onPointerMove(pointer(400, 2)));
    expect(onResize).not.toHaveBeenCalled();
    act(() => handle().props.onLostPointerCapture());
    act(() => handle().props.onPointerMove(pointer(400)));
    expect(onResize).not.toHaveBeenCalled();
    expect(style.cursor).toBe('auto');
});

it('cleans up a drag when the window loses focus or the workspace unmounts', () => {
    act(() => handle().props.onPointerDown(pointer(600)));
    act(() => listeners.get('blur')!());
    expect(style.userSelect).toBe('text');
    act(() => handle().props.onPointerDown(pointer(600)));
    act(() => renderer.unmount());
    expect(style.cursor).toBe('auto');
    expect(listeners.size).toBe(0);
});

it('supports keyboard sizing and double-click reset', () => {
    const key = (key: string) => ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    act(() => handle().props.onKeyDown(key('ArrowLeft')));
    expect(onResize).toHaveBeenLastCalledWith(484);
    act(() => handle().props.onKeyDown(key('End')));
    expect(onResize).toHaveBeenLastCalledWith(880);
    act(() => handle().props.onKeyDown(key('Home')));
    expect(onResize).toHaveBeenLastCalledWith(280);
    act(() => handle().props.onDoubleClick());
    expect(onResize).toHaveBeenLastCalledWith(undefined);
});

it('shows the active theme color on hover and keyboard focus', () => {
    const line = () => handle().findAllByType('div')[1];
    expect(line().props.style.background).toBe('transparent');
    act(() => handle().props.onPointerEnter());
    expect(line().props.style.background).toBe('current-theme-link');
    act(() => { handle().props.onPointerLeave(); handle().props.onFocus(); });
    expect(line().props.style.background).toBe('current-theme-link');
});
