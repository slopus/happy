import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthViewUnsupported } from '@/app/(app)/settings/connect/claude';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    View: 'View',
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('@/components/OAuthView', () => ({ OAuthView: 'OAuthView' }));
vi.mock('@/utils/oauth', () => ({
    buildAuthorizationUrl: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/sync/apiServices', () => ({ connectService: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        absoluteFillObject: {},
        create: (factory: (theme: object) => object) => factory({
            colors: {
                accent: '#ff8a00',
                surface: '#111111',
                text: '#ffffff',
                textDestructive: '#ff0000',
                textSecondary: '#888888',
            },
        }),
    },
}));

describe('Claude connection command copy action', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        mocks.setStringAsync.mockClear();
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
    });

    it('is visible, focusable, and reports temporary copied feedback after activation', async () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <OAuthViewUnsupported name="Claude" command="happy connect claude" />,
            );
        });

        const copyButton = renderer.root.findByProps({ testID: 'claude-connect-copy-button' });
        expect(copyButton.props).toMatchObject({
            accessibilityLabel: 'common.copy',
            accessibilityRole: 'button',
            tabIndex: 0,
        });
        expect(copyButton.findAllByType('Text').map((node: any) => node.props.children))
            .toContain('common.copy');

        await act(async () => copyButton.props.onPress());

        expect(mocks.setStringAsync).toHaveBeenCalledWith('happy connect claude');
        expect(copyButton.props.accessibilityLabel).toBe('common.copied');
        expect(copyButton.findAllByType('Text').map((node: any) => node.props.children))
            .toContain('common.copied');

        act(() => vi.advanceTimersByTime(2_000));
        expect(copyButton.props.accessibilityLabel).toBe('common.copy');

        act(() => renderer.unmount());
    });
});
