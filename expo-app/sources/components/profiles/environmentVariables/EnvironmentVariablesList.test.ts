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

const useEnvironmentVariablesMock = vi.fn((_machineId: any, _refs: any, _options?: any) => ({
    variables: {},
    meta: {},
    policy: null as any,
    isPreviewEnvSupported: false,
    isLoading: false,
}));

vi.mock('@/hooks/useEnvironmentVariables', () => ({
    useEnvironmentVariables: (machineId: any, refs: any, options?: any) => useEnvironmentVariablesMock(machineId, refs, options),
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

vi.mock('@/components/ui/lists/Item', () => {
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

    it('adds a variable via the inline expander', () => {
        const onChange = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariablesList, {
                    environmentVariables: [],
                    machineId: 'machine-1',
                    profileDocs: null,
                    onChange,
                    sourceRequirementsByName: {},
                    onUpdateSourceRequirement: () => {},
                    getDefaultSecretNameForSourceVar: () => null,
                    onPickDefaultSecretForSourceVar: () => {},
                }),
            );
        });

        const addItem = tree!.root
            .findAllByType('Item' as any)
            .find((n: any) => n.props.title === 'profiles.environmentVariables.addVariable');
        expect(addItem).toBeTruthy();

        act(() => {
            addItem!.props.onPress();
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        expect(inputs.length).toBeGreaterThanOrEqual(2);

        act(() => {
            inputs[0]!.props.onChangeText('FOO');
            inputs[1]!.props.onChangeText('bar');
        });

        const saveButton = tree!.root
            .findAllByType('Pressable' as any)
            .find((n: any) => n.props.accessibilityLabel === 'common.save');
        expect(saveButton).toBeTruthy();

        act(() => {
            saveButton!.props.onPress();
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]?.[0]).toEqual([{ name: 'FOO', value: 'bar' }]);
    });

    it('marks documented secret refs as sensitive keys (daemon-controlled disclosure)', () => {
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
                    sourceRequirementsByName: {},
                    onUpdateSourceRequirement: () => {},
                    getDefaultSecretNameForSourceVar: () => null,
                    onPickDefaultSecretForSourceVar: () => {},
                }),
            );
        });

        expect(useEnvironmentVariablesMock).toHaveBeenCalled();
        const [_machineId, keys, options] = useEnvironmentVariablesMock.mock.calls[0] as unknown as [string, string[], any];
        expect(keys).toContain('FOO');
        expect(keys).toContain('BAR');
        expect(keys).toContain('MAGIC');
        expect(keys).toContain('HOME');
        expect(Array.isArray(options?.sensitiveKeys) ? options.sensitiveKeys : []).toContain('MAGIC');
    });

    it('treats a documented-secret variable name as secret even when its value references another var', () => {
        const profileDocs: ProfileDocumentation = {
            description: 'test',
            environmentVariables: [
                {
                    name: 'MAGIC',
                    expectedValue: '***',
                    description: 'secret',
                    isSecret: true,
                },
            ],
            shellConfigExample: '',
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariablesList, {
                    environmentVariables: [{ name: 'MAGIC', value: '${HOME}' }],
                    machineId: 'machine-1',
                    profileDocs,
                    onChange: () => {},
                    sourceRequirementsByName: {},
                    onUpdateSourceRequirement: () => {},
                    getDefaultSecretNameForSourceVar: () => null,
                    onPickDefaultSecretForSourceVar: () => {},
                }),
            );
        });

        expect(useEnvironmentVariablesMock).toHaveBeenCalled();
        const [_machineId, keys, options] = useEnvironmentVariablesMock.mock.calls[0] as unknown as [string, string[], any];
        expect(keys).toContain('MAGIC');
        expect(keys).toContain('HOME');
        expect(Array.isArray(options?.sensitiveKeys) ? options.sensitiveKeys : []).toContain('MAGIC');
        expect(Array.isArray(options?.sensitiveKeys) ? options.sensitiveKeys : []).toContain('HOME');

        const cards = tree?.root.findAllByType('EnvironmentVariableCard' as any);
        expect(cards?.length).toBe(1);
        expect(cards?.[0]?.props.isSecret).toBe(true);
        expect(cards?.[0]?.props.expectedValue).toBe('***');
    });

    it('treats daemon-forced-sensitive vars as secret and marks toggle as forced', () => {
        useEnvironmentVariablesMock.mockReturnValueOnce({
            variables: {},
            meta: {
                AUTH_MODE: {
                    value: null,
                    isSet: true,
                    isSensitive: true,
                    isForcedSensitive: true,
                    sensitivitySource: 'forced',
                    display: 'hidden',
                },
            },
            policy: 'none',
            isPreviewEnvSupported: true,
            isLoading: false,
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(EnvironmentVariablesList, {
                    environmentVariables: [{ name: 'AUTH_MODE', value: 'interactive', isSecret: false }],
                    machineId: 'machine-1',
                    profileDocs: null,
                    onChange: () => {},
                    sourceRequirementsByName: {},
                    onUpdateSourceRequirement: () => {},
                    getDefaultSecretNameForSourceVar: () => null,
                    onPickDefaultSecretForSourceVar: () => {},
                }),
            );
        });

        const cards = tree?.root.findAllByType('EnvironmentVariableCard' as any);
        expect(cards?.length).toBe(1);
        expect(cards?.[0]?.props.isSecret).toBe(true);
        expect(cards?.[0]?.props.isForcedSensitive).toBe(true);
        expect(cards?.[0]?.props.secretOverride).toBe(false);
    });
});
