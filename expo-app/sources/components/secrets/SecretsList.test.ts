import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                surface: '#fff',
                button: { primary: { background: '#00f', tint: '#fff' }, secondary: { tint: '#00f' } },
                input: { background: '#fff', placeholder: '#999', text: '#000' },
                groupped: { sectionTitle: '#333' },
            },
        },
    }),
    StyleSheet: { create: (x: any) => x },
}));

vi.mock('react-native', () => {
    const React = require('react');
    const Pressable = (props: any) => React.createElement('Pressable', props, props.children);
    const Text = (props: any) => React.createElement('Text', props, props.children);
    const View = (props: any) => React.createElement('View', props, props.children);
    const TextInput = React.forwardRef((props: any, ref: any) => {
        if (ref) {
            ref.current = { focus: () => {} };
        }
        return React.createElement('TextInput', props);
    });
    return {
        Platform: { OS: 'ios', select: (obj: any) => obj.ios ?? obj.default },
        Pressable,
        Text,
        View,
        TextInput,
    };
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() },
}));

describe('SecretsList', () => {
    beforeEach(() => {
        vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
        vi.spyOn(Date, 'now').mockReturnValue(123456);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('adds a secret via the inline expander (no modal)', async () => {
        const onChangeSecrets = vi.fn();
        const onAfterAddSelectId = vi.fn();

        const { SecretsList } = await import('./SecretsList');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SecretsList, {
                    secrets: [],
                    onChangeSecrets,
                    onAfterAddSelectId,
                    allowAdd: true,
                }),
            );
        });

        const addItem = tree!.root.findAllByType('Item' as any).find((n: any) => n.props.title === 'common.add');
        expect(addItem).toBeTruthy();

        await act(async () => {
            addItem!.props.onPress();
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        expect(inputs.length).toBe(2);

        await act(async () => {
            inputs[0]!.props.onChangeText('My Key');
            inputs[1]!.props.onChangeText('sk-test');
        });

        const saveButton = tree!.root.findAllByType('Pressable' as any).find((p: any) => p.props.accessibilityLabel === 'common.save');
        expect(saveButton).toBeTruthy();
        expect(saveButton!.props.disabled).toBe(false);

        await act(async () => {
            saveButton!.props.onPress();
        });

        expect(onChangeSecrets).toHaveBeenCalledTimes(1);
        const nextSecrets = onChangeSecrets.mock.calls[0]![0];
        expect(nextSecrets[0]).toMatchObject({
            id: 'uuid-1',
            name: 'My Key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'sk-test' },
            createdAt: 123456,
            updatedAt: 123456,
        });
        expect(onAfterAddSelectId).toHaveBeenCalledWith('uuid-1');
    });
});

