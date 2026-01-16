import { describe, it, expect, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import React from 'react';
import type { ProfileDocumentation } from '@/sync/profileUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
    },
}));

const useEnvironmentVariablesMock = vi.fn((_machineId: any, _refs: any) => ({
    variables: {},
    isLoading: false,
}));

vi.mock('@/hooks/useEnvironmentVariables', () => ({
    useEnvironmentVariables: (machineId: any, refs: any) => useEnvironmentVariablesMock(machineId, refs),
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
            colors: {
                groupped: { sectionTitle: '#000' },
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                surface: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
            },
        },
    }),
    StyleSheet: {
        create: (factory: (theme: any) => any) => factory({
            colors: {
                groupped: { sectionTitle: '#000' },
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                surface: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
            },
        }),
    },
}));

vi.mock('@/components/Item', () => {
    const React = require('react');
    return {
        Item: (props: unknown) => React.createElement('Item', props),
    };
});

vi.mock('./EnvironmentVariableCard', () => {
    const React = require('react');
    return {
        EnvironmentVariableCard: (props: unknown) => React.createElement('EnvironmentVariableCard', props),
    };
});

import { EnvironmentVariablesList } from './EnvironmentVariablesList';

describe('EnvironmentVariablesList', () => {
    beforeEach(() => {
        useEnvironmentVariablesMock.mockClear();
    });

    it('does not query machine env for documented secret refs', () => {
        const profileDocs: ProfileDocumentation = {
            description: 'test',
            environmentVariables: [
                {
                    name: 'MAGIC',
                    expectedValue: '***',
                    description: 'secret but name is not secret-like',
                    isSecret: true,
                },
            ],
            shellConfigExample: '',
        };

        act(() => {
            renderer.create(
                React.createElement(EnvironmentVariablesList, {
                    environmentVariables: [
                        { name: 'FOO', value: '${MAGIC}' },
                        { name: 'BAR', value: '${HOME}' },
                    ],
                    machineId: 'machine-1',
                    profileDocs,
                    onChange: () => {},
                }),
            );
        });

        expect(useEnvironmentVariablesMock).toHaveBeenCalledTimes(1);
        const [_machineId, refs] = useEnvironmentVariablesMock.mock.calls[0] as unknown as [string, string[]];
        expect(refs).toContain('HOME');
        expect(refs).not.toContain('MAGIC');
    });
});
