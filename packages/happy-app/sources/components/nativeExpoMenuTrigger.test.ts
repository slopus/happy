import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
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
        Toggle: component('ExpoToggle'),
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
    it('draws the picker value in SwiftUI and keeps the RN copy for layout alone', () => {
        const onMenuOpen = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            sections: [{ key: 'machine', title: 'Machine', options: [{ key: 'mac', label: 'Mac' }] }],
            selectedKey: 'mac',
            onSelect: vi.fn(),
            onMenuOpen,
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
        expect(container?.props.onStartShouldSetResponderCapture()).toBe(false);
        expect(onMenuOpen).toHaveBeenCalledOnce();
        expect(renderer.root.findByType('ExpoHost' as any).props.style).toEqual({ position: 'absolute', inset: 0 });

        const menu = renderer.root.findByType('ExpoMenu' as any);
        expect(menu.props.modifiers).toContainEqual({ type: 'buttonStyle', value: 'plain' });
        expect(menu.props.label.props.modifiers).toContainEqual({
            type: 'accessibilityLabel',
            value: { label: 'Machine: Mac' },
        });

        const label = render(menu.props.label);
        const value = label.root.findByType('ExpoText' as any);
        expect(value.props.children).toBe('Mac');
        // Half a row is narrow: the value truncates rather than wrapping.
        expect(value.props.modifiers).toContainEqual({ type: 'lineLimit', value: 1 });
        // The value alone is the trigger. The row's icon is a React Native view
        // beside the host, so it stays put while the value morphs into the menu.
        expect(label.root.findAllByType('ExpoImage' as any)).toHaveLength(0);
    });

    // The menu tint, not foregroundColor, is what paints a SwiftUI label. Once
    // the label became the visible chip a fixed white turned every trigger
    // invisible in light mode, so the tint has to track the theme.
    it('paints both native triggers with the theme text color, not a fixed white', () => {
        const picker = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            sections: [{ key: 'machine', options: [{ key: 'mac', label: 'Mac' }] }],
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

    it('lays the project menu out as New bot, then the projects under a heading, then the action', () => {
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Project',
            triggerLabel: 'happy',
            sections: [
                { key: 'bot', options: [{ key: '__new_bot__', label: 'New bot' }] },
                { key: 'projects', title: 'Projects', options: [{ key: '~/happy', label: 'happy' }] },
                { key: 'custom', options: [{ key: '__custom__', label: 'Enter custom path…', action: true }] },
            ],
            selectedKey: '~/happy',
            onSelect: vi.fn(),
            children: React.createElement('Trigger'),
        }));

        // One native section per group: the system draws its line between them,
        // the same line the model menu draws between providers.
        const sections = renderer.root.findAllByType('ExpoSection' as any);
        expect(sections).toHaveLength(3);
        expect(sections[0].props.header).toBeUndefined();
        expect(render(sections[1].props.header).root.findByType('ExpoText' as any).props.children).toBe('Projects');
        expect(sections[2].props.header).toBeUndefined();
        // No icon heads the menu and no row carries one.
        expect(renderer.root.findAllByType('ExpoImage' as any)).toHaveLength(0);
        expect(renderer.root.findAllByType('ExpoButton' as any).every((button: any) => button.props.systemImage === undefined)).toBe(true);

        // Choices are the system's checkable rows; the action is a plain button.
        const toggles = renderer.root.findAllByType('ExpoToggle' as any);
        expect(toggles.map((toggle: any) => [toggle.props.label, toggle.props.isOn])).toEqual([
            ['New bot', false],
            ['happy', true],
        ]);
        const buttons = renderer.root.findAllByType('ExpoButton' as any);
        expect(buttons.map((button: any) => button.props.label)).toEqual(['Enter custom path…']);
    });

    it('uses the complete option-row bounds and forwards native selection', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            sections: [{
                key: 'machine',
                title: 'Machine',
                options: [
                    { key: 'mac', label: 'Mac' },
                    { key: 'mini', label: 'Mini' },
                    { key: 'gone', label: 'Gone', disabled: true },
                ],
            }],
            selectedKey: 'mac',
            onSelect,
            children: React.createElement('Trigger'),
        }));

        const menu = renderer.root.findByType('ExpoMenu' as any);
        expectFullTriggerHitArea(menu.props.label, 42);
        expect(renderer.root.findByType('ExpoHost' as any)).toBeDefined();

        // The check is the system's own selection state, not a checkmark image
        // that would take the wide icon column and shift the section's labels.
        const toggles = renderer.root.findAllByType('ExpoToggle' as any);
        expect(toggles.find((toggle: any) => toggle.props.label === 'Mac')?.props.isOn).toBe(true);
        const mini = toggles.find((toggle: any) => toggle.props.label === 'Mini');
        expect(mini.props.isOn).toBe(false);
        expect(toggles.find((toggle: any) => toggle.props.label === 'Gone')?.props.modifiers)
            .toContainEqual({ type: 'disabled', value: { disabled: true } });
        act(() => mini.props.onIsOnChange(true));
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('mini');
    });

    it('re-reads the selection from props after every tap, including a tap on the chosen row', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeOptionsPicker, {
            title: 'Machine',
            triggerLabel: 'Mac',
            sections: [{ key: 'machine', options: [{ key: 'mac', label: 'Mac' }, { key: 'mini', label: 'Mini' }] }],
            selectedKey: 'mac',
            onSelect,
            children: React.createElement('Trigger'),
        }));
        const findMac = () => renderer.root.findAllByType('ExpoToggle' as any).find((toggle: any) => toggle.props.label === 'Mac');
        // The key sits on the Toggle element; the mock renders a host under it.
        const keyOf = (instance: any) => instance.parent._fiber.key as string;
        const before = keyOf(findMac());

        // Tapping the chosen row flips its native state off while nothing in
        // React changes; only a fresh row shows the selection again.
        act(() => findMac().props.onIsOnChange(false));

        expect(onSelect).toHaveBeenCalledWith('mac');
        expect(findMac().props.isOn).toBe(true);
        expect(keyOf(findMac())).not.toBe(before);
    });

    it('renders grouped settings as sections in one native menu with full trigger bounds', () => {
        const onSelect = vi.fn();
        const onMenuOpen = vi.fn();
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
            onMenuOpen,
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
        expect(container?.props.onStartShouldSetResponderCapture()).toBe(false);
        expect(onMenuOpen).toHaveBeenCalledOnce();
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

        // A choice is drawn with the system's own selection state: the small
        // leading check whose column every row and heading shares, rather than
        // a checkmark image in the wide icon column that shifted one section.
        const safeMode = renderer.root.findAllByType('ExpoToggle' as any).find((toggle: any) => toggle.props.label === 'Safe mode');
        expect(safeMode.props.isOn).toBe(true);
        act(() => safeMode.props.onIsOnChange(true));
        expect(onSelect).toHaveBeenCalledWith('safe');

        const locked = renderer.root.findAllByType('ExpoToggle' as any).find((toggle: any) => toggle.props.label === 'Locked');
        expect(locked.props.isOn).toBe(false);
        expect(locked.props.modifiers).toContainEqual({ type: 'disabled', value: { disabled: true } });
    });

    it('keeps action rows as plain buttons with their own icons', () => {
        const onSelect = vi.fn();
        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'appearance',
                label: '',
                title: '',
                options: [{ key: 'open', label: 'Appearance', systemImage: 'paintpalette' }],
                // null: these rows are actions, not a choice.
                selectedKey: null,
                onSelect,
            }],
            children: React.createElement('Trigger'),
        }));

        expect(renderer.root.findAllByType('ExpoToggle' as any)).toHaveLength(0);
        const open = renderer.root.findByType('ExpoButton' as any);
        expect(open.props.systemImage).toBe('paintpalette');
        act(() => open.props.onPress());
        expect(onSelect).toHaveBeenCalledWith('open');
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

    /*
     * "Auto" came out of the composer as "A…" with half the row empty beside
     * it. The chip is sized by the hidden React Native copy underneath, and the
     * SwiftUI label on top was being measured against a smaller budget than
     * that copy reserved, for two reasons at once.
     */
    it('does not charge the spacers that align a label the gap meant for an icon', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Permission',
            groups: [{
                key: 'permission',
                label: 'Auto',
                options: [{ key: 'auto', label: 'Auto' }],
                selectedKey: 'auto',
                onSelect: vi.fn(),
            }],
            triggerLabel: 'Auto',
            triggerAlignment: 'center',
            children: React.createElement('Chip'),
        }));

        // A centred trigger carries a spacer on each side, and a stack charges
        // its spacing between every pair. That took the gap twice out of the
        // label's width for nothing that needed separating.
        const stacks = render(renderer.root.findByType('ExpoMenu' as any).props.label)
            .root.findAllByType('ExpoHStack' as any);
        expect(stacks[0].props.spacing).toBe(0);
        // The gap still exists where it means something: icon to label.
        expect(stacks[1].props.spacing).toBe(7);
    });

    it('measures the label in the same face as the chip that sizes its frame', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            accessibilityLabel: 'Permission',
            groups: [{
                key: 'permission',
                label: 'Auto',
                options: [{ key: 'auto', label: 'Auto' }],
                selectedKey: 'auto',
                onSelect: vi.fn(),
            }],
            triggerLabel: 'Auto',
            children: React.createElement('Chip'),
        }));

        // Left on the system font, SwiftUI measured the word wider than the
        // frame the app's own face had reserved for it, and truncated a chip
        // with room to spare.
        const value = render(renderer.root.findByType('ExpoMenu' as any).props.label)
            .root.findByType('ExpoText' as any);
        expect(value.props.modifiers).toContainEqual({
            type: 'font',
            value: { family: 'IBMPlexSans-Regular', size: 14 },
        });
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
