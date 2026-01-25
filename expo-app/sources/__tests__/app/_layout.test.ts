import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let isAuthenticated = true;
let segments: string[] = ['(app)'];

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('@/components/navigation/Header', () => {
    return { createHeader: () => null };
});

vi.mock('@/constants/Typography', () => {
    return { Typography: { default: () => ({}) } };
});

vi.mock('@/text', () => {
    return { t: (key: string) => key };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web', select: (o: any) => o.web ?? o.default },
        TouchableOpacity: (props: any) => React.createElement('TouchableOpacity', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
    };
});

vi.mock('expo-router', () => {
    const React = require('react');
    const Stack: any = (props: any) => React.createElement('Stack', props, props.children);
    Stack.Screen = (props: any) => React.createElement('StackScreen', props, props.children);
    return {
        Stack,
        router: { replace: vi.fn() },
        useSegments: () => {
            React.useMemo(() => 0, [segments.join('|')]);
            return segments;
        },
    };
});

vi.mock('@/auth/AuthContext', () => {
    const React = require('react');
    return {
        useAuth: () => {
            React.useMemo(() => 0, [isAuthenticated]);
            return { isAuthenticated };
        },
    };
});

vi.mock('@/auth/authRouting', () => {
    return {
        isPublicRouteForUnauthenticated: () => false,
    };
});

vi.mock('react-native-unistyles', () => {
    const React = require('react');
    return {
        useUnistyles: () => {
            React.useMemo(() => 0, []);
            return {
                theme: {
                    colors: {
                        surface: '#fff',
                        header: { background: '#fff', tint: '#000' },
                    },
                },
            };
        },
    };
});

vi.mock('@/utils/platform', () => {
    return { isRunningOnMac: () => false };
});

describe('RootLayout hooks order', () => {
    it('does not throw when redirecting after a non-redirect render', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = true;
        segments = ['(app)'];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            act(() => {
                tree = renderer.create(React.createElement(RootLayout));
            });

            isAuthenticated = false;
            segments = ['(app)', 'settings'];

            expect(() => {
                act(() => {
                    tree!.update(React.createElement(RootLayout));
                });
            }).not.toThrow();
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    });
});
