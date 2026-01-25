import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    View: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('./ResumeChip', () => ({
    ResumeChip: (props: any) => React.createElement('ResumeChip', props, null),
}));

describe('PathAndResumeRow', () => {
    it('does not let the path chip flex-grow (keeps chips left-aligned)', async () => {
        const { PathAndResumeRow } = await import('./PathAndResumeRow');

        const styles = {
            pathRow: {},
            actionButtonsLeft: {},
            actionChip: {},
            actionChipIconOnly: {},
            actionChipPressed: {},
            actionChipText: {},
        };

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                React.createElement(PathAndResumeRow, {
                    styles,
                    showChipLabels: true,
                    iconColor: '#000',
                    currentPath: '/Users/leeroy/Development/happy-local',
                    onPathClick: () => {},
                    resumeSessionId: null,
                    onResumeClick: () => {},
                    resumeLabelTitle: 'Resume session',
                    resumeLabelOptional: 'Resume: Optional',
                }),
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any) ?? [];
        expect(pressables.length).toBe(1);

        const styleFn = pressables[0]?.props?.style;
        expect(typeof styleFn).toBe('function');

        const computed = styleFn({ pressed: false });
        const arr = Array.isArray(computed) ? computed : [computed];
        const hasFlexGrow1 = arr.some((v: any) => v && typeof v === 'object' && v.flexGrow === 1);
        expect(hasFlexGrow1).toBe(false);
    });
});
