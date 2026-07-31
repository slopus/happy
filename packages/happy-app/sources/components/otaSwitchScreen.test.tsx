import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the minimal create/unmount API.
import TestRenderer from 'react-test-renderer';

import OtaSwitchScreen from '@/app/(app)/ota-switch';

const mocks = vi.hoisted(() => ({
    applyOtaTarget: vi.fn(),
    back: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    params: {} as { channel?: string; stamp?: string },
    replace: vi.fn(),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => mocks.params,
    useRouter: () => ({
        back: mocks.back,
        replace: mocks.replace,
    }),
}));
vi.mock('@/hooks/useOtaTarget', () => ({ applyOtaTarget: mocks.applyOtaTarget }));
vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.alert,
        confirm: mocks.confirm,
    },
}));
vi.mock('@/components/InvalidRouteState', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: { surface: '#000', text: '#fff', textSecondary: '#aaa' },
            margins: { md: 12, lg: 16, xl: 24 },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: { textSecondary: '#aaa' },
        },
    }),
}));

describe('OTA switch route states', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.params = {};
        mocks.confirm.mockResolvedValue(false);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('renders a recoverable invalid-link state without opening a modal or navigating away', () => {
        act(() => {
            renderer = TestRenderer.create(<OtaSwitchScreen />);
        });

        const state = renderer.root.findByType('InvalidRouteState');
        expect(state.props.title).toBe('terminal.invalidConnectionLink');
        expect(state.props.description).toBe('terminal.invalidConnectionLinkDescription');
        expect(state.props.actionLabel).toBe('devTools.otaVersions');
        expect(mocks.alert).not.toHaveBeenCalled();
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.back).not.toHaveBeenCalled();

        act(() => state.props.onAction());
        expect(mocks.replace).toHaveBeenCalledWith('/dev/ota-versions');
    });

    it('preserves the confirmation flow for a valid preview target', async () => {
        mocks.params = { channel: 'preview', stamp: '1785512794048' };
        mocks.confirm.mockResolvedValue(true);
        mocks.applyOtaTarget.mockResolvedValue(undefined);

        await act(async () => {
            renderer = TestRenderer.create(<OtaSwitchScreen />);
        });

        expect(renderer.root.findAllByType('InvalidRouteState')).toHaveLength(0);
        expect(mocks.confirm).toHaveBeenCalledOnce();
        expect(mocks.confirm.mock.calls[0][1]).toContain('1785512794048');
        expect(mocks.applyOtaTarget).toHaveBeenCalledWith('1785512794048');
        expect(mocks.back).not.toHaveBeenCalled();
    });
});
