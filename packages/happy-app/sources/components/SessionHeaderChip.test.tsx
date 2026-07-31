import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHeaderChip } from './SessionHeaderChip';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            surface: '#fff',
            text: '#111',
            textSecondary: '#666',
            status: { connected: '#0a0', disconnected: '#a00' },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});

describe('SessionHeaderChip connection semantics', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it.each([
        { online: true, status: 'status.online' },
        { online: false, status: 'status.offline' },
    ])('renders and announces $status instead of relying on dot color', ({ online, status }) => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionHeaderChip
                    agentLabel="codex"
                    machineName="Mac mini"
                    online={online}
                    open={false}
                    onPress={vi.fn()}
                />,
            );
        });

        const chip = renderer.root.findByProps({ testID: 'session-header-chip' });
        expect(chip.props.accessibilityRole).toBe('button');
        expect(chip.props.accessibilityState).toEqual({ expanded: false });
        expect(chip.props.accessibilityLabel).toBe(`codex, ${status}, Mac mini`);
        expect(chip.findAllByType('Text').some((node: any) => node.props.children === status)).toBe(true);

        act(() => renderer.unmount());
    });
});
