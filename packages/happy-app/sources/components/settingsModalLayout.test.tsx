import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    back: vi.fn(),
    canDismiss: true,
    canGoBack: true,
    dismiss: vi.fn(),
    dismissTo: vi.fn(),
    isTablet: true,
    replace: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            header: { background: '#fff', tint: '#111' },
            shadow: { color: '#000', opacity: 0.2 },
            surface: '#fff',
            surfacePressed: '#eee',
        },
    };
    return {
        StyleSheet: {
            absoluteFill: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/navigation/Header', () => ({ Header: 'Header', createHeader: vi.fn() }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => mocks.isTablet }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('expo-router', async () => {
    const ReactModule = await import('react');
    const Stack = (props: any) => ReactModule.createElement('Stack', props, props.children);
    Stack.Screen = (props: any) => ReactModule.createElement('StackScreen', props);
    return {
        Stack,
        useNavigation: () => ({}),
        useRouter: () => ({
            back: mocks.back,
            canDismiss: () => mocks.canDismiss,
            canGoBack: () => mocks.canGoBack,
            dismiss: mocks.dismiss,
            dismissTo: mocks.dismissTo,
            replace: mocks.replace,
        }),
    };
});

import SettingsLayout from '@/app/(app)/settings/_layout';

describe('SettingsLayout', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.canDismiss = true;
        mocks.canGoBack = true;
        mocks.isTablet = true;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer?.unmount());
        }
        renderer = undefined;
        vi.unstubAllGlobals();
    });

    it('renders the settings stack as a named desktop dialog and dismisses from the backdrop', () => {
        act(() => {
            renderer = TestRenderer.create(<SettingsLayout />);
        });

        const panel = renderer!.root.findByProps({ testID: 'settings-modal-panel' });
        expect(panel.props.accessibilityViewIsModal).toBe(true);
        expect(panel.props['aria-modal']).toBe(true);
        expect(panel.props.role).toBe('dialog');

        act(() => renderer!.root.findByProps({ testID: 'settings-modal-backdrop' }).props.onPress());
        expect(mocks.dismissTo).toHaveBeenCalledWith('/');
        expect(mocks.dismiss).not.toHaveBeenCalled();
        expect(mocks.back).not.toHaveBeenCalled();
    });

    it('closes the complete desktop modal when Escape is pressed', () => {
        act(() => {
            renderer = TestRenderer.create(<SettingsLayout />);
        });
        const preventDefault = vi.fn();

        act(() => renderer!.root.findByProps({ testID: 'settings-modal-root' }).props.onKeyDown({
            nativeEvent: { key: 'Escape' },
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(mocks.dismissTo).toHaveBeenCalledWith('/');
    });

    it('keeps narrow web settings in the normal full-screen stack', () => {
        mocks.isTablet = false;

        act(() => {
            renderer = TestRenderer.create(<SettingsLayout />);
        });

        expect(renderer!.root.findAllByProps({ testID: 'settings-modal-root' })).toHaveLength(0);
        expect(renderer!.root.findByType('Stack').props.initialRouteName).toBe('index');
    });

});
