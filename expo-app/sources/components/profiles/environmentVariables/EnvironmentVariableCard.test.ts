import { describe, it, expect, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import React from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; ios?: unknown; default?: unknown }) => options.web ?? options.ios ?? options.default,
    },
}));

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: unknown) => React.createElement('Ionicons', props),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            margins: { md: 8 },
            iconSize: { small: 12, large: 16 },
            colors: {
                surface: '#fff',
                groupped: { sectionTitle: '#666', background: '#fff' },
                shadow: { color: '#000', opacity: 0.1 },
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#f00',
                divider: '#ddd',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                deleteAction: '#f00',
                warning: '#f90',
                success: '#0a0',
            },
        },
    }),
    StyleSheet: {
        create: (factory: (theme: any) => any) => factory({
            margins: { md: 8 },
            iconSize: { small: 12, large: 16 },
            colors: {
                surface: '#fff',
                groupped: { sectionTitle: '#666', background: '#fff' },
                shadow: { color: '#000', opacity: 0.1 },
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#f00',
                divider: '#ddd',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                deleteAction: '#f00',
                warning: '#f90',
                success: '#0a0',
            },
        }),
    },
}));

vi.mock('@/components/Switch', () => {
    const React = require('react');
    return {
        Switch: (props: unknown) => React.createElement('Switch', props),
    };
});

vi.mock('@/components/ui/lists/Item', () => {
    const React = require('react');
    return {
        Item: (props: any) => {
            // Render title/subtitle/rightElement so behavior tests can find inputs/switches.
            return React.createElement(
                'Item',
                props,
                props.title ? React.createElement('Text', null, props.title) : null,
                props.subtitle ?? null,
                props.rightElement ?? null,
            );
        },
    };
});

vi.mock('@/components/ui/lists/ItemGroup', () => {
    const React = require('react');
    return {
        ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
    };
});

import { EnvironmentVariableCard } from './EnvironmentVariableCard';

describe('EnvironmentVariableCard', () => {
    it('syncs remote-variable state when variable.value changes externally', () => {
        const onUpdate = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;

        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariableCard, {
                    variable: { name: 'FOO', value: '${BAR:-baz}' },
                    index: 0,
                    machineId: 'machine-1',
                    onUpdate,
                    onDelete: () => {},
                    onDuplicate: () => {},
                }),
            );
        });

        const firstSwitches = tree?.root.findAllByType('Switch' as any) ?? [];
        const firstUseMachineSwitch = firstSwitches.find((s: any) => !s?.props?.disabled);
        expect(firstUseMachineSwitch?.props.value).toBe(true);

        act(() => {
            tree?.update(
                React.createElement(EnvironmentVariableCard, {
                    variable: { name: 'FOO', value: 'literal' },
                    index: 0,
                    machineId: 'machine-1',
                    onUpdate,
                    onDelete: () => {},
                    onDuplicate: () => {},
                }),
            );
        });

        const secondSwitches = tree?.root.findAllByType('Switch' as any) ?? [];
        const secondUseMachineSwitch = secondSwitches.find((s: any) => !s?.props?.disabled);
        expect(secondUseMachineSwitch?.props.value).toBe(false);
    });

    it('adds a fallback operator when user enters a fallback for a template without one', () => {
        const onUpdate = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;

        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariableCard, {
                    variable: { name: 'FOO', value: '${BAR}' },
                    index: 0,
                    machineId: 'machine-1',
                    onUpdate,
                    onDelete: () => {},
                    onDuplicate: () => {},
                }),
            );
        });

        const inputs = tree?.root.findAllByType('TextInput' as any);
        expect(inputs?.length).toBeGreaterThan(0);

        act(() => {
            inputs?.[0]?.props.onChangeText?.('baz');
        });

        expect(onUpdate).toHaveBeenCalled();
        const lastCall = onUpdate.mock.calls.at(-1) as unknown as [number, string];
        expect(lastCall[0]).toBe(0);
        expect(lastCall[1]).toBe('${BAR:-baz}');
    });

    it('removes the operator when user clears the fallback value', () => {
        const onUpdate = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;

        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariableCard, {
                    variable: { name: 'FOO', value: '${BAR:=baz}' },
                    index: 0,
                    machineId: 'machine-1',
                    onUpdate,
                    onDelete: () => {},
                    onDuplicate: () => {},
                }),
            );
        });

        const inputs = tree?.root.findAllByType('TextInput' as any);
        expect(inputs?.length).toBeGreaterThan(0);

        act(() => {
            inputs?.[0]?.props.onChangeText?.('');
        });

        expect(onUpdate).toHaveBeenCalled();
        const lastCall = onUpdate.mock.calls.at(-1) as unknown as [number, string];
        expect(lastCall[0]).toBe(0);
        expect(lastCall[1]).toBe('${BAR}');
    });
});
