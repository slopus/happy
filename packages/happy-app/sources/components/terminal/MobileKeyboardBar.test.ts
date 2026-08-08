import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { clipboardRead } = vi.hoisted(() => ({
    clipboardRead: vi.fn(async () => 'pasted text'),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => ({ children, ...props }: Record<string, any>) => (
        ReactModule.createElement(name, props, children)
    );
    return {
        ActivityIndicator: host('ActivityIndicator'),
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: Record<string, unknown>) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('expo-clipboard', () => ({ getStringAsync: clipboardRead }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 20 }) }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                button: { primary: { background: 'primary', tint: 'primary-tint' } },
                divider: 'divider',
                groupped: { background: 'grouped' },
                surfaceHigh: 'surface-high',
                text: 'text',
                textSecondary: 'text-secondary',
            },
        }),
        hairlineWidth: 1,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: 'primary', tint: 'primary-tint' } },
                text: 'text',
                textSecondary: 'text-secondary',
            },
        },
    }),
}));

import { MobileKeyboardBar } from './MobileKeyboardBar';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

describe('MobileKeyboardBar', () => {
    it('keeps a visible takeover action while read-only', () => {
        const onTakeControl = vi.fn();
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(MobileKeyboardBar, {
                visible: true,
                readOnly: true,
                onKey: vi.fn(),
                onTakeControl,
            }));
        });

        const takeover = renderer!.root.findByProps({ accessibilityLabel: 'Take control of terminal' });
        expect(takeover.props.accessibilityState).toEqual({ disabled: false, busy: false });
        act(() => takeover.props.onPress());
        expect(onTakeControl).toHaveBeenCalledTimes(1);
    });

    it('emits accessible control keys and clipboard paste', async () => {
        const onKey = vi.fn();
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(MobileKeyboardBar, {
                visible: true,
                onKey,
            }));
        });

        const controlC = renderer!.root.findByProps({ accessibilityLabel: 'Control C' });
        act(() => controlC.props.onPress());
        expect(onKey).toHaveBeenCalledWith('\x03');

        const paste = renderer!.root.findByProps({ accessibilityLabel: 'Paste from clipboard' });
        await act(async () => paste.props.onPress());
        expect(clipboardRead).toHaveBeenCalledTimes(1);
        expect(onKey).toHaveBeenLastCalledWith('pasted text');
    });
});
