// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 900, height: 600 }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    surface: '#17212b', surfacePressed: '#283640', text: '#ffffff', divider: '#445566', shadow: { color: '#000000' },
} } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { FileTabContextMenu } from './FileTabContextMenu.web';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const tabs = ['/a.md', '/b.md', '/c.md'];
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('clamps to the viewport, navigates enabled actions, closes on Escape and restores focus', () => {
    const trigger = document.createElement('button'); document.body.append(trigger);
    const onClose = vi.fn();
    const anchor = { path: '/a.md', x: 890, y: 590, trigger };
    const render = (open: boolean) => <FileTabContextMenu anchor={open ? anchor : null} tabs={tabs} saving={[]} onClose={onClose} onAction={vi.fn()} />;
    act(() => root.render(render(true)));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(parseInt(menu.style.left) + 216).toBeLessThanOrEqual(900);
    expect(parseInt(menu.style.top) + 192).toBeLessThanOrEqual(600);
    const buttons = Array.from(menu.querySelectorAll('button'));
    expect(buttons[3].disabled).toBe(true); // No tabs left of the first tab.
    expect(document.activeElement).toBe(buttons[0]);
    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(buttons[4]);
    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(document.activeElement).toBe(buttons[2]);
    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(render(false)));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
});
it('disables actions containing a saving file and passes the clicked tab boundary', () => {
    const trigger = document.createElement('button'); document.body.append(trigger);
    const onClose = vi.fn(), onAction = vi.fn();
    act(() => root.render(<FileTabContextMenu anchor={{ path: '/b.md', x: 20, y: 30, trigger }} tabs={tabs} saving={['/c.md']} onClose={onClose} onAction={onAction} />));
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(buttons[1].disabled).toBe(true);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[4].disabled).toBe(true);
    act(() => buttons[3].click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(['/a.md']);
    act(() => root.render(null));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
});
it('focuses the menu itself when every action is unavailable so Escape still dismisses it', () => {
    const onClose = vi.fn();
    act(() => root.render(<FileTabContextMenu anchor={{ path: '/a.md', x: 20, y: 30, trigger: null }} tabs={['/a.md']} saving={['/a.md']} onClose={onClose} onAction={vi.fn()} />));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
});
