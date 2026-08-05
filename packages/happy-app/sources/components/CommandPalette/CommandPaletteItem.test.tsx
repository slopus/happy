import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this focused component test.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: object) => styles },
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
        expect(item.props.accessibilityLabel).toContain('Mac mini');
        expect(item.props.accessibilityLabel).toContain('Release Agent');
        expect(renderer.root.findAllByProps({ testID: 'command-palette-match' }).map((node: any) => node.props.children))
            .toEqual(['Release', 'Release']);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Alt+3')).toBe(true);
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
