import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the minimal create/unmount API.
import TestRenderer from 'react-test-renderer';

import TextSelectionScreen from '@/app/(app)/text-selection';

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    params: {} as { textId?: string },
    replace: vi.fn(),
    retrieveTempText: vi.fn(),
    setOptions: vi.fn(),
}));

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => mocks.params,
    useNavigation: () => ({ setOptions: mocks.setOptions }),
    useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('@/sync/persistence', () => ({ retrieveTempText: mocks.retrieveTempText }));
vi.mock('@/components/InvalidRouteState', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: { surface: '#000', text: '#fff' },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#fff' },
                surface: '#000',
                text: '#fff',
            },
        },
    }),
}));

describe('text selection route states', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.params = {};
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('renders the missing-text error immediately without a modal or loading state', () => {
        act(() => {
            renderer = TestRenderer.create(<TextSelectionScreen />);
        });

        const state = renderer.root.findByType('InvalidRouteState');
        expect(state.props.title).toBe('common.error');
        expect(state.props.description).toBe('textSelection.noTextProvided');
        expect(state.props.actionLabel).toBe('common.home');
        expect(mocks.retrieveTempText).not.toHaveBeenCalled();
        expect(mocks.alert).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);

        act(() => state.props.onAction());
        expect(mocks.replace).toHaveBeenCalledWith('/');
    });

    it('renders a not-found state for an expired text id', () => {
        mocks.params = { textId: 'expired' };
        mocks.retrieveTempText.mockReturnValue(null);

        act(() => {
            renderer = TestRenderer.create(<TextSelectionScreen />);
        });

        expect(mocks.retrieveTempText).toHaveBeenCalledWith('expired');
        expect(renderer.root.findByType('InvalidRouteState').props.description).toBe('textSelection.textNotFound');
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('preserves the selectable content view for a valid text id', () => {
        mocks.params = { textId: 'available' };
        mocks.retrieveTempText.mockReturnValue('Selected session output');

        act(() => {
            renderer = TestRenderer.create(<TextSelectionScreen />);
        });

        expect(renderer.root.findAllByType('InvalidRouteState')).toHaveLength(0);
        expect(renderer.root.findByType('TextInput').props.value).toBe('Selected session output');
        expect(mocks.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            headerRight: expect.any(Function),
        }));
    });
});
