// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal as NativeModal } from 'react-native';
import { appThemes } from '@/themePacks';
import { ScheduleChoice } from './ScheduleChoice';

const appearance = vi.hoisted(() => ({ name: 'ginghamDark' as 'ginghamLight' | 'ginghamDark' }));
// @ts-expect-error RN Web runtime is installed without a declarations package.
vi.mock('react-native', async () => import('react-native-web'));
vi.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => <span data-icon={name} aria-hidden="true" /> }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes: themes } = await import('@/themePacks');
    const theme = () => themes[appearance.name];
    return {
        useUnistyles: () => ({ theme: theme() }),
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: (current: typeof themes.ginghamDark) => Record<string, unknown>) =>
                new Proxy({}, { get: (_target, key) => Reflect.get(factory(theme()), key) }),
        },
    };
});

const options = [
    { key: 'air', name: 'MacBook Air' },
    { key: 'mini', name: 'Mac mini' },
    { key: 'server', name: 'Very long execution machine name' },
];
let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
    appearance.name = 'ginghamDark';
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.restoreAllMocks();
});
function render(node: React.ReactNode) { act(() => root!.render(node)); }
function element(id: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(node, id).not.toBeNull();
    return node!;
}
function click(node: HTMLElement) { act(() => node.click()); }
function key(node: Element, type: 'keydown' | 'keyup', value: string) {
    act(() => node.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true })));
}
function pressKey(value: string) {
    key(document.activeElement!, 'keydown', value);
    key(document.activeElement!, 'keyup', value);
}
function hover(node: Element, inside: boolean) {
    const type = window.PointerEvent ? (inside ? 'pointerenter' : 'pointerleave') : (inside ? 'mouseenter' : 'mouseleave');
    const event = new MouseEvent(type, { bubbles: false });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    act(() => node.dispatchEvent(event));
}
function rgba(color: string) {
    const probe = document.createElement('span');
    probe.style.backgroundColor = color;
    document.body.append(probe);
    const normalized = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return normalized;
}
function ControlledChoice({ changed = () => {} }: { changed?: (key: string) => void }) {
    const [value, setValue] = React.useState('mini');
    return <ScheduleChoice title="执行机器" value={value} options={options} testID="machine"
        onChange={next => { changed(next); setValue(next); }} />;
}

