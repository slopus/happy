import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        StyleSheet: {
            absoluteFillObject: { position: 'absolute', inset: 0 },
            create: (styles: unknown) => styles,
        },
        View: host('View'),
    };
});

vi.mock('@expo/ui/swift-ui', async () => {
    const ReactModule = await import('react');
    const component = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Button: component('ExpoButton'),
        Host: component('ExpoHost'),
        HStack: component('ExpoHStack'),
        Image: component('ExpoImage'),
        Menu: component('ExpoMenu'),
        Section: component('ExpoSection'),
        Spacer: component('ExpoSpacer'),
        Text: component('ExpoText'),
    };
});

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
    accessibilityLabel: (label: string) => ({ type: 'accessibilityLabel', value: { label } }),
    contentShape: (shape: unknown) => ({ type: 'contentShape', shape }),
    disabled: (value: boolean) => ({ type: 'disabled', value: { disabled: value } }),
    frame: (value: unknown) => ({ type: 'frame', value }),
    foregroundColor: (value: string) => ({ type: 'foregroundColor', value }),
    opacity: (value: number) => ({ type: 'opacity', value }),
    shapes: { rectangle: () => ({ type: 'rectangle' }) },
    tint: (value: string) => ({ type: 'tint', value }),
}));

import { NativeOptionsPicker } from './NativeOptionsPicker.ios';
import { NativeSettingsMenu } from './NativeSettingsMenu.ios';

const MENU_DISMISS_DELAY_MS = 220;

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(element);
    });
    return renderer;
}

function expectFullTriggerHitArea(label: React.ReactElement, minHeight: number) {
    const props = label.props as { modifiers: unknown[] };
    expect(props.modifiers).toContainEqual({
        type: 'frame',
        value: { maxWidth: 10000, maxHeight: 10000, minHeight },
    });
    expect(props.modifiers).toContainEqual({
        type: 'contentShape',
        shape: { type: 'rectangle' },
    });
    expect(props.modifiers).toContainEqual({ type: 'foregroundColor', value: 'clear' });
    expect(props.modifiers).not.toContainEqual({ type: 'opacity', value: 0.01 });
}

