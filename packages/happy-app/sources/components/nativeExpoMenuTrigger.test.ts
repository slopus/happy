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

const THEME_TEXT_COLOR = '#101010';

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: THEME_TEXT_COLOR } } }),
}));

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
    buttonStyle: (value: string) => ({ type: 'buttonStyle', value }),
    contentShape: (shape: unknown) => ({ type: 'contentShape', shape }),
    disabled: (value: boolean) => ({ type: 'disabled', value: { disabled: value } }),
    font: (value: unknown) => ({ type: 'font', value }),
    frame: (value: unknown) => ({ type: 'frame', value }),
    foregroundColor: (value: string) => ({ type: 'foregroundColor', value }),
    lineLimit: (value: number) => ({ type: 'lineLimit', value }),
    opacity: (value: number) => ({ type: 'opacity', value }),
    shapes: { rectangle: () => ({ type: 'rectangle' }) },
    tint: (value: string) => ({ type: 'tint', value }),
}));

import { NativeOptionsPicker } from './NativeOptionsPicker.ios';
import { NativeSettingsMenu } from './NativeSettingsMenu.ios';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

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
}

/** The settings menu still layers its trigger over a real RN chip, so its label
 * must draw nothing. foregroundColor is not enough: the parent Menu's tint
 * overrides it and the label paints white over the chip, duplicating it. */
function expectInvisibleTrigger(label: React.ReactElement) {
    const props = label.props as { modifiers: unknown[] };
    expect(props.modifiers).toContainEqual({ type: 'opacity', value: 0.01 });
    expect(props.modifiers).not.toContainEqual({ type: 'foregroundColor', value: 'clear' });
}

/** The trigger must carry its name for VoiceOver, never as rendered content. */
function expectNoVisibleTriggerContent(
    renderer: ReactTestRenderer,
    label: React.ReactElement,
    announced: string,
) {
    const props = label.props as { modifiers: unknown[] };
    expect(props.modifiers).toContainEqual({
        type: 'accessibilityLabel',
        value: { label: announced },
    });
    const trigger = render(label);
    expect(trigger.root.findAllByType('ExpoText' as any)).toHaveLength(0);
    expect(trigger.root.findAllByType('ExpoImage' as any)).toHaveLength(0);
    void renderer;
}

