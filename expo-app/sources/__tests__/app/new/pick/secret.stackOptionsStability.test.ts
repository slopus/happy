import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => React.useState<any[]>([]),
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: ({ onChangeSecrets }: any) => {
        const didTriggerRef = React.useRef(false);
        React.useEffect(() => {
            if (didTriggerRef.current) return;
            didTriggerRef.current = true;
            onChangeSecrets?.([]);
        }, [onChangeSecrets]);
        return null;
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' } } } }),
}));

describe('SecretPickerScreen (Stack.Screen options stability)', () => {
    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const routerApi = { back: vi.fn(), setParams: vi.fn() };
        const navigationApi = { goBack: vi.fn() };
        const setOptions = vi.fn();

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: any) => {
                    React.useEffect(() => {
                        setOptions(options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => routerApi,
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => ({ selectedId: '' }),
        }));

        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await act(async () => {
            renderer.create(React.createElement(SecretPickerScreen));
        });

        expect(setOptions).toHaveBeenCalledTimes(1);
    });
});