describe('iOS Expo-native menu triggers', () => {
    it('hides the pointer-disabled trigger subtree and announces the picker title and value', () => {
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            options: [{ key: 'mac', label: 'Mac' }],
            selectedKey: 'mac',
            onSelect: vi.fn(),
            children: React.createElement('Trigger'),
        }));

        const trigger = renderer.root.findAllByType('View' as any).find((view: any) => view.props.pointerEvents === 'none');
        expect(trigger?.props.accessibilityElementsHidden).toBe(true);
        expect(trigger?.props.importantForAccessibility).toBe('no-hide-descendants');

        const container = renderer.root.findAllByType('View' as any).find((view: any) => view.props.style?.position === 'relative');
        expect(container?.props.hitSlop).toBeUndefined();
        expect(renderer.root.findByType('ExpoHost' as any).props.style).toEqual({ position: 'absolute', inset: 0 });

        const menu = renderer.root.findByType('ExpoMenu' as any);
        expect(menu.props.label.props.children[1].props.children).toBe('Machine: Mac');
    });

    it('uses the complete option-row bounds and forwards native button selection', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            options: [
                { key: 'mac', label: 'Mac' },
                { key: 'mini', label: 'Mini' },
            ],
            selectedKey: 'mac',
            onSelect,
            children: React.createElement('Trigger'),
        }));

        const menu = renderer.root.findByType('ExpoMenu' as any);
        expectFullTriggerHitArea(menu.props.label, 42);
        expect(renderer.root.findByType('ExpoHost' as any)).toBeDefined();

        const buttons = renderer.root.findAllByType('ExpoButton' as any);
        expect(buttons.find((button: any) => button.props.label === 'Mac')?.props.systemImage).toBe('checkmark');
        const mini = buttons.find((button: any) => button.props.label === 'Mini');
        act(() => mini.props.onPress());
        expect(onSelect).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(MENU_DISMISS_DELAY_MS));
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('mini');
    });

    it('only commits the latest selection after menu dismissal', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            options: [
                { key: 'mac', label: 'Mac' },
                { key: 'mini', label: 'Mini' },
            ],
            selectedKey: 'mac',
            onSelect,
            children: React.createElement('Trigger'),
        }));
        const buttons = renderer.root.findAllByType('ExpoButton' as any);

        act(() => buttons[0].props.onPress());
        act(() => buttons[1].props.onPress());
        act(() => vi.advanceTimersByTime(MENU_DISMISS_DELAY_MS));

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('mini');
    });

    it('cancels a pending selection when the native menu unmounts', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            options: [{ key: 'mac', label: 'Mac' }],
            selectedKey: 'mac',
            onSelect,
            children: React.createElement('Trigger'),
        }));
        const button = renderer.root.findByType('ExpoButton' as any);

        act(() => button.props.onPress());
        act(() => renderer.unmount());
        act(() => vi.advanceTimersByTime(MENU_DISMISS_DELAY_MS));

        expect(onSelect).not.toHaveBeenCalled();
    });

    it('renders grouped settings as sections in one native menu with full trigger bounds', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Settings',
            groups: [{
                key: 'permission',
                label: 'Permissions',
                systemImage: 'shield',
                options: [
                    { key: 'safe', label: 'Safe mode' },
                    { key: 'locked', label: 'Locked', disabled: true },
                ],
                selectedKey: 'safe',
                onSelect,
            }],
            style: { width: 42, height: 42 },
            children: React.createElement('Trigger'),
        }));

        const menus = renderer.root.findAllByType('ExpoMenu' as any);
        expect(menus).toHaveLength(1);
        const trigger = renderer.root.findAllByType('View' as any).find((view: any) => view.props.pointerEvents === 'none');
        expect(trigger?.props.accessibilityElementsHidden).toBe(true);
        expect(trigger?.props.importantForAccessibility).toBe('no-hide-descendants');
        const container = renderer.root.findAllByType('View' as any).find((view: any) => Array.isArray(view.props.style));
        expect(container?.props.style).toContainEqual({ width: 42, height: 42 });
        expect(container?.props.hitSlop).toBeUndefined();
        expect(renderer.root.findByType('ExpoHost' as any).props.style).toEqual({ position: 'absolute', inset: 0 });
        expectFullTriggerHitArea(menus[0].props.label, 40);
        expect(menus[0].props.label.props.children[0].props.children).toBe('Settings');
        expect(menus[0].props.label.props.modifiers).toContainEqual({
            type: 'accessibilityLabel',
            value: { label: 'Settings' },
        });
        const sections = renderer.root.findAllByType('ExpoSection' as any);
        expect(sections).toHaveLength(1);
        const sectionHeader = render(sections[0].props.header);
        expect(sectionHeader.root.findByType('ExpoHStack' as any)).toBeDefined();
        expect(sectionHeader.root.findByType('ExpoImage' as any).props.systemName).toBe('shield');
        expect(sectionHeader.root.findByType('ExpoText' as any).props.children).toBe('Permissions');

        const safeMode = renderer.root.findAllByType('ExpoButton' as any).find((button: any) => button.props.label === 'Safe mode');
        expect(safeMode.props.systemImage).toBe('checkmark');
        act(() => safeMode.props.onPress());
        act(() => vi.advanceTimersByTime(MENU_DISMISS_DELAY_MS));
        expect(onSelect).toHaveBeenCalledWith('safe');

        const locked = renderer.root.findAllByType('ExpoButton' as any).find((button: any) => button.props.label === 'Locked');
        expect(locked.props.modifiers).toContainEqual({ type: 'disabled', value: { disabled: true } });
    });
});
