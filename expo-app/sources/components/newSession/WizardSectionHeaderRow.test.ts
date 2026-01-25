import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { WizardSectionHeaderRow } from './WizardSectionHeaderRow';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('WizardSectionHeaderRow', () => {
    it('renders the optional action immediately after the title', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let tree: ReturnType<typeof renderer.create> | null = null;
        act(() => {
            tree = renderer.create(React.createElement(WizardSectionHeaderRow, {
                iconName: 'desktop-outline',
                title: 'Select Machine',
                action: {
                    accessibilityLabel: 'Refresh machines',
                    iconName: 'refresh-outline',
                    onPress: vi.fn(),
                },
            }));
        });

        const rootView = tree!.root.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children) as any[];

        expect(children.map((c: any) => c.type)).toEqual(['Ionicons', 'Text', 'Pressable']);
        expect(children[1].props.children).toBe('Select Machine');
    });
});