describe('ScheduleChoice DOM interactions', () => {
    it('shows the current choice, commits once, closes and marks the saved choice when reopened', () => {
        const changed = vi.fn();
        render(<ControlledChoice changed={changed} />);
        expect(element('machine-value').textContent).toBe('Mac mini');
        expect(element('machine').getAttribute('aria-expanded')).toBe('false');
        expect(element('machine').getAttribute('aria-label')).toContain('Mac mini');
        click(element('machine'));
        expect(element('machine-options').getAttribute('role')).toBe('listbox');
        expect(element('machine-mini').getAttribute('aria-selected')).toBe('true');
        expect(element('machine-mini').querySelector('[data-icon="checkmark"]')).not.toBeNull();
        click(element('machine-air'));
        expect(changed).toHaveBeenCalledExactlyOnceWith('air');
        expect(document.querySelector('[data-testid="machine-options"]')).toBeNull();
        expect(element('machine-value').textContent).toBe('MacBook Air');
        expect(document.activeElement).toBe(element('machine'));
        click(element('machine'));
        expect(element('machine-air').getAttribute('aria-selected')).toBe('true');
        expect(element('machine-mini').getAttribute('aria-selected')).toBe('false');
        expect(element('machine-air').querySelector('[data-icon="checkmark"]')).not.toBeNull();
        expect(element('machine-mini').querySelector('[data-icon="checkmark"]')).toBeNull();
    });

    it.each(['ginghamLight', 'ginghamDark'] as const)('shows hover and selection from the active %s palette', name => {
        appearance.name = name;
        render(<ControlledChoice />);
        const theme = appThemes[name];
        expect(getComputedStyle(element('machine')).backgroundColor).toBe(rgba(theme.colors.surface));
        hover(element('machine'), true);
        expect(getComputedStyle(element('machine')).backgroundColor).toBe(rgba(theme.colors.surfacePressed));
        hover(element('machine'), false);
        expect(getComputedStyle(element('machine')).backgroundColor).toBe(rgba(theme.colors.surface));
        click(element('machine'));
        const selected = element('machine-mini');
        const other = element('machine-air');
        expect(getComputedStyle(selected).backgroundColor).toBe(rgba(theme.colors.surfaceSelected));
        hover(other, true);
        expect(getComputedStyle(other).backgroundColor).toBe(rgba(theme.colors.surfacePressed));
        hover(other, false);
        expect(getComputedStyle(other).backgroundColor).toBe(rgba(theme.colors.surface));
        hover(selected, true);
        expect(getComputedStyle(selected).backgroundColor).toBe(rgba(theme.colors.surfaceSelected));
        expect(selected.getAttribute('aria-selected')).toBe('true');
        expect(selected.querySelector('[data-icon="checkmark"]')).not.toBeNull();
        expect(getComputedStyle(selected).borderTopColor).toBe(rgba(theme.colors.textLink));
    });

    it('moves focus with arrows and Home/End, then chooses the focused option with Enter', () => {
        const changed = vi.fn();
        render(<ControlledChoice changed={changed} />);
        act(() => element('machine').focus());
        pressKey('ArrowDown');
        expect(document.activeElement).toBe(element('machine-mini'));
        pressKey('End');
        expect(document.activeElement).toBe(element('machine-server'));
        pressKey('Home');
        expect(document.activeElement).toBe(element('machine-air'));
        pressKey('ArrowUp');
        expect(document.activeElement).toBe(element('machine-server'));
        pressKey('ArrowDown');
        expect(document.activeElement).toBe(element('machine-air'));
        pressKey('Enter');
        expect(changed).toHaveBeenCalledExactlyOnceWith('air');
        expect(element('machine-value').textContent).toBe('MacBook Air');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(document.activeElement).toBe(element('machine'));
    });

    it('consumes an entire Escape press while its parent native Modal and draft remain open', async () => {
        const closeParent = vi.fn();
        await act(async () => root!.render(<NativeModal visible onRequestClose={closeParent}>
            <input data-testid="draft" defaultValue="Keep my task instruction" />
            <ControlledChoice />
        </NativeModal>));
        click(element('machine'));
        expect(document.activeElement).toBe(element('machine-mini'));
        pressKey('Escape');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(closeParent).not.toHaveBeenCalled();
        expect((element('draft') as HTMLInputElement).value).toBe('Keep my task instruction');
        expect(document.activeElement).toBe(element('machine'));
        click(element('machine'));
        pressKey('Escape');
        expect(closeParent).not.toHaveBeenCalled();
        pressKey('Escape');
        expect(closeParent).toHaveBeenCalledOnce();
    });

    it('dismisses on an outside input pointer action without stealing its focus or losing the chosen value', () => {
        const changed = vi.fn();
        render(<><ControlledChoice changed={changed} /><input data-testid="next-field" defaultValue="Task draft" /></>);
        click(element('machine'));
        const next = element('next-field') as HTMLInputElement;
        next.addEventListener('pointerdown', event => event.stopPropagation());
        act(() => {
            next.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
            next.focus();
        });
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(document.activeElement).toBe(next);
        expect(next.value).toBe('Task draft');
        expect(changed).not.toHaveBeenCalled();
        expect(element('machine-value').textContent).toBe('Mac mini');
    });

    it('keeps an explicit default label visible when its stored value is an empty string', () => {
        render(<ScheduleChoice title="模型" value="" options={[{ key: '', name: '机器默认' }, ...options]}
            onChange={vi.fn()} testID="model" />);
        expect(element('model-value').textContent).toBe('机器默认');
        expect(element('model').getAttribute('aria-label')).toBe('模型, 机器默认');
        click(element('model'));
        expect(element('model-').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(element('model-'));
    });

    it('closes on Tab without preventing the browser from moving focus to the next field', () => {
        render(<><ControlledChoice /><input data-testid="next-field" /></>);
        click(element('machine'));
        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        act(() => document.activeElement!.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        act(() => element('next-field').focus());
        expect(document.activeElement).toBe(element('next-field'));
    });

    it('supports choosing the focused listbox option with Space', () => {
        const changed = vi.fn();
        render(<ControlledChoice changed={changed} />);
        click(element('machine'));
        pressKey('Home');
        pressKey(' ');
        expect(changed).toHaveBeenCalledExactlyOnceWith('air');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    });
});
