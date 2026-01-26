import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastFloatingOverlayProps: any = null;

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { surfacePressed: '#eee', surfaceSelected: '#ddd' } },
    }),
}));

vi.mock('@/components/FloatingOverlay', () => {
    const React = require('react');
    return {
        FloatingOverlay: (props: any) => {
            lastFloatingOverlayProps = props;
            return React.createElement('FloatingOverlay', props, props.children);
        },
    };
});

describe('AgentInputAutocomplete', () => {
    beforeEach(() => {
        lastFloatingOverlayProps = null;
    });

    it('returns null when suggestions are empty', async () => {
        const { AgentInputAutocomplete } = await import('./AgentInputAutocomplete');
        let tree: ReturnType<typeof renderer.create> | null = null;
        act(() => {
            tree = renderer.create(
                React.createElement(AgentInputAutocomplete, {
                    suggestions: [],
                    onSelect: () => {},
                    itemHeight: 48,
                }),
            );
        });
        expect(tree).not.toBeNull();
        expect(tree!.toJSON()).toBe(null);
    });

    it('passes maxHeight through to FloatingOverlay', async () => {
        const { AgentInputAutocomplete } = await import('./AgentInputAutocomplete');
        act(() => {
            renderer.create(
                React.createElement(AgentInputAutocomplete, {
                    suggestions: [React.createElement('Suggestion', { key: 's1' })],
                    onSelect: () => {},
                    itemHeight: 48,
                    maxHeight: 123,
                }),
            );
        });
        expect(lastFloatingOverlayProps?.maxHeight).toBe(123);
    });

    it('calls onSelect with the pressed index', async () => {
        const { AgentInputAutocomplete } = await import('./AgentInputAutocomplete');
        const onSelect = vi.fn();
        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(AgentInputAutocomplete, {
                    suggestions: [
                        React.createElement('Suggestion', { key: 's1' }),
                        React.createElement('Suggestion', { key: 's2' }),
                    ],
                    onSelect,
                    itemHeight: 48,
                }),
            );
        });

        const pressables = tree?.root.findAllByType('Pressable' as any) ?? [];
        expect(pressables.length).toBe(2);
        act(() => {
            pressables[1]?.props?.onPress?.();
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(1);
    });
});
