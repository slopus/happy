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

    it('opens settings and activity with a desktop modal boundary', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopSettingsModalProvider><ControllerProbe /></DesktopSettingsModalProvider>,
            );
        });
        act(() => controller?.openSettings());
        expect(mocks.routerPush).toHaveBeenCalledWith({ pathname: '/settings', params: { desktopModal: '1' } });
        act(() => controller?.openActivity());
        expect(mocks.routerPush).toHaveBeenCalledWith({ pathname: '/inbox', params: { desktopModal: '1' } });
    });

    it('opens an arbitrary destination inside the desktop modal and preserves route params', () => {
        act(() => {
            renderer = TestRenderer.create(
                <DesktopSettingsModalProvider><ControllerProbe /></DesktopSettingsModalProvider>,
            );
        });

        act(() => controller?.openRoute('/session/abc/files', { focus: 'search' }));

        expect(mocks.routerPush).toHaveBeenCalledWith({
            pathname: '/session/abc/files',
            params: { focus: 'search', desktopModal: '1' },
        });
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

        act(() => controller?.openRoute('/session/recent'));
        expect(mocks.routerPush).toHaveBeenCalledWith('/session/recent');

        act(() => controller?.openRoute('/session/abc/files', { focus: 'search' }));
        expect(mocks.routerPush).toHaveBeenCalledWith({
            pathname: '/session/abc/files',
            params: { focus: 'search' },
        });
        expect(renderer!.root.findAllByProps({ testID: 'settings-modal-panel' })).toHaveLength(0);
    });
});
