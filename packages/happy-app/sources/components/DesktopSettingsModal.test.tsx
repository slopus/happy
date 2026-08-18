import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    isTablet: true,
    routerPush: vi.fn(),
}));

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            header: { background: '#fff', tint: '#111' },
            shadow: { color: '#000' },
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
vi.mock('@/components/SettingsView', () => ({ SettingsView: 'SettingsView' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => mocks.isTablet }));

import {
    DesktopSettingsModalProvider,
    useDesktopSettingsModal,
} from './DesktopSettingsModal';

let controller: ReturnType<typeof useDesktopSettingsModal> | null = null;

function ControllerProbe() {
    controller = useDesktopSettingsModal();
    return null;
}

describe('DesktopSettingsModalProvider', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        mocks.isTablet = true;
        mocks.routerPush.mockReset();
        controller = null;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
    });

    it('opens settings as a desktop component modal without changing routes', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopSettingsModalProvider><ControllerProbe /></DesktopSettingsModalProvider>,
            );
        });

        act(() => controller?.openSettings());
        expect(renderer!.root.findByProps({ testID: 'settings-modal-panel' })).toBeDefined();
        expect(mocks.routerPush).not.toHaveBeenCalled();

        act(() => renderer!.root.findByProps({ testID: 'settings-modal-close' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
        expect(mocks.routerPush).not.toHaveBeenCalled();
    });

    it('keeps route navigation for narrow web', () => {
        mocks.isTablet = false;
        act(() => {
            renderer = TestRenderer.create(
                <DesktopSettingsModalProvider><ControllerProbe /></DesktopSettingsModalProvider>,
            );
        });

        act(() => controller?.openSettings());
        expect(mocks.routerPush).toHaveBeenCalledWith('/settings');
        expect(renderer!.root.findAllByProps({ testID: 'settings-modal-panel' })).toHaveLength(0);
    });
});
