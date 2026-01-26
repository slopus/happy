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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' } } } }),
}));

let lastStackScreenOptions: any = null;
vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: any) => {
            lastStackScreenOptions = options;
            return null;
        },
    },
    useRouter: () => ({ back: vi.fn(), setParams: vi.fn() }),
    useNavigation: () => ({ goBack: vi.fn() }),
    useLocalSearchParams: () => ({ selectedId: '' }),
}));

vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: () => null,
}));

describe('SecretPickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        lastStackScreenOptions = null;

        await act(async () => {
            renderer.create(React.createElement(SecretPickerScreen));
        });

        expect(lastStackScreenOptions?.presentation).toBe('containedModal');
        expect(typeof lastStackScreenOptions?.headerLeft).toBe('function');
    });
});