describe('iOS Expo-native menu triggers', () => {
    it('draws the picker row in SwiftUI and keeps the RN row for layout alone', () => {
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            systemImage: 'desktopcomputer',
            options: [{ key: 'mac', label: 'Mac' }],
            selectedKey: 'mac',
            onSelect: vi.fn(),
            children: React.createElement('Trigger'),
        }));

        // The RN row only sizes the container: SwiftUI paints the visible row, so
        // leaving the RN copy on screen would duplicate it.
        const trigger = renderer.root.findAllByType('View' as any).find((view: any) => view.props.pointerEvents === 'none');
        expect(trigger?.props.style.opacity).toBe(0);
        expect(trigger?.props.accessibilityElementsHidden).toBe(true);
        expect(trigger?.props.importantForAccessibility).toBe('no-hide-descendants');

        const container = renderer.root.findAllByType('View' as any).find((view: any) => view.props.style?.position === 'relative');
        expect(container?.props.hitSlop).toBeUndefined();
        expect(renderer.root.findByType('ExpoHost' as any).props.style).toEqual({ position: 'absolute', inset: 0 });

        const menu = renderer.root.findByType('ExpoMenu' as any);
        expect(menu.props.modifiers).toContainEqual({ type: 'buttonStyle', value: 'plain' });
        expect(menu.props.label.props.modifiers).toContainEqual({
            type: 'accessibilityLabel',
            value: { label: 'Machine: Mac' },
        });

        const label = render(menu.props.label);
        expect(label.root.findByType('ExpoText' as any).props.children).toBe('Mac');
        // One icon only: the leading symbol. The chevrons were noise.
        const icons = label.root.findAllByType('ExpoImage' as any);
        expect(icons).toHaveLength(1);
        expect(icons[0].props.systemName).toBe('desktopcomputer');
    });

    // The menu tint, not foregroundColor, is what paints a SwiftUI label. Once
    // the label became the visible chip a fixed white turned every trigger
    // invisible in light mode, so the tint has to track the theme.
    it('paints both native triggers with the theme text color, not a fixed white', () => {
        const picker = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            options: [{ key: 'mac', label: 'Mac' }],
            selectedKey: 'mac',
            onSelect: vi.fn(),
            children: React.createElement('Trigger'),
        }));
        expect(picker.root.findByType('ExpoMenu' as any).props.modifiers)
            .toContainEqual({ type: 'tint', value: THEME_TEXT_COLOR });

        const settings = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Model',
            triggerLabel: 'Sonnet',
            flat: true,
            groups: [{
                key: 'model',
                label: 'Model',
                selectedKey: 'sonnet',
                options: [{ key: 'sonnet', label: 'Sonnet' }],
                onSelect: vi.fn(),
            }],
            children: React.createElement('Chip'),
        }));
        expect(settings.root.findByType('ExpoMenu' as any).props.modifiers)
            .toContainEqual({ type: 'tint', value: THEME_TEXT_COLOR });
    });

    it('heads the menu with a disabled item so the icon survives UIMenu', () => {
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            systemImage: 'desktopcomputer',
            options: [{ key: 'mac', label: 'Mac' }],
            selectedKey: 'mac',
            onSelect: vi.fn(),
            children: React.createElement('Trigger'),
        }));

        const heading = renderer.root.findAllByType('ExpoButton' as any).find((button: any) => button.props.label === 'Machine');
        expect(heading.props.systemImage).toBe('desktopcomputer');
        expect(heading.props.modifiers).toContainEqual({ type: 'disabled', value: { disabled: true } });
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
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('mini');
    });

    it('commits the selection the user tapped', () => {
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
        const mini = buttons.find((button: any) => button.props.label === 'Mini');

        act(() => mini.props.onPress());

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('mini');
    });

    it('renders grouped settings as sections in one native menu with full trigger bounds', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Settings',
            groups: [{
                key: 'permission',
                label: 'Safe mode',
                title: 'Permission mode',
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
        expectInvisibleTrigger(menus[0].props.label);
        expectNoVisibleTriggerContent(renderer, menus[0].props.label, 'Settings');
        const sections = renderer.root.findAllByType('ExpoSection' as any);
        expect(sections).toHaveLength(1);
        const sectionHeader = render(sections[0].props.header);
        expect(sectionHeader.root.findByType('ExpoHStack' as any)).toBeDefined();
        expect(sectionHeader.root.findByType('ExpoImage' as any).props.systemName).toBe('shield');
        // The heading names what is being chosen, not the current value.
        expect(sectionHeader.root.findByType('ExpoText' as any).props.children).toBe('Permission mode');

        const safeMode = renderer.root.findAllByType('ExpoButton' as any).find((button: any) => button.props.label === 'Safe mode');
        expect(safeMode.props.systemImage).toBe('checkmark');
        act(() => safeMode.props.onPress());
        expect(onSelect).toHaveBeenCalledWith('safe');

        const locked = renderer.root.findAllByType('ExpoButton' as any).find((button: any) => button.props.label === 'Locked');
        expect(locked.props.modifiers).toContainEqual({ type: 'disabled', value: { disabled: true } });
    });

    it('draws the composer chip in SwiftUI when a native trigger is given', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Model',
            groups: [{
                key: 'model',
                label: 'Opus',
                options: [{ key: 'opus', label: 'Opus' }],
                selectedKey: 'opus',
                onSelect: vi.fn(),
            }],
            triggerLabel: 'Opus',
            children: React.createElement('Trigger'),
        }));

        // iOS lenses whatever sits under the trigger it morphs, so the RN chip
        // has to stop painting once SwiftUI draws the same content.
        const trigger = renderer.root.findAllByType('View' as any).find((view: any) => view.props.pointerEvents === 'none');
        expect(trigger?.props.style).toContainEqual({ opacity: 0 });

        const label = render(renderer.root.findByType('ExpoMenu' as any).props.label);
        expect(label.root.findByType('ExpoText' as any).props.children).toBe('Opus');
        // The chip is the label itself now, so it must not be hidden.
        expect(renderer.root.findByType('ExpoMenu' as any).props.label.props.modifiers)
            .not.toContainEqual({ type: 'opacity', value: 0.01 });
    });

    it('keeps the trigger invisible when it stands over a React Native chip', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Model',
            groups: [{
                key: 'model',
                label: 'Opus',
                options: [{ key: 'opus', label: 'Opus' }],
                selectedKey: 'opus',
                onSelect: vi.fn(),
            }],
            children: React.createElement('Trigger'),
        }));

        const trigger = renderer.root.findAllByType('View' as any).find((view: any) => view.props.pointerEvents === 'none');
        expect(trigger?.props.style).not.toContainEqual({ opacity: 0 });
        expectInvisibleTrigger(renderer.root.findByType('ExpoMenu' as any).props.label);
    });
});
