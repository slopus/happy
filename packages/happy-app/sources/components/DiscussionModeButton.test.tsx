import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    os: 'web',
    // The existing ginghamDark palette makes stray default-theme colors visible.
    colors: { surfaceSelected: '#283544', surfacePressed: '#1F2A38', textLink: '#8FC2E0', textSecondary: '#8FA2B0' },
}));
vi.mock('react-native', () => ({
    Platform: { get OS() { return mocks.os; }, select: (values: any) => values[mocks.os] ?? values.default },
    Pressable: 'Pressable',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./DesktopShortcutTooltip', () => ({ ComposerTooltip: 'ComposerTooltip' }));
vi.mock('@/text', () => ({ t: (key: string) => key === 'discussionMode.label' ? '仅讨论' : '切换讨论模式' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({ theme: { colors: mocks.colors } }),
}));

import { DiscussionModeButton } from './DiscussionModeButton';

describe('DiscussionModeButton', () => {
    let renderer: any;
    const toggle = vi.fn();
    const button = () => renderer.root.findByType('Pressable');
    const tooltip = () => renderer.root.findByType('ComposerTooltip');
    const style = (pressed = false) => Object.assign({}, ...button().props.style({ pressed }).filter(Boolean));
    const mount = (active = false, disabled = false) => act(() => {
        renderer = TestRenderer.create(<DiscussionModeButton active={active} disabled={disabled} onToggle={toggle} />);
    });
    beforeEach(() => { vi.clearAllMocks(); mocks.os = 'web'; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); });

    it('renders one icon without a visible label or checkmark and exposes the toggle state', () => {
        mount(true);
        expect(renderer.root.findAllByType('Ionicons')).toHaveLength(1);
        expect(renderer.root.findByType('Ionicons').props.name).toBe('chatbubbles-outline');
        expect(button().props.children.filter(Boolean)).toHaveLength(2); // icon and conditional tooltip, no text node
        expect(button().props['aria-pressed']).toBe(true);
        expect(button().props.accessibilityState).toEqual({ checked: true, disabled: false });
        expect(tooltip().props).toMatchObject({ label: '仅讨论', visible: false });
        act(() => button().props.onPress());
        expect(toggle).toHaveBeenCalledOnce();
    });
    it('uses the active dark theme for selection, hover, press and focus', () => {
        mount(false);
        expect(style()).toMatchObject({ backgroundColor: 'transparent', cursor: 'pointer' });
        act(() => button().props.onHoverIn());
        expect(style().backgroundColor).toBe(mocks.colors.surfacePressed);
        act(() => button().props.onHoverOut());
        expect(style(true).backgroundColor).toBe(mocks.colors.surfacePressed);
        act(() => button().props.onFocus());
        expect(style().borderColor).toBe(mocks.colors.textLink);
        act(() => renderer.update(<DiscussionModeButton active onToggle={toggle} />));
        act(() => button().props.onHoverIn());
        expect(style(true).backgroundColor).toBe(mocks.colors.surfaceSelected);
        expect(renderer.root.findByType('Ionicons').props.color).toBe(mocks.colors.textLink);
    });
    it('shows only the short tooltip on hover or focus and hides it when leaving', () => {
        mount();
        act(() => button().props.onHoverIn());
        expect(tooltip().props).toMatchObject({ visible: true, label: '仅讨论' });
        act(() => button().props.onHoverOut());
        expect(tooltip().props.visible).toBe(false);
        act(() => button().props.onFocus());
        expect(tooltip().props.visible).toBe(true);
        act(() => button().props.onBlur());
        expect(tooltip().props.visible).toBe(false);
    });
    it('retains the disabled boundary and removes interactive hover feedback during execution', () => {
        mount(true, true);
        act(() => button().props.onHoverIn());
        expect(button().props.disabled).toBe(true);
        expect(style()).toMatchObject({ cursor: 'auto', opacity: 0.5 });
        expect(tooltip().props.visible).toBe(false);
    });
    it('uses the native icon size without exposing a desktop tooltip or cursor', () => {
        mocks.os = 'android';
        mount();
        act(() => button().props.onFocus());
        expect(style()).not.toHaveProperty('cursor');
        expect(renderer.root.findByType('Ionicons').props.size).toBe(18);
        expect(button().props.accessibilityRole).toBe('switch');
        expect(button().props.accessibilityState.checked).toBe(false);
        expect(tooltip().props.visible).toBe(false);
    });
});
