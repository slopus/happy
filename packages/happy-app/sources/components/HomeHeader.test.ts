import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: { OS: 'ios' },
        Pressable: host('Pressable'),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('./navigation/Header', async () => {
    const ReactModule = await import('react');
    return { Header: (props: any) => ReactModule.createElement('Header', props) };
});

vi.mock('@/sync/storage', () => ({
    useSocketStatus: () => ({ status: 'disconnected' }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate: vi.fn(), push: vi.fn() }),
    useSegments: () => [],
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerInfo: () => ({ isCustom: true, hostname: '192.168.0.108', port: 3005 }),
}));

vi.mock('expo-image', async () => {
    const ReactModule = await import('react');
    return { Image: (props: any) => ReactModule.createElement('Image', props) };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function' ? factory({
            colors: {
                groupped: { background: 'background' },
                header: { tint: 'tint' },
                status: {
                    connected: 'connected',
                    connecting: 'connecting',
                    disconnected: 'disconnected',
                    error: 'error',
                    default: 'default',
                },
                surfaceSelected: 'selected',
                textSecondary: 'secondary',
            },
        }) : factory,
        hairlineWidth: 1,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: 'background' },
                header: { tint: 'tint' },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./ShortcutHints', () => ({
    ShortcutHintBadge: () => null,
    useShortcutHints: () => ({ visible: false }),
}));
vi.mock('./StatusDot', () => ({ StatusDot: () => null }));

import { HomeHeaderNotAuth } from './HomeHeader';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

describe('HomeHeaderNotAuth', () => {
    it('uses the standard plain mobile title instead of the glass title pill', () => {
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(HomeHeaderNotAuth));
        });

        const header = renderer!.root.findByType('Header' as any);
        expect(header.props.mobileTitleSurface).toBe('plain');
    });
});
