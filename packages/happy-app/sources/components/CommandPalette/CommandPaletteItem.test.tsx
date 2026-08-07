import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this focused component test.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 0.5 },
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#6750a4',
                surfaceHigh: '#eee',
                surfaceHighest: '#ddd',
                text: '#111',
                textSecondary: '#666',
                divider: '#ccc',
            },
        },
    }),
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/utils/colorOpacity', () => ({ multiplyColorOpacity: () => '#ddd' }));

import { CommandPaletteItem, splitHighlightedText } from './CommandPaletteItem';

describe('CommandPaletteItem', () => {
    const onPress = vi.fn();
    let renderer: any;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        vi.unstubAllGlobals();
    });

    function flattenStyle(style: any) {
        return Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity).filter(Boolean) : [style]));
    }

    it('renders searchable metadata, highlights every match, and shows its numeric shortcut', () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteItem
                    command={{
                        id: 'session-alpha',
                        title: 'Release plan',
                        subtitle: '~/projects/alpha',
                        metadata: [
                            { icon: 'folder-outline', text: 'alpha' },
                            { icon: 'desktop-outline', text: 'Mac mini' },
                            { icon: 'sparkles-outline', text: 'Release Agent' },
                        ],
                        action: onPress,
                    }}
                    searchQuery="release"
                    quickSelectNumber={3}
                    isSelected
                    onPress={onPress}
                />,
            );
        });

        const item = renderer.root.findByProps({ testID: 'command-palette-item-session-alpha' });
        expect(item.props.nativeID).toBe('command-palette-option-session-alpha');
        expect(item.props.role).toBe('option');
        expect(item.props['aria-selected']).toBe(true);
        expect(item.props.accessibilityLabel).toContain('Mac mini');
        expect(item.props.accessibilityLabel).toContain('Release Agent');
        expect(renderer.root.findAllByProps({ testID: 'command-palette-match' }).map((node: any) => node.props.children))
            .toEqual(['Release', 'Release']);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Alt+3')).toBe(true);
    });

    it('keeps rows, labels, icons, and shortcuts on the desktop density scale', () => {
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteItem
                    command={{
                        id: 'new-session',
                        title: 'New session',
                        subtitle: 'Start a new conversation',
                        icon: 'add-outline',
                        action: onPress,
                    }}
                    quickSelectNumber={1}
                    isSelected
                    onPress={onPress}
                />,
            );
        });

        const item = renderer.root.findByProps({ testID: 'command-palette-item-new-session' });
        expect(flattenStyle(item.props.style({ pressed: false }))).toMatchObject({
            minHeight: 48,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            borderWidth: 1,
        });

        expect(renderer.root.findByType('Ionicons').props.size).toBe(18);
        const labels = renderer.root.findAllByType('Text').filter((node: any) => node.props.numberOfLines === 1);
        expect(flattenStyle(labels[0].props.style)).toMatchObject({ fontSize: 14, lineHeight: 19 });
        expect(flattenStyle(labels[1].props.style)).toMatchObject({ fontSize: 12, lineHeight: 16 });

        const shortcut = renderer.root.findAllByType('Text').find((node: any) => node.props.children === 'Alt+1');
        expect(flattenStyle(shortcut?.props.style)).toMatchObject({ fontSize: 10, lineHeight: 14 });
    });

    it('splits case-insensitive matches without changing the original text', () => {
        expect(splitHighlightedText('Mac mini · MAC studio', 'mac')).toEqual([
            { text: 'Mac', matched: true },
            { text: ' mini · ', matched: false },
            { text: 'MAC', matched: true },
            { text: ' studio', matched: false },
        ]);
    });
});
