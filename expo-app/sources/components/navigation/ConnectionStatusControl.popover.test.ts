import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastPopoverProps: any = null;

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                status: {
                    connected: '#00ff00',
                    connecting: '#ffcc00',
                    disconnected: '#ff0000',
                    error: '#ff0000',
                    default: '#999999',
                },
                text: '#111111',
                textSecondary: '#666666',
            },
        },
    }),
    StyleSheet: {
        create: (fn: any) =>
            fn(
                {
                    colors: {
                        status: {
                            connected: '#00ff00',
                            connecting: '#ffcc00',
                            disconnected: '#ff0000',
                            error: '#ff0000',
                            default: '#999999',
                        },
                        text: '#111111',
                        textSecondary: '#666666',
                    },
                },
                {},
            ),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
}));

vi.mock('@/components/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        lastPopoverProps = props;
        return null;
    },
}));

vi.mock('@/sync/storage', () => ({
    useSocketStatus: () => ({ status: 'connected' }),
    useSyncError: () => null,
    useLastSyncAt: () => null,
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'http://localhost:3000',
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { retryNow: vi.fn() },
}));

describe('ConnectionStatusControl (native popover config)', () => {
    it('enables a native portal so the menu is not width-constrained to the trigger', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        lastPopoverProps = null;

        act(() => {
            renderer.create(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        });

        expect(lastPopoverProps).toBeTruthy();
        expect(lastPopoverProps.portal?.web).toBe(true);
        expect(lastPopoverProps.portal?.native).toBe(true);
        expect(lastPopoverProps.portal?.matchAnchorWidth).toBe(false);
    });
});
