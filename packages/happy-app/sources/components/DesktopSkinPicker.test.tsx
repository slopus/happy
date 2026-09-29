import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    ImageBackground: 'ImageBackground',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: '#fff', textSecondary: '#aaa', surface: '#222', surfaceHigh: '#292929', surfacePressed: '#333', surfaceSelected: '#444', divider: '#555', accent: '#89b', groupped: { background: '#111' } } };
    return { StyleSheet: { create: (factory: (theme: any) => object) => factory(theme), hairlineWidth: 1 }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { DesktopSkinPicker } from './DesktopSkinPicker';

describe('DesktopSkinPicker', () => {
    it('lets the user choose the photo skin or restore the original appearance', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const onChange = vi.fn();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinPicker value="default" onChange={onChange} />); });
        const standard = renderer.root.findByProps({ testID: 'desktop-skin-default' });
        const dreamskin = renderer.root.findByProps({ testID: 'desktop-skin-dreamskin' });
        const warmNight = renderer.root.findByProps({ testID: 'desktop-skin-warm-night' });
        expect(standard.props.accessibilityState.selected).toBe(true);
        expect(dreamskin.props.accessibilityState.selected).toBe(false);
        expect(standard.props.accessibilityState.checked).toBe(true);
        expect(dreamskin.props.accessibilityState.checked).toBe(false);
        expect(warmNight.props.accessibilityState.checked).toBe(false);
        act(() => dreamskin.props.onPress());
        expect(onChange).toHaveBeenCalledWith('dreamskin');
        act(() => renderer.update(<DesktopSkinPicker value="dreamskin" onChange={onChange} />));
        expect(renderer.root.findByProps({ testID: 'desktop-skin-dreamskin' }).props.accessibilityState.selected).toBe(true);
        expect(renderer.root.findByProps({ testID: 'desktop-skin-dreamskin' }).props.accessibilityState.checked).toBe(true);
        act(() => warmNight.props.onPress());
        expect(onChange).toHaveBeenLastCalledWith('warmNight');
        act(() => renderer.update(<DesktopSkinPicker value="warmNight" onChange={onChange} />));
        expect(renderer.root.findByProps({ testID: 'desktop-skin-warm-night' }).props.accessibilityState.selected).toBe(true);
        for (const [id, slug] of [
            ['wukong', 'wukong'], ['firefly', 'firefly'], ['evaWarm', 'eva-warm'], ['meadowSky', 'meadow-sky'],
        ] as const) {
            const option = renderer.root.findByProps({ testID: `desktop-skin-${slug}` });
            act(() => option.props.onPress());
            expect(onChange).toHaveBeenLastCalledWith(id);
            act(() => renderer.update(<DesktopSkinPicker value={id} onChange={onChange} />));
            expect(renderer.root.findByProps({ testID: `desktop-skin-${slug}` }).props.accessibilityState.selected).toBe(true);
        }
        act(() => renderer.root.findByProps({ testID: 'desktop-skin-default' }).props.onPress());
        expect(onChange).toHaveBeenLastCalledWith('default');
        act(() => renderer.unmount());
    });
});
